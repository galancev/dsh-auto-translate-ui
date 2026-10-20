/**
 * Аутентифицированный HTTP-хелпер для изолированного экземпляра `dsh web`.
 *
 * Механизм авторизации DSH web (проверено по коду 0.2.1-rc.2):
 *  - процесс печатает в stdout строку `dsh web: <origin>/?token=<launch-token>`;
 *  - `GET /?token=...` обменивает токен на подписанную cookie браузерной сессии
 *    и отвечает 303 на `./`;
 *  - `GET /connect?token=...&interactions=answer|none` обменивает токен на
 *    отдельную cookie API-пользователя (302 на `./api/remote.mux`);
 *  - без валидной cookie `/` (индекс) и `/api/**` отвечают 401, `/plugins/**`
 *    и обычные статические ассеты публичны.
 *
 * Модуль не тянет внешних зависимостей: только глобальный fetch (Node >= 22).
 *
 * CLI-режим (удобно для ручных проверок):
 *   node tools/probe.mjs --log .verify/logs/server.log GET /
 *   node tools/probe.mjs --origin http://127.0.0.1:51999 --token <t> --api GET /api/nope
 *   node tools/probe.mjs --origin ... --token <t> --json '{"a":1}' POST /api/echo
 */

import { pathToFileURL } from "node:url";

/** Таймаут одного запроса по умолчанию. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Разобрать boot-graph `globalThis["__DSH_BOOT__"] = {…}` из HTML индекса.
 *
 * Форма проверена на 0.2.1-rc.2: строка вида
 * `globalThis["__DSH_BOOT__"] = {"rev":…,"release":…,"entries":[…]}` внутри
 * `<script>`. Ключ набора — `entries`, а не `modules`.
 * @param {string} html - тело аутентифицированного `GET /`.
 * @returns {{ rev: string, release?: object, entries: Array<Record<string, unknown>> }}
 */
export function parseBootGraph(html) {
  const match = String(html).match(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\})<\/script>/);
  if (match === null) throw new Error('boot-graph: в HTML нет globalThis["__DSH_BOOT__"]');
  const graph = JSON.parse(match[1]);
  if (!Array.isArray(graph.entries)) throw new Error("boot-graph: у графа нет массива entries");
  return graph;
}

/**
 * Найти строку boot-graph по id пакета.
 * @param {{ entries: Array<Record<string, unknown>> }} graph
 * @param {string} id - имя пакета (id клиентского модуля).
 * @returns {Record<string, unknown> | undefined}
 */
export function bootEntry(graph, id) {
  return graph.entries.find((entry) => entry.id === id);
}

/**
 * Извлечь URL с launch-токеном из stdout сервера.
 * @param {string} text - накопленный stdout (или его хвост).
 * @returns {{ url: string, origin: string, token: string } | undefined}
 */
export function parseLaunchUrl(text) {
  const matches = [...String(text).matchAll(/dsh web:\s+(\S+)/g)];
  const last = matches.at(-1);
  if (last === undefined) return undefined;
  let url;
  try {
    url = new URL(last[1]);
  } catch {
    return undefined;
  }
  const token = url.searchParams.get("token");
  if (token === null) return undefined;
  return { url: url.href, origin: url.origin, token };
}

/**
 * Достать `set-cookie` из ответа fetch (Node >= 22 умеет getSetCookie()).
 * @param {Response} response
 * @returns {string[]}
 */
export function setCookiesOf(response) {
  if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
  const single = response.headers.get("set-cookie");
  return single === null ? [] : [single];
}

/**
 * Собрать пару `имя=значение` из первого Set-Cookie ответа.
 * @param {Response} response
 * @returns {string | undefined}
 */
export function sessionCookieOf(response) {
  const first = setCookiesOf(response)[0];
  return first?.split(";", 1)[0]?.trim();
}

/**
 * Создать probe поверх одного origin.
 * @param {{ origin: string, token?: string, timeoutMs?: number }} options
 *   `origin` — корень вида `http://127.0.0.1:51999`; `token` — launch-токен из URL сервера.
 * @returns probe-объект с методами запросов и обмена токена на cookie.
 */
export function createProbe({ origin, token, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const base = new URL(origin);
  /** Cookie браузерной сессии (`/` + `/plugins` + статика). */
  let browserCookie = undefined;
  /** Cookie API-пользователя (`/api/**`), отдельная от браузерной. */
  let apiCookie = undefined;

  /** Собрать абсолютный URL запроса. */
  function absolute(path) {
    return new URL(path, base).href;
  }

  /** Общие заголовки probe: Host берётся из URL, Origin не выставляем. */
  function baseHeaders() {
    return { "user-agent": "dsh-verify-probe/1.0" };
  }

  /**
   * Один HTTP-запрос с ручным разбором редиректов.
   * @param {string} method
   * @param {string} path
   * @param {{
   *   cookie?: string,
   *   headers?: Record<string,string>,
   *   body?: string,
   *   redirect?: RequestRedirect,
   *   timeoutMs?: number
   * }} [options]
   * @returns {Promise<{
   *   status: number, headers: Headers, location: string | undefined,
   *   setCookies: string[], text: string, json: any, url: string
   * }>}
   */
  async function request(method, path, options = {}) {
    const headers = { ...baseHeaders(), ...options.headers };
    if (options.cookie !== undefined) headers.cookie = options.cookie;
    const response = await fetch(absolute(path), {
      method,
      headers,
      body: options.body,
      redirect: options.redirect ?? "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? timeoutMs),
    });
    const text = method === "HEAD" ? "" : await response.text();
    let json;
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      location: response.headers.get("location") ?? undefined,
      setCookies: setCookiesOf(response),
      text,
      json,
      url: response.url,
    };
  }

  /** GET-запрос. */
  function get(path, options) {
    return request("GET", path, options);
  }

  /** HEAD-запрос. */
  function head(path, options) {
    return request("HEAD", path, options);
  }

  /**
   * POST JSON-запроса (для /api-каналов и host-маршрутов, принимающих JSON).
   * @param {string} path
   * @param {unknown} value
   * @param {{ cookie?: string, headers?: Record<string,string> } & Record<string, unknown>} [options]
   */
  function postJson(path, value, options = {}) {
    const body = JSON.stringify(value);
    return request("POST", path, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      body,
    });
  }

  /**
   * Обменять launch-токен на браузерную cookie через `GET /?token=...`.
   * @returns {Promise<{ status: number, cookie: string | undefined, location: string | undefined }>}
   */
  async function exchangeBrowserSession() {
    if (token === undefined) throw new Error("probe: нет launch-токена; передай token или возьми его из parseLaunchUrl()");
    const response = await request("GET", `/?token=${encodeURIComponent(token)}`);
    browserCookie = sessionCookieOf(response);
    return { status: response.status, cookie: browserCookie, location: response.location };
  }

  /**
   * Обменять launch-токен на API-cookie через `GET /connect?token=...&interactions=...`.
   * @param {{ interactions?: 'answer' | 'none' }} [options]
   * @returns {Promise<{ status: number, cookie: string | undefined, location: string | undefined }>}
   */
  async function connectApi({ interactions = "answer" } = {}) {
    if (token === undefined) throw new Error("probe: нет launch-токена; передай token или возьми его из parseLaunchUrl()");
    const response = await request(
      "GET",
      `/connect?token=${encodeURIComponent(token)}&interactions=${interactions}`,
    );
    apiCookie = sessionCookieOf(response);
    return { status: response.status, cookie: apiCookie, location: response.location };
  }

  /**
   * Гарантировать браузерную cookie (обмен токена при первом обращении).
   * @returns {Promise<string>} значение cookie
   */
  async function ensureBrowserCookie() {
    if (browserCookie === undefined) await exchangeBrowserSession();
    if (browserCookie === undefined) throw new Error("probe: сервер не выдал браузерную cookie (неверный токен?)");
    return browserCookie;
  }

  /**
   * Гарантировать API-cookie (обмен через /connect при первом обращении).
   * @returns {Promise<string>} значение cookie
   */
  async function ensureApiCookie() {
    if (apiCookie === undefined) await connectApi();
    if (apiCookie === undefined) throw new Error("probe: сервер не выдал API-cookie (неверный токен?)");
    return apiCookie;
  }

  /** GET с автоматической браузерной cookie. */
  async function getAuthenticated(path, options = {}) {
    return get(path, { ...options, cookie: await ensureBrowserCookie() });
  }

  /** GET /api/** с API-cookie (без следования редиректу на remote.mux). */
  async function apiGet(path, options = {}) {
    return get(path, { ...options, cookie: await ensureApiCookie() });
  }

  /** POST JSON на /api/** с API-cookie. */
  async function apiPostJson(path, value, options = {}) {
    return postJson(path, value, { ...options, cookie: await ensureApiCookie() });
  }

  return {
    origin: base.origin,
    token,
    get,
    head,
    postJson,
    request,
    exchangeBrowserSession,
    connectApi,
    ensureBrowserCookie,
    ensureApiCookie,
    getAuthenticated,
    apiGet,
    apiPostJson,
    get browserCookie() {
      return browserCookie;
    },
    get apiCookie() {
      return apiCookie;
    },
  };
}

// ───────────────────────────── CLI ─────────────────────────────

/** Разобрать argv CLI-режима. */
function parseArgv(argv) {
  const options = { method: "GET", headers: {}, redirect: "manual", json: undefined, showBody: true };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--origin") options.origin = argv[++i];
    else if (arg === "--token") options.token = argv[++i];
    else if (arg === "--log") options.log = argv[++i];
    else if (arg === "--api") options.api = true;
    else if (arg === "--json") options.json = argv[++i];
    else if (arg === "--timeout") options.timeout = Number(argv[++i]);
    else if (arg === "--no-body") options.showBody = false;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        [
          "usage: node tools/probe.mjs (--origin URL [--token T] | --log FILE) [--api] [--json BODY] [--no-body] METHOD PATH",
          "  --origin URL   корень изолированного dsh web, напр. http://127.0.0.1:51999",
          "  --token T      launch-токен (можно не указывать для публичных маршрутов)",
          "  --log FILE     взять origin+token из файла со строкой 'dsh web: ...?token=...'",
          "  --api          обменять токен через /connect и идти с API-cookie",
          "  --json BODY    POST JSON с указанным телом",
          "  --no-body      не печатать тело ответа",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
    else if (arg.startsWith("--")) throw new Error(`probe: неизвестный флаг ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 0) options.method = positional[0].toUpperCase();
  options.path = positional[1] ?? "/";
  return options;
}

/** Точка входа CLI-режима. */
async function main(argv) {
  const options = parseArgv(argv);
  if (options.log !== undefined) {
    const { readFile } = await import("node:fs/promises");
    const parsed = parseLaunchUrl(await readFile(options.log, "utf8"));
    if (parsed === undefined) throw new Error(`probe: в ${options.log} нет строки "dsh web: ...?token=..."`);
    options.origin = parsed.origin;
    options.token = parsed.token;
  }
  if (options.origin === undefined) throw new Error("probe: укажи --origin или --log");
  const probe = createProbe({
    origin: options.origin,
    token: options.token,
    ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
  });
  let response;
  if (options.json !== undefined) {
    response = await probe.postJson(options.path, JSON.parse(options.json), {
      ...(options.api ? { cookie: await probe.ensureApiCookie() } : {}),
    });
  } else if (options.api) {
    response = await probe.request(options.method, options.path, {
      cookie: await probe.ensureApiCookie(),
      redirect: options.redirect,
    });
  } else {
    response = await probe.request(options.method, options.path, { redirect: options.redirect });
  }
  process.stdout.write(`HTTP ${response.status}\n`);
  for (const [name, value] of response.headers) process.stdout.write(`${name}: ${value}\n`);
  if (options.showBody && response.text !== "") process.stdout.write(`\n${response.text}\n`);
  return response.status >= 200 && response.status < 400 ? 0 : 1;
}

/** Запущен ли модуль напрямую (`node tools/probe.mjs …`), а не импортирован. */
function isDirectInvocation() {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
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
