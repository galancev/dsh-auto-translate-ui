/**
 * DOM-smoke стенда: проверяет, что клиентская половина плагина реально доезжает
 * до страницы и исполняется.
 *
 * Два независимых уровня:
 *
 *  1. `--shim` (всегда доступен): исполняет РАЗДАННЫЙ по HTTP клиентский бандл в
 *     `node:vm` с браузероподобной обвязкой (`window.__ModuleLoader__`,
 *     минимальный `document`, заглушка `ctx`). Проверяет обёртку, регистрацию
 *     фабрики, материализацию и вызов `apply()` — без сети и без браузера.
 *     Это не полноценный браузер, но ловит синтаксис, id и падения браузерной
 *     половины ещё до ручного открытия GUI.
 *
 *  2. настоящий headless-браузер (Chrome/Edge, `--dump-dom`): если он доступен,
 *     открывает `/?token=…`, ждёт исполнения модулей и ищет DOM-маркер плагина.
 *     В песочнице DSH-агента Chromium НЕ запускается: он упирается в именованные
 *     каналы (`mojo … Access is denied`) и теряет доступ к своему crashpad
 *     (`OpenProcess: Access is denied`). Такой отказ распознаётся как SKIP (а не
 *     FAIL): он означает ограничение среды, а не дефект плагина. Вне песочницы
 *     (обычный терминал пользователя) тот же код даёт полноценный PASS/FAIL.
 *
 * CLI:
 *   node tools/smoke-dom.mjs --log .verify/logs/server.out.log --plugin dsh-fixture-plugin --shim
 *   node tools/smoke-dom.mjs --origin http://127.0.0.1:51999 --token <t>
 *   node tools/smoke-dom.mjs --origin … --token … --require-browser
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

/** Корень workspace. */
const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Изолированные артефакты стенда. */
const VERIFY_DIR = join(WORKSPACE, ".verify");
const SMOKE_DIR = join(VERIFY_DIR, "smoke");
/** DOM-маркер fixture-плагина (меняется, когда появится настоящий плагин). */
export const FIXTURE_DOM_MARKER = 'data-fixture-plugin="loaded"';
/** Предел работы браузера, мс. */
const BROWSER_TIMEOUT_MS = 60_000;

/**
 * Кандидаты в headless-браузеры: сначала env-переопределение, потом штатные пути.
 * @returns {{ path: string, name: string } | undefined}
 */
export function findBrowser() {
  // Штатные каталоги установки берём из переменных окружения Windows, чтобы
  // скрипт не зависел от конкретной машины.
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    ...(process.env.DSH_SMOKE_BROWSER === undefined ? [] : [{ path: process.env.DSH_SMOKE_BROWSER, name: "DSH_SMOKE_BROWSER" }]),
    { path: join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"), name: "Microsoft Edge" },
    { path: join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"), name: "Microsoft Edge" },
    { path: join(programFiles, "Google", "Chrome", "Application", "chrome.exe"), name: "Google Chrome" },
    { path: join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"), name: "Google Chrome" },
    ...(localAppData === undefined ? [] : [{ path: join(localAppData, "Google", "Chrome", "Application", "chrome.exe"), name: "Google Chrome" }]),
  ];
  return candidates.find((candidate) => candidate.path !== "" && existsSync(candidate.path));
}

/** Признак того, что браузер убит песочницей DSH, а не сломан сам по себе. */
function sandboxBlocked(stderr) {
  return /crashpad|OpenProcess: Access is denied|platform_channel|mojo|Access is denied \(0x5\)/i.test(stderr);
}

/**
 * Один headless-прогон: `--dump-dom` в файл (pipe-stdio под песочницей запрещён).
 * @param {string} browserPath
 * @param {string} pageUrl - URL с launch-токеном.
 * @param {number} [timeoutMs]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
async function runBrowserDump(browserPath, pageUrl, timeoutMs = BROWSER_TIMEOUT_MS) {
  mkdirSync(SMOKE_DIR, { recursive: true });
  const outFile = join(SMOKE_DIR, "dump-dom.html");
  const errFile = join(SMOKE_DIR, "dump-dom.err.log");
  const profileDir = join(SMOKE_DIR, "browser-profile");
  rmSync(outFile, { force: true });
  rmSync(errFile, { force: true });
  mkdirSync(profileDir, { recursive: true });
  const outFd = openSync(outFile, "w");
  const errFd = openSync(errFile, "w");
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-crash-reporter",
    `--user-data-dir=${profileDir}`,
    "--virtual-time-budget=20000",
    "--dump-dom",
    pageUrl,
  ];
  const child = spawn(browserPath, args, { stdio: ["ignore", outFd, errFd] });
  const pid = child.pid ?? -1;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      /* уже завершился */
    }
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
  }, timeoutMs);
  const code = await new Promise((resolvePromise) => {
    child.once("error", () => resolvePromise(null));
    child.once("exit", (exitCode) => resolvePromise(exitCode));
  });
  clearTimeout(timer);
  const stdout = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
  const stderr = existsSync(errFile) ? readFileSync(errFile, "utf8") : "";
  // Профиль браузера — мусор после прогона; DOM и stderr оставляем как улики.
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* Chrome мог ещё держать файлы — не критично, .verify и так изолирован */
  }
  return { code, stdout, stderr, timedOut };
}

/**
 * VM-шим: исполнить разданный клиентский бандл в браузероподобном окружении.
 * @param {{ moduleText: string, moduleUrl: string, pluginId: string, expectAttr?: { name: string, value: string } }} options
 * @returns {Promise<{ ok: boolean, evidence: string }>}
 */
export async function runModuleShim({ moduleText, moduleUrl, pluginId, expectAttr }) {
  const registrations = [];
  const attributes = new Map();
  const documentElement = {
    setAttribute(name, value) {
      attributes.set(String(name), String(value));
    },
    getAttribute(name) {
      return attributes.get(String(name));
    },
  };
  const windowObject = {
    __ModuleLoader__: {
      mode: "queue",
      pendingQueue: [],
      load(registration) {
        registrations.push(registration);
      },
    },
  };
  const sandbox = {
    window: windowObject,
    document: { documentElement },
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(moduleText, sandbox, { filename: moduleUrl, timeout: 10_000 });

  if (registrations.length !== 1) {
    throw new Error(`шим: ожидали одно registration, получили ${registrations.length}`);
  }
  const registration = registrations[0];
  if (registration.id !== pluginId) {
    throw new Error(`шим: registration.id=${JSON.stringify(registration.id)}, ожидали ${JSON.stringify(pluginId)}`);
  }
  if (typeof registration.factory !== "function") throw new Error("шим: registration.factory не функция");

  const materialized = registration.factory((specifier) => {
    throw new Error(`шим: клиентский модуль потребовал внешний модуль ${JSON.stringify(specifier)} — он обязан быть в таблице платформы`);
  });
  if (materialized === null || typeof materialized !== "object") {
    throw new Error("шим: factory вернула не объект exports");
  }
  let applied = false;
  if (typeof materialized.apply === "function") {
    await materialized.apply({
      logger: { info() {}, warn() {}, error() {} },
      effect() {},
      on() {},
      get() {
        return undefined;
      },
      inject() {},
    });
    applied = true;
  }
  if (expectAttr !== undefined) {
    const actual = attributes.get(expectAttr.name);
    if (actual !== expectAttr.value) {
      throw new Error(`шим: документ не помечен ${expectAttr.name}=${expectAttr.value} (получено ${String(actual)})`);
    }
  }
  return {
    ok: true,
    evidence: `id ${pluginId}; фабрика материализована; apply() ${applied ? "вызван" : "отсутствует (допустимо)"}${
      expectAttr === undefined ? "" : `; документ помечен ${expectAttr.name}=${expectAttr.value}`
    }`,
  };
}

/**
 * Полный smoke: VM-шим + (если доступен) настоящий headless-браузер.
 * @param {{
 *   origin: string, token: string, moduleText?: string, moduleUrl?: string,
 *   pluginId?: string, domMarker?: string,
 *   shim?: boolean, expectAttr?: { name: string, value: string }
 * }} options
 *   `shim: false` отключает VM-шим (реальный бандл требует внешних модулей);
 *   `expectAttr` задаёт DOM-атрибут, которым fixture помечает документ.
 * @returns {Promise<{ ok: boolean, skipped: boolean, evidence: string }>}
 */
export async function runSmoke(options) {
  const pluginId = options.pluginId ?? "dsh-fixture-plugin";
  const marker = options.domMarker ?? FIXTURE_DOM_MARKER;
  const details = [];
  /** null — шим отключён; true/false — его вердикт. */
  let shimOk = options.shim === false ? null : true;

  // 1. VM-шим — единственная часть, которая гарантированно работает в песочнице.
  if (options.shim === false) {
    details.push("шим: отключён (проверяется не fixture-бандл)");
  } else if (options.moduleText === undefined) {
    shimOk = false;
    details.push("шим: пропущен (модуль не был получен по HTTP)");
  } else {
    try {
      const shim = await runModuleShim({
        moduleText: options.moduleText,
        moduleUrl: options.moduleUrl ?? `plugins/${pluginId}/client.js`,
        pluginId,
        expectAttr: options.expectAttr ?? { name: "data-fixture-plugin", value: "loaded" },
      });
      details.push(`шим: PASS (${shim.evidence})`);
    } catch (error) {
      shimOk = false;
      details.push(`шим: FAIL (${String(error)})`);
    }
  }
  // Сломанный бандл не «спасает» даже удачный браузерный прогон: это дефект плагина.
  if (shimOk === false) return { ok: false, skipped: false, evidence: details.join("; ") };

  // 2. Настоящий headless-браузер.
  const browser = findBrowser();
  if (browser === undefined) {
    details.push("браузер: не найден (ни Edge, ни Chrome) — DOM-уровень не проверен");
    return { ok: true, skipped: true, evidence: details.join("; ") };
  }
  const pageUrl = `${options.origin}/?token=${encodeURIComponent(options.token)}`;
  const dump = await runBrowserDump(browser.path, pageUrl);
  if (dump.timedOut) {
    details.push(`браузер ${browser.name}: FAIL — таймаут ${BROWSER_TIMEOUT_MS} мс`);
    return { ok: false, skipped: false, evidence: details.join("; ") };
  }
  if (dump.code !== 0 || dump.stdout.length === 0) {
    if (sandboxBlocked(dump.stderr)) {
      details.push(
        `браузер ${browser.name}: SKIP — не запускается в песочнице DSH (named pipes/OpenProcess): ${
          dump.stderr.trim().split(/\r?\n/).slice(0, 2).join(" | ") || `exit ${String(dump.code)}`
        }`,
      );
      return { ok: true, skipped: true, evidence: details.join("; ") };
    }
    details.push(
      `браузер ${browser.name}: FAIL — exit ${String(dump.code)}, DOM ${dump.stdout.length} Б: ${
        dump.stderr.trim().split(/\r?\n/).slice(0, 2).join(" | ") || "пустой вывод"
      }`,
    );
    return { ok: false, skipped: false, evidence: details.join("; ") };
  }
  const hasMarker = dump.stdout.includes(marker);
  const hasBoot = dump.stdout.includes("__DSH_BOOT__");
  if (!hasBoot) {
    details.push(`браузер ${browser.name}: FAIL — страница отдана без boot-graph (вероятно, 401/редирект не прошёл)`);
    return { ok: false, skipped: false, evidence: details.join("; ") };
  }
  if (!hasMarker) {
    details.push(`браузер ${browser.name}: FAIL — DOM ${dump.stdout.length} Б, но нет маркера ${marker}`);
    return { ok: false, skipped: false, evidence: details.join("; ") };
  }
  details.push(`браузер ${browser.name}: PASS — DOM ${dump.stdout.length} Б, найден ${marker}`);
  return { ok: true, skipped: false, evidence: details.join("; ") };
}

// ───────────────────────────── CLI ─────────────────────────────

/** Разобрать argv. */
function parseArgs(argv) {
  const options = { pluginId: "dsh-fixture-plugin", shimOnly: false, requireBrowser: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--origin") options.origin = argv[++i];
    else if (arg === "--token") options.token = argv[++i];
    else if (arg === "--log") options.log = argv[++i];
    else if (arg === "--plugin") options.pluginId = argv[++i];
    else if (arg === "--browser") process.env.DSH_SMOKE_BROWSER = argv[++i];
    else if (arg === "--shim") options.shimOnly = true;
    else if (arg === "--require-browser") options.requireBrowser = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "usage: node tools/smoke-dom.mjs [--origin URL --token T | --log FILE] [--plugin ID] [--shim] [--require-browser] [--browser PATH]\n",
      );
      process.exit(0);
    } else throw new Error(`smoke-dom: неизвестный аргумент ${arg}`);
  }
  if (options.origin === undefined && options.log === undefined) {
    throw new Error("smoke-dom: укажи --origin/--token или --log");
  }
  return options;
}

/** Точка входа CLI: сам достаёт бандл и гоняет шим/браузер. */
async function main(argv) {
  const options = parseArgs(argv);
  const { createProbe, parseLaunchUrl, parseBootGraph, bootEntry } = await import("./probe.mjs");
  if (options.log !== undefined) {
    const parsed = parseLaunchUrl(readFileSync(options.log, "utf8"));
    if (parsed === undefined) throw new Error(`smoke-dom: в ${options.log} нет строки "dsh web: …?token=…"`);
    options.origin = parsed.origin;
    options.token = parsed.token;
  }
  const probe = createProbe({ origin: options.origin, token: options.token });
  const index = await probe.getAuthenticated("/");
  const graph = parseBootGraph(index.text);
  const row = bootEntry(graph, options.pluginId);
  if (row === undefined) throw new Error(`smoke-dom: в boot-graph нет ${options.pluginId}`);
  const moduleUrl = `/${row.url}`;
  const module = await probe.get(moduleUrl, { cookie: probe.browserCookie });
  if (module.status !== 200) throw new Error(`smoke-dom: GET ${moduleUrl} → ${module.status}`);
  process.stdout.write(`модуль: ${moduleUrl} (${module.text.length} Б)\n`);

  if (options.shimOnly) {
    // --shim: только VM-уровень, без запуска браузера.
    const shim = await runModuleShim({
      moduleText: module.text,
      moduleUrl,
      pluginId: options.pluginId,
      expectAttr: { name: "data-fixture-plugin", value: "loaded" },
    });
    process.stdout.write(`[PASS] shim: ${shim.evidence}\n`);
    return 0;
  }
  const result = await runSmoke({
    origin: options.origin,
    token: options.token,
    moduleUrl,
    moduleText: module.text,
    pluginId: options.pluginId,
  });
  const verdict = result.skipped ? "SKIP" : result.ok ? "PASS" : "FAIL";
  process.stdout.write(`[${verdict}] ${result.evidence}\n`);
  if (result.ok) return 0;
  if (result.skipped && !options.requireBrowser) return 0;
  return 1;
}

/** Запущен ли модуль напрямую. */
function isDirectInvocation() {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isDirectInvocation()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
