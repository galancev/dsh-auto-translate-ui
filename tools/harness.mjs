/**
 * Изолированный стенд проверки DSH-плагина.
 *
 * Что делает:
 *  1. поднимает ВТОРОЙ экземпляр `dsh web` на собственном DSH home внутри
 *     `.verify/` и собственном порту (по умолчанию 51999), не трогая GUI
 *     пользователя и его `~/.dsh`;
 *  2. инициализирует профиль из штатного шаблона `web` (если профиля нет);
 *  3. устанавливает локальный fixture-плагин так же, как реальный установщик
 *     (`dsh plugin --profile <p> add link:<dir>`: pnpm + автодобавление в
 *     `dsh.profile.bundles`);
 *  4. дожидается готовности, разбирает launch-токен из stdout и прогоняет
 *     проверки через `tools/probe.mjs`: авторизация, индекс, boot-graph,
 *     раздача клиентского модуля `/plugins/...`, host-маршрут, `/api`/`/connect`;
 *  5. в `--smoke` дополнительно зовёт `tools/smoke-dom.mjs`;
 *  6. гарантированно гасит сервер (finally + kill дерева процессов) и печатает
 *     PASS/FAIL; exit code 0 только если все проверки прошли.
 *
 * Запуск (bundled node или любой Node >= 22):
 *   node tools/harness.mjs
 *   node tools/harness.mjs --port 51999 --only api --smoke
 *
 * STDIO: под песочницей DSH дочерние процессы нельзя запускать с pipe-stdio
 * (EPERM на named pipes), поэтому весь вывод детей пишется в файлы, а не
 * читается через пайпы.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createProbe, parseBootGraph, parseLaunchUrl } from "./probe.mjs";

// ───────────────────────────── пути и константы ─────────────────────────────

/** Корень workspace: tools/harness.mjs → на уровень выше. */
const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Всё изолированное состояние стенда живёт здесь. */
const VERIFY_DIR = join(WORKSPACE, ".verify");
const HOME_DIR = join(VERIFY_DIR, "dsh-home");
const AGENTS_HOME_DIR = join(VERIFY_DIR, "agents-home");
const LOG_DIR = join(VERIFY_DIR, "logs");
const PNPM_STORE_DIR = join(VERIFY_DIR, "pnpm-store");
/** Имя профиля внутри изолированного DSH home. */
const DEFAULT_PROFILE = "verify";
/** Активный профиль этого прогона (--profile); задаётся в main(). */
let activeProfile = DEFAULT_PROFILE;
/** Пакет fixture-плагина. */
const FIXTURE_PACKAGE = "dsh-fixture-plugin";
const FIXTURE_DIR = join(WORKSPACE, "tools", "fixture-plugin");
/** Порт по умолчанию: далеко от пользовательских 50362/3080. */
const DEFAULT_PORT = 51_999;
/** Пределы ожидания (мс). */
const READY_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 180_000;
const KILL_TIMEOUT_MS = 15_000;

// ───────────────────────────── аргументы ─────────────────────────────

/** Разобрать argv стенда. */
function parseArgs(argv) {
  const options = {
    port: Number(process.env.DSH_VERIFY_PORT ?? DEFAULT_PORT),
    smoke: false,
    only: undefined,
    keepServer: false,
    verbose: false,
    forceInstall: false,
    // Изолированный профиль этого прогона (реальный плагин удобно проверять
    // в отдельном профиле, чтобы не ломать fixture-профиль).
    profile: process.env.DSH_VERIFY_PROFILE ?? DEFAULT_PROFILE,
    // Проверяемый плагин: по умолчанию fixture; для реального плагина задай
    // --plugin dsh-auto-translate-ui --plugin-spec link:<путь к репозиторию>.
    pluginName: process.env.DSH_VERIFY_PLUGIN ?? FIXTURE_PACKAGE,
    pluginSpec: process.env.DSH_VERIFY_PLUGIN_SPEC ?? expectedSpec(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--smoke") options.smoke = true;
    else if (arg === "--only") options.only = argv[++i];
    else if (arg === "--keep-server") options.keepServer = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--force-install") options.forceInstall = true;
    else if (arg === "--plugin") options.pluginName = argv[++i];
    else if (arg === "--plugin-spec") options.pluginSpec = argv[++i];
    else if (arg === "--profile") options.profile = argv[++i];
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        [
          "usage: node tools/harness.mjs [options]",
          "  --port N             порт изолированного сервера (по умолчанию 51999)",
          "  --smoke              дополнительно прогнать tools/smoke-dom.mjs",
          "  --only substring     выполнить только проверки, чьё имя содержит подстроку",
          "  --plugin NAME        имя пакета плагина (по умолчанию dsh-fixture-plugin)",
          "  --plugin-spec SPEC   pnpm-спек для установки (по умолчанию link:<tools/fixture-plugin>)",
          "  --profile NAME       изолированный профиль (по умолчанию verify; для реального плагина",
          "                       используй отдельный, напр. verify-plugin)",
          "  --force-install      переустановить плагин, даже если он уже стоит",
          "  --verbose            подробный вывод",
          "  --keep-server        не гасить сервер (только для ручной отладки)",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else throw new Error(`harness: неизвестный аргумент ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65_535) {
    throw new Error(`harness: некорректный порт ${String(options.port)}`);
  }
  if (typeof options.profile !== "string" || !/^[A-Za-z0-9._-]+$/.test(options.profile) || options.profile === "desktop") {
    throw new Error(`harness: некорректное имя профиля ${JSON.stringify(options.profile)} (desktop зарезервирован)`);
  }
  return options;
}

// ───────────────────────────── запуск CLI ─────────────────────────────

/**
 * Путь к Electron-бинарю Desktop (носитель CLI). Никаких путей конкретной
 * машины: сначала env-переопределение, затем штатные каталоги установки из
 * переменных окружения Windows (LOCALAPPDATA / ProgramFiles).
 */
function resolveElectron() {
  const installDirs = [
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness"),
    process.env.ProgramFiles === undefined ? undefined : join(process.env.ProgramFiles, "DeepSeek Harness"),
    process.env["ProgramFiles(x86)"] === undefined ? undefined : join(process.env["ProgramFiles(x86)"], "DeepSeek Harness"),
  ].filter(Boolean);
  const candidates = [
    process.env.DSH_ELECTRON_EXECUTABLE,
    ...installDirs.map((dir) => join(dir, "DeepSeek Harness.exe")),
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error("harness: не найден DeepSeek Harness.exe; задай DSH_ELECTRON_EXECUTABLE");
}

/**
 * Путь к CLI-скрипту внутри app.asar (так же, как в resources/runtime/cli/bin/dsh.cmd).
 * Проверять существование самого скрипта обычным `fs` нельзя: путь лежит внутри
 * asar-архива, который читает только Electron. Проверяем сам архив.
 */
function resolveCliScript(electron) {
  if (process.env.DSH_CLI_SCRIPT !== undefined) return process.env.DSH_CLI_SCRIPT;
  const archive = join(dirname(electron), "resources", "app.asar");
  if (!existsSync(archive)) throw new Error(`harness: нет ${archive}`);
  return join(archive, "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
}

/**
 * Окружение изолированного экземпляра: свой DSH home и свой pnpm store.
 * Никакие пути пользователя (~/.dsh, глобальный pnpm store) не используются.
 */
function isolatedEnv(electron) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    DSH_HOME: HOME_DIR,
    DSH_AGENTS_HOME: AGENTS_HOME_DIR,
    DSH_DESKTOP_NODE_EXECUTABLE: electron,
    DSH_TELEMETRY_DISABLED: "1",
    NPM_CONFIG_STORE_DIR: PNPM_STORE_DIR,
    npm_config_store_dir: PNPM_STORE_DIR,
    NPM_CONFIG_CACHE: join(WORKSPACE, ".npm-cache"),
    npm_config_cache: join(WORKSPACE, ".npm-cache"),
    CI: "1",
  };
}

/**
 * Один запуск CLI с записью вывода в файлы (без pipe-stdio: песочница их запрещает).
 * @param {string} electron
 * @param {string} cliScript
 * @param {string[]} args
 * @param {{ timeoutMs?: number, logFile: string }} options
 * @returns {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string }>}
 */
function runCli(electron, cliScript, args, options) {
  const outFile = options.logFile;
  const errFile = `${options.logFile}.err`;
  rmSync(outFile, { force: true });
  rmSync(errFile, { force: true });
  const outFd = openSync(outFile, "w");
  const errFd = openSync(errFile, "w");
  const child = spawn(electron, ["--expose-internals", cliScript, ...args], {
    env: isolatedEnv(electron),
    stdio: ["ignore", outFd, errFd],
  });
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* уже завершился */
    }
  }, options.timeoutMs ?? INSTALL_TIMEOUT_MS);
  return new Promise((resolvePromise, reject) => {
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({
        code,
        signal,
        stdout: existsSync(outFile) ? readFileSync(outFile, "utf8") : "",
        stderr: existsSync(errFile) ? readFileSync(errFile, "utf8") : "",
      });
    });
  });
}

// ───────────────────────────── профиль и плагин ─────────────────────────────

/** Прочитать манифест изолированного профиля или undefined. */
function readProfileManifest() {
  const file = join(HOME_DIR, "profiles", activeProfile, "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/** Ожидаемый link-спек fixture-плагина по умолчанию. */
function expectedSpec() {
  return `link:${FIXTURE_DIR}`;
}

/**
 * Совпадает ли сохранённая зависимость профиля с ожидаемым спеком стенда.
 * Для link: сравниваем нормализованные пути (pnpm пишет их через `/`),
 * для остальных форм (file:, реестр, git) — точное совпадение строки.
 * @param {string} actual
 * @param {string} wanted
 */
function specMatches(actual, wanted) {
  if (typeof actual !== "string") return false;
  if (wanted.startsWith("link:")) {
    return actual.startsWith("link:") && resolve(actual.slice("link:".length)) === resolve(wanted.slice("link:".length));
  }
  return actual === wanted;
}

/** Установлен ли проверяемый плагин ровно так, как его ставит стенд. */
function pluginInstalled(manifest, options) {
  const dependency = manifest?.dependencies?.[options.pluginName];
  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  return specMatches(dependency, options.pluginSpec) && bundles.includes(options.pluginName);
}

/**
 * Шаг 1: профиль из штатного шаблона `web` (dsh-base + dsh-web-app).
 * `--dump-config` инициализирует профиль и печатает дерево, не поднимая сервер.
 */
async function ensureProfile(electron, cliScript, options) {
  if (readProfileManifest() !== undefined) return;
  log(`инициализация профиля ${activeProfile} из шаблона web…`);
  const result = await runCli(
    electron,
    cliScript,
    ["--profile", activeProfile, "--from-default-profile", "web", "--dump-config"],
    { logFile: join(LOG_DIR, "init-profile.log"), timeoutMs: 120_000 },
  );
  if (result.code !== 0 || readProfileManifest() === undefined) {
    throw new Error(
      `harness: не удалось инициализировать профиль (exit ${String(result.code)})\n${tail(result.stderr || result.stdout)}`,
    );
  }
  if (options.verbose) log(`профиль создан: ${join(HOME_DIR, "profiles", activeProfile)}`);
}

/** Шаг 2: установка плагина реальным установщиком (`dsh plugin … add`). */
async function ensurePluginInstalled(electron, cliScript, options) {
  const manifest = readProfileManifest();
  if (!options.forceInstall && pluginInstalled(manifest, options)) {
    log(`плагин уже установлен: ${options.pluginName} → ${options.pluginSpec}`);
    return;
  }
  log(`установка плагина: dsh plugin --profile ${activeProfile} add ${options.pluginSpec}`);
  const result = await runCli(
    electron,
    cliScript,
    ["plugin", "--profile", activeProfile, "add", options.pluginSpec, `--store-dir=${PNPM_STORE_DIR}`],
    { logFile: join(LOG_DIR, "plugin-add.log"), timeoutMs: INSTALL_TIMEOUT_MS },
  );
  const after = readProfileManifest();
  if (result.code !== 0 || !pluginInstalled(after, options)) {
    throw new Error(
      `harness: установка плагина провалилась (exit ${String(result.code)})\n${tail(result.stdout + result.stderr)}`,
    );
  }
  const installedDir = join(HOME_DIR, "profiles", activeProfile, "node_modules", options.pluginName);
  if (!existsSync(installedDir)) {
    throw new Error(`harness: после pnpm нет ${installedDir}; проверь nodeLinker/link-спек`);
  }
  log(`плагин установлен: ${options.pluginName} → ${options.pluginSpec}`);
}

// ───────────────────────────── сервер ─────────────────────────────

/** Ждать предикат до таймаута. */
async function waitFor(predicate, timeoutMs, intervalMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error(`harness: таймаут ${timeoutMs} мс: ${what}`);
}

/** Свободен ли порт (нет слушателя). */
function portFree(port) {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(900);
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolvePromise(true);
    });
  });
}

/**
 * PID'ы процессов, слушающих порт, по данным `netstat -ano`.
 *
 * `Get-NetTCPConnection` под песочницей может не видеть чужие сокеты, а `netstat`
 * видит; вывод пишем в файл, а не через pipe (pipe-stdio под песочницей запрещён).
 * @param {number} port
 * @returns {Promise<number[] | undefined>} [] — никто не слушает; undefined — проверить не удалось.
 */
async function listeningPids(port) {
  const file = join(LOG_DIR, `netstat-${port}.txt`);
  rmSync(file, { force: true });
  const fd = openSync(file, "w");
  const ran = await new Promise((resolvePromise) => {
    const proc = spawn("netstat", ["-ano", "-p", "tcp"], { stdio: ["ignore", fd, fd], windowsHide: true });
    proc.once("error", () => resolvePromise(false));
    proc.once("exit", () => resolvePromise(true));
  });
  if (!ran || !existsSync(file)) return undefined;
  const pids = new Set();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    if (!(cols[1] ?? "").endsWith(`:${port}`)) continue;
    const listener = Number(cols.at(-1));
    if (Number.isInteger(listener) && listener > 0) pids.add(listener);
  }
  return [...pids];
}

/**
 * Дождаться, пока порт перестанут слушать.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<number[] | undefined>} [] — свободен; список pid — так и слушают; undefined — netstat недоступен.
 */
async function waitListeningGone(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await listeningPids(port);
    if (last === undefined || last.length === 0) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  } while (Date.now() < deadline);
  return last;
}

/** Принудительно завершить процесс/дерево (Windows). Статус taskkill не бросает. */
function forceKillTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* уже завершился */
    }
  }
}

/**
 * Поднять изолированный `dsh web` и дождаться строки с launch-токеном.
 * @returns {Promise<{ origin: string, token: string, url: string, pid: number, stop: () => Promise<void> }>}
 */
async function startServer(electron, cliScript, options) {
  if (!(await portFree(options.port))) {
    const busy = await listeningPids(options.port);
    throw new Error(
      `harness: порт ${options.port} уже занят (pid ${busy?.join(", ") ?? "неизвестен"}) — ` +
        "чужой процесс не трогаю; задай --port другой свободный",
    );
  }
  const outFile = join(LOG_DIR, "server.out.log");
  const errFile = join(LOG_DIR, "server.err.log");
  rmSync(outFile, { force: true });
  rmSync(errFile, { force: true });
  const outFd = openSync(outFile, "w");
  const errFd = openSync(errFile, "w");
  log(`запуск: dsh --profile ${activeProfile} --host 127.0.0.1 --port ${options.port} --no-open`);
  const child = spawn(
    electron,
    [
      "--expose-internals",
      cliScript,
      "--profile",
      activeProfile,
      "--host",
      "127.0.0.1",
      "--port",
      String(options.port),
      "--no-open",
    ],
    { env: isolatedEnv(electron), stdio: ["ignore", outFd, errFd] },
  );
  const pid = child.pid ?? -1;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  /**
   * Погасить сервер и всех его потомков и ДОКАЗАТЬ, что порт освобождён.
   *
   * Одного `child.kill()` недостаточно: Electron-носитель может оставить потомка,
   * унаследовавшего слушающий сокет, а `taskkill` под песочницей иногда отвечает
   * `Access denied`. Поэтому после убийства дерева проверяем `netstat` и добиваем
   * оставшихся слушателей НАШЕГО порта; если порт всё ещё занят — громкий FAIL,
   * а не тихая утечка процесса.
   */
  let stopPromise;
  function stop() {
    stopPromise ??= (async () => {
      // Дерево надёжнее убивать, пока корневой pid ещё жив.
      if (!exited) forceKillTree(pid);
      try {
        child.kill("SIGKILL");
      } catch {
        /* уже завершился */
      }
      const deadline = Date.now() + KILL_TIMEOUT_MS;
      while (!exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      if (!exited) throw new Error(`harness: сервер pid ${pid} не завершился за ${KILL_TIMEOUT_MS} мс`);

      // Проверяем фактическое освобождение порта (exit родителя ≠ закрытый сокет).
      const stillListening = await waitListeningGone(options.port, 10_000);
      if (stillListening === undefined || stillListening.length === 0) return;
      for (const orphan of stillListening) forceKillTree(orphan);
      const afterKill = await waitListeningGone(options.port, 5_000);
      if (afterKill !== undefined && afterKill.length > 0) {
        throw new Error(
          `harness: порт ${options.port} всё ещё слушают pid ${afterKill.join(", ")} — ` +
            `заверши их вручную (taskkill /PID <pid> /T /F) перед следующим прогоном`,
        );
      }
    })();
    return stopPromise;
  }

  try {
    await waitFor(
      () => exited || (existsSync(outFile) && /dsh web:\s+\S+/.test(readFileSync(outFile, "utf8"))),
      READY_TIMEOUT_MS,
      250,
      "сервер не напечатал URL с launch-токеном",
    );
    if (exited) {
      throw new Error(`harness: сервер завершился при старте\n${tail(readFileSync(errFile, "utf8"))}`);
    }
    const launch = parseLaunchUrl(readFileSync(outFile, "utf8"));
    if (launch === undefined) throw new Error("harness: не удалось разобрать launch-токен из stdout сервера");
    // Ждём, пока HTTP-слой реально начнёт отвечать (индекс без cookie = 401).
    await waitFor(
      async () => {
        try {
          const response = await fetch(`${launch.origin}/`, { signal: AbortSignal.timeout(2000) });
          return response.status === 401 || response.status === 200;
        } catch {
          return false;
        }
      },
      30_000,
      250,
      "HTTP-слой сервера не отвечает",
    );
    log(`сервер готов: ${launch.origin} (pid ${pid})`);
    return { ...launch, pid, stop, outFile, errFile };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

// ───────────────────────────── проверки ─────────────────────────────

/** Хвост диагностики для сообщений об ошибках. */
function tail(text, lines = 12) {
  const split = String(text).trimEnd().split(/\r?\n/);
  return split.slice(-lines).join("\n");
}

/**
 * Набор проверок. Каждая возвращает текст доказательства (для PASS) или бросает.
 * `state` наполняется по ходу, чтобы следующие проверки не дублировали запросы.
 */
const CHECKS = [
  {
    name: "auth-fence: GET / без cookie → 401",
    async run({ probe }) {
      const response = await probe.get("/");
      if (response.status !== 401) throw new Error(`ожидали 401, получили ${response.status}`);
      return "401 dsh web authentication required";
    },
  },
  {
    name: "token-exchange: GET /?token=… → 303 + подписанная cookie",
    async run({ probe }) {
      const exchanged = await probe.exchangeBrowserSession();
      if (exchanged.status !== 303) throw new Error(`ожидали 303, получили ${exchanged.status}`);
      if (exchanged.cookie === undefined) throw new Error("ответ без Set-Cookie");
      if (exchanged.location !== "./") throw new Error(`неожиданный location: ${String(exchanged.location)}`);
      return `303 → ./ ; cookie ${exchanged.cookie.slice(0, 24)}…`;
    },
  },
  {
    name: "index: аутентифицированный GET / → 200 + boot-graph",
    async run({ probe, state }) {
      const response = await probe.getAuthenticated("/");
      if (response.status !== 200) throw new Error(`ожидали 200, получили ${response.status}`);
      if (response.json !== undefined) throw new Error("индекс вернул JSON, а не HTML");
      state.html = response.text;
      state.graph = parseBootGraph(response.text);
      state.row = state.graph.entries.find((entry) => entry.id === state.plugin);
      if (state.row === undefined) {
        throw new Error(`в boot-graph нет строки ${state.plugin}`);
      }
      return `HTML ${response.text.length} Б, boot-graph rev ${state.graph.rev}, строк ${state.graph.entries.length}`;
    },
  },
  {
    name: "client-module: раздача /plugins/…/client.js по boot-graph",
    // Нужен разобранный boot-graph из проверки index, даже если выбран --only.
    needs: ["index: аутентифицированный GET / → 200 + boot-graph"],
    async run({ probe, state }) {
      if (state.row === undefined) throw new Error("boot-graph не разобран предыдущей проверкой");
      state.moduleUrl = `/${state.row.url}`;
      // with cookie — как это делает браузер; плюс контроль публичности маршрута.
      const authed = await probe.get(state.moduleUrl, { cookie: probe.browserCookie });
      if (authed.status !== 200) throw new Error(`GET ${state.moduleUrl} → ${authed.status}`);
      const contentType = authed.headers.get("content-type") ?? "";
      if (!contentType.includes("javascript")) throw new Error(`content-type: ${contentType}`);
      if (!authed.text.includes("window.__ModuleLoader__.load")) {
        throw new Error("в теле нет обёртки window.__ModuleLoader__.load");
      }
      if (!authed.text.includes(state.plugin)) throw new Error(`в теле нет id ${state.plugin}`);
      const anonymous = await probe.get(state.moduleUrl, { cookie: undefined });
      state.moduleText = authed.text;
      return `${state.moduleUrl} → 200, ${authed.text.length} Б, ${contentType}; без cookie: ${anonymous.status}`;
    },
  },
  {
    name: "host-route: fixture-маршрут регистрируется на web-сервере",
    fixtureOnly: true,
    async run({ probe }) {
      const response = await probe.get("/fixture/hello");
      if (response.status !== 200) throw new Error(`GET /fixture/hello → ${response.status}`);
      const json = response.json ?? JSON.parse(response.text);
      if (json.ok !== true || json.plugin !== "fixture-plugin") {
        throw new Error(`неожиданный ответ: ${response.text.trim()}`);
      }
      return `200 ${response.text.trim()}`;
    },
  },
  {
    name: "post-json: probe POST JSON → host-маршрут fixture",
    fixtureOnly: true,
    async run({ probe }) {
      const payload = { ping: "harness", at: "fixture-echo" };
      const response = await probe.postJson("/fixture/echo", payload);
      if (response.status !== 200) throw new Error(`POST /fixture/echo → ${response.status}`);
      const json = response.json ?? JSON.parse(response.text);
      if (json.ok !== true || JSON.stringify(json.received) !== JSON.stringify(payload)) {
        throw new Error(`эхо не совпало: ${response.text.trim()}`);
      }
      return `200 ${response.text.trim()}`;
    },
  },
  {
    name: "api: /api без cookie → 401, /connect → 302 + cookie, с cookie → admission пройден",
    async run({ probe }) {
      const unauthorized = await probe.get("/api/nope");
      if (unauthorized.status !== 401) throw new Error(`/api без cookie → ${unauthorized.status}, ожидали 401`);
      const connected = await probe.connectApi();
      if (connected.status !== 302) throw new Error(`/connect → ${connected.status}, ожидали 302`);
      if (connected.cookie === undefined) throw new Error("/connect без Set-Cookie");
      if (connected.location !== "./api/remote.mux") {
        throw new Error(`/connect location: ${String(connected.location)}`);
      }
      const admitted = await probe.apiGet("/api/nope");
      // 404 значит "admission пройден, такого endpoint нет"; 401/403 — провал.
      if (admitted.status !== 404) throw new Error(`/api с cookie → ${admitted.status}, ожидали 404 (admission пройден)`);
      return `401 → 302 (cookie ${connected.cookie.slice(0, 24)}…) → 404`;
    },
  },
];

// ───────────────────────────── вывод ─────────────────────────────

/** Строка лога стенда. */
function log(message) {
  process.stdout.write(`[harness] ${message}\n`);
}

/** main: подготовка → сервер → проверки → teardown. */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  activeProfile = options.profile;
  for (const dir of [VERIFY_DIR, HOME_DIR, AGENTS_HOME_DIR, LOG_DIR, PNPM_STORE_DIR]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(VERIFY_DIR, "README.txt"), "Изолированное состояние стенда verify-harness. Удаляется целиком.\n");

  const electron = resolveElectron();
  const cliScript = resolveCliScript(electron);
  process.stdout.write("DSH verify harness\n");
  process.stdout.write(`  workspace : ${WORKSPACE}\n`);
  process.stdout.write(`  DSH home  : ${HOME_DIR}\n`);
  process.stdout.write(`  профиль   : ${activeProfile}\n`);
  process.stdout.write(`  плагин    : ${options.pluginName} (${options.pluginSpec})\n`);
  process.stdout.write(`  порт      : ${options.port}\n`);

  async function cleanup(server) {
    if (server === undefined) return;
    if (options.keepServer) {
      process.stdout.write(`[harness] --keep-server: сервер pid ${server.pid} оставлен на ${server.origin}\n`);
      return;
    }
    await server.stop();
    process.stdout.write(`[harness] сервер остановлен (pid ${server.pid})\n`);
  }

  let server;
  const results = [];
  try {
    await ensureProfile(electron, cliScript, options);
    await ensurePluginInstalled(electron, cliScript, options);
    server = await startServer(electron, cliScript, options);
    const probe = createProbe({ origin: server.origin, token: server.token });
    const state = { plugin: options.pluginName };
    // --only выбирает проверки по подстроке, но не ломает их предпосылки.
    const selected = CHECKS.filter(
      (check) => options.only === undefined || check.name.includes(options.only),
    );
    if (options.only !== undefined) {
      for (const check of [...selected]) {
        for (const need of check.needs ?? []) {
          const dependency = CHECKS.find((candidate) => candidate.name === need);
          if (dependency !== undefined && !selected.includes(dependency)) selected.unshift(dependency);
        }
      }
    }
    process.stdout.write("\n");
    for (const check of selected) {
      if (check.fixtureOnly === true && options.pluginName !== FIXTURE_PACKAGE) {
        process.stdout.write(`[SKIP] ${check.name} — проверка специфична для fixture\n`);
        continue;
      }
      const started = Date.now();
      try {
        const evidence = await check.run({ probe, state, server });
        results.push({ name: check.name, ok: true, evidence });
        process.stdout.write(`[PASS] ${check.name} — ${evidence} (${Date.now() - started} мс)\n`);
      } catch (error) {
        results.push({ name: check.name, ok: false, evidence: String(error) });
        process.stdout.write(`[FAIL] ${check.name} — ${String(error)}\n`);
        if (options.verbose && state.graph !== undefined) {
          process.stdout.write(`[harness] boot-graph: ${JSON.stringify(state.row)}\n`);
        }
      }
    }
    if (options.smoke) {
      const started = Date.now();
      if (state.moduleText === undefined) {
        process.stdout.write("[SKIP] dom-smoke: клиентский модуль не получен — проверка client-module не выполнялась\n");
      } else {
        const { runSmoke } = await import("./smoke-dom.mjs");
        const smoke = await runSmoke({
          origin: server.origin,
          token: server.token,
          moduleUrl: state.moduleUrl,
          moduleText: state.moduleText,
          pluginId: options.pluginName,
          // VM-шим рассчитан на самодостаточный fixture-бандл без внешних require.
          shim: options.pluginName === FIXTURE_PACKAGE,
        });
        results.push({ name: "dom-smoke: headless-браузер", ok: smoke.ok, evidence: smoke.evidence, skipped: smoke.skipped });
        const verdict = smoke.skipped ? "SKIP" : smoke.ok ? "PASS" : "FAIL";
        process.stdout.write(`[${verdict}] dom-smoke: ${smoke.evidence} (${Date.now() - started} мс)\n`);
      }
    }
  } catch (error) {
    process.stdout.write(`[FAIL] harness: ${String(error)}\n`);
    results.push({ name: "harness", ok: false, evidence: String(error) });
  } finally {
    try {
      await cleanup(server);
    } catch (error) {
      process.stdout.write(`[FAIL] harness: teardown — ${String(error)}\n`);
      results.push({ name: "teardown", ok: false, evidence: String(error) });
    }
  }

  const failed = results.filter((result) => !result.ok).length;
  const skipped = results.filter((result) => result.ok && result.skipped === true).length;
  const passed = results.length - failed - skipped;
  process.stdout.write(`\nИтог: ${passed} PASS, ${skipped} SKIP, ${failed} FAIL (всего ${results.length})\n`);
  if (failed === 0 && results.length === 0) {
    process.stdout.write("[harness] ни одна проверка не выполнялась (--only не совпал?)\n");
    process.exitCode = 1;
    return;
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`harness: ${String(error)}\n`);
  process.exitCode = 1;
});
