/**
 * HTTP-маршруты плагина под `/api/dsh-auto-translate/*`.
 *
 * Клиентская половина обращается к ним same-origin `fetch`-ем (как и другие
 * GUI-плагины), поэтому отдельной авторизации не требуется: за безопасность
 * отвечает политика самого веб-сервера DSH. Для POST-ов дополнительно
 * требуется заголовок `x-dsh-auto-translate`: он делает кросс-сайтовые запросы
 * невыполнимыми без CORS-preflight, защищая от CSRF.
 * @module dsh-auto-translate-ui/host/routes
 */

import { isPlainObject } from './util.js'
import { sanitizeText } from './batch.js'
import { describeLlm, translateTexts } from './llm.js'

/** Префикс API плагина. */
export const API_PREFIX = '/api/dsh-auto-translate'

/** Поддерживаемые целевые языки. */
const LANGS = new Set(['ru', 'en'])

/** Максимальный размер JSON-тела запроса. */
const MAX_BODY_BYTES = 512 * 1024

/** Максимум строк в одном запросе перевода. */
const MAX_ITEMS = 200

/** Заголовок, обязательный для изменяющих запросов (CSRF-защита). */
const CSRF_HEADER = 'x-dsh-auto-translate'

/**
 * Проверить, что запрос пришёл от доверенного клиента.
 *
 * Маршруты плагина живут под `/api/...` и перекрывают prefix-роут
 * `dsh-client-connection`, который обычно проверяет сессионную cookie. Поэтому
 * забор делаем сами:
 * - Electron-оболочка грузит GUI с origin `dsh-app://app` и проксирует
 *   запросы к локальному хосту через протокол `dsh-app:`; такой origin
 *   считаем доверенным;
 * - обычный браузер: same-origin (`Origin.host === Host`);
 * - запрос без Origin (навигационный GET, IPC-прокси) — только с loopback-сокета
 *   или при loopback-адресе в Host.
 * Cross-site fetch отсекается по `Sec-Fetch-Site`.
 * @param {import('node:http').IncomingMessage} req - запрос.
 * @returns {boolean} истина, если запрос можно обслуживать.
 */
export function isTrustedRequest(req) {
  const headers = req.headers ?? {}
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const host = headers.host
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '') {
    // Origin Electron-оболочки: документ загружен с dsh-app://app.
    if (origin === 'dsh-app://app') return true
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  // Без Origin: доверяем loopback-сокету. Если сокета нет (IPC-прокси без
  // TCP-адреса), допускаем loopback-адрес в Host; реальный удалённый клиент
  // с подделанным Host при этом не проходит.
  const remoteAddress = req.socket?.remoteAddress
  if (remoteAddress === undefined) {
    if (typeof host === 'string') {
      try {
        const hostname = new URL(`http://${host}`).hostname
        if (hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.')) return true
      } catch {
        return false
      }
    }
    return false
  }
  const remote = String(remoteAddress).toLowerCase()
  return remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.')
}

/**
 * Отправить JSON-ответ.
 * @param {import('node:http').ServerResponse} res - ответ.
 * @param {number} status - код.
 * @param {unknown} body - тело.
 * @param {Record<string,string>} [extra] - дополнительные заголовки.
 * @returns {void}
 */
function sendJson(res, status, body, extra = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(payload),
    ...extra,
  })
  res.end(payload)
}

/**
 * Отправить ошибку в едином формате.
 * @param {import('node:http').ServerResponse} res - ответ.
 * @param {number} status - код.
 * @param {string} code - машинный код.
 * @param {string} [message] - пояснение.
 * @returns {void}
 */
function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message: message ?? code } })
}

/**
 * Прочитать JSON-тело запроса с ограничением размера.
 * @param {import('node:http').IncomingMessage} req - запрос.
 * @returns {Promise<unknown>} разобранное тело.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body-too-large'), { status: 413 })
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid-json'), { status: 400 })
  }
}

/**
 * Проверить метод и CSRF-заголовок.
 * @param {import('node:http').IncomingMessage} req - запрос.
 * @param {string} method - ожидаемый метод.
 * @param {boolean} guarded - требуется ли CSRF-заголовок.
 * @returns {string|null} код ошибки или null.
 */
function checkRequest(req, method, guarded) {
  if ((req.method ?? 'GET').toUpperCase() !== method) return 'method-not-allowed'
  if (guarded && req.headers[CSRF_HEADER] !== '1') return 'missing-header'
  return null
}

/**
 * Нормализовать целевой язык запроса.
 * @param {unknown} requested - язык из тела/квери.
 * @param {object} cfg - конфигурация плагина.
 * @returns {'ru'|'en'|null} язык или null.
 */
function normalizeLang(requested, cfg) {
  const candidate = typeof requested === 'string' && requested !== '' ? requested.toLowerCase() : null
  if (candidate !== null && LANGS.has(candidate)) return candidate
  if (cfg.targetLanguage !== 'auto' && LANGS.has(cfg.targetLanguage)) return cfg.targetLanguage
  return null
}

/**
 * Зарегистрировать все маршруты плагина.
 * @param {object} deps - зависимости.
 * @param {object} deps.ctx - контекст плагина.
 * @param {{info: Function, warn: Function, debug: Function}} deps.log - логгер.
 * @param {() => object} deps.resolveConfig - чтение актуального конфига.
 * @param {(lang: 'ru'|'en') => Promise<object>} deps.cacheFor - кэш языка.
 * @param {object} deps.inventory - инвентарь плагинов.
 * @param {string} deps.pluginVersion - версия самого плагина.
 * @returns {() => void} функция снятия маршрутов.
 */
export function registerRoutes({ ctx, log, resolveConfig, cacheFor, inventory, pluginVersion }) {
  const disposers = []
  const register = (path, handler, { kind = 'exact' } = {}) => {
    const route = {
      kind,
      path,
      handler: async (req, res) => {
        try {
          if (!isTrustedRequest(req)) {
            sendError(res, 403, 'forbidden', 'request is not same-origin')
            return
          }
          await handler(req, res)
        } catch (error) {
          const status = error?.status ?? 500
          log?.warn?.(`route ${path} failed:`, error?.message ?? error)
          if (!res.headersSent) sendError(res, status, error?.status === 413 ? 'body-too-large' : 'internal-error')
          else res.end()
        }
      },
    }
    const dispose = ctx.webServer.register(route)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  /** Конфигурация для клиента: только то, что влияет на его поведение. */
  const publicConfig = () => {
    const cfg = resolveConfig()
    return {
      enabled: cfg.enabled,
      targetLanguage: cfg.targetLanguage,
      scope: cfg.scope,
      includeScripts: cfg.includeScripts,
      latinDetection: cfg.latinDetection,
      translateAttributes: cfg.translateAttributes,
      skipSelectors: cfg.skipSelectors,
      debounceMs: cfg.debounceMs,
      maxTextChars: cfg.maxTextChars,
      maxBatchItems: cfg.maxBatchItems,
      seedOnStart: cfg.seedOnStart,
    }
  }

  /** Сводка по доступности модели для клиента и настроек. */
  const llmSummary = () => describeLlm(ctx, resolveConfig())

  // GET /config — стартовый опрос клиента (и периодический, если плагин выключен).
  register(`${API_PREFIX}/config`, async (req, res) => {
    const error = checkRequest(req, 'GET', false)
    if (error !== null) return sendError(res, error === 'method-not-allowed' ? 405 : 400, error)
    const cfg = resolveConfig()
    const cache = await cacheFor(normalizeLang(null, cfg) ?? 'ru')
    sendJson(res, 200, {
      pluginVersion,
      config: publicConfig(),
      llm: llmSummary(),
      cache: cache.describe(),
    })
  })

  // GET /translations?lang=ru — снимок кэша для мгновенного первого рендера.
  register(`${API_PREFIX}/translations`, async (req, res) => {
    const error = checkRequest(req, 'GET', false)
    if (error !== null) return sendError(res, error === 'method-not-allowed' ? 405 : 400, error)
    const cfg = resolveConfig()
    const url = new URL(req.url ?? '/', 'http://localhost')
    const lang = normalizeLang(url.searchParams.get('lang'), cfg)
    if (lang === null) return sendError(res, 400, 'unsupported-language')
    if (!cfg.seedOnStart) return sendJson(res, 200, { lang, entries: {}, total: 0, skipped: 0 })
    const cache = await cacheFor(lang)
    const seed = cache.seed(inventory.versions())
    sendJson(res, 200, { lang, ...seed })
  })

  // POST /translate — основной маршрут: кэш + батч-перевод недостающего.
  register(`${API_PREFIX}/translate`, async (req, res) => {
    const error = checkRequest(req, 'POST', true)
    if (error !== null) return sendError(res, error === 'missing-header' ? 403 : 400, error)
    const cfg = resolveConfig()
    if (!cfg.enabled) return sendJson(res, 200, { disabled: true, translations: {} })
    const body = await readJsonBody(req)
    if (!isPlainObject(body)) return sendError(res, 400, 'invalid-body')
    const lang = normalizeLang(body.lang, cfg)
    if (lang === null) return sendError(res, 400, 'unsupported-language')
    const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : []
    const cache = await cacheFor(lang)
    const versions = inventory.versions()

    /** @type {Map<string, Array<{pkg: string, version: string}>>} текст → владельцы */
    const texts = new Map()
    for (const item of items) {
      if (!isPlainObject(item)) continue
      const text = sanitizeText(item.t)
      if (text.length < 2 || text.length > cfg.maxTextChars) continue
      const list = texts.get(text) ?? []
      if (typeof item.ns === 'string' && item.ns !== '') {
        const owner = await inventory.namespaceOwner(item.ns)
        if (owner !== null) list.push(owner)
      }
      texts.set(text, list)
    }

    /** @type {Record<string,string>} */
    const translations = {}
    /** @type {Array<{text: string, owners: Record<string,string>}>} */
    const pending = []
    let cached = 0
    for (const [text, ownersList] of texts) {
      const owners = Object.fromEntries(ownersList.map((owner) => [owner.pkg, owner.version]))
      const hit = cache.lookup(text, versions)
      if (hit !== null) {
        translations[text] = hit.dst
        cache.adopt(text, owners)
        cached += 1
        continue
      }
      if (cache.isMiss(text)) continue
      pending.push({ text, owners })
    }

    let failed = 0
    let provider = null
    let usage = { inputTokens: 0, outputTokens: 0 }
    let llmError = null
    if (pending.length > 0) {
      const result = await translateTexts(
        ctx,
        cfg,
        lang,
        pending.map((entry) => entry.text),
      )
      provider = result.provider
      usage = result.usage
      llmError = result.error
      if (result.error !== null) failed = pending.length
      pending.forEach((entry, index) => {
        const value = result.values[index]
        // Эхо исходной строки (модель ничего не перевела) кэшировать нельзя:
        // иначе снимок кэша будет вечно возвращать оригинал как «перевод».
        const echoed = typeof value === 'string' && sanitizeText(value) === entry.text
        if (typeof value === 'string' && value !== '' && !echoed) {
          translations[entry.text] = value
          cache.remember(entry.text, value, entry.owners)
        } else {
          cache.rememberMiss(entry.text, cfg.negativeCacheMinutes * 60 * 1000)
          failed += 1
        }
      })
      if (result.error !== null) failed = Math.max(failed, pending.length)
      if (provider !== null) {
        cache.noteUsage(usage)
        log?.info?.(
          `translate: ${pending.length} строк → ${provider}/${cfg.model}, tokens in=${usage.inputTokens} out=${usage.outputTokens}`,
        )
      } else {
        cache.noteFailure()
        log?.warn?.(`translate: не удалось перевести ${pending.length} строк, код: ${llmError}`)
      }
    }

    sendJson(res, 200, {
      lang,
      translations,
      stats: {
        requested: texts.size,
        cached,
        translated: Object.keys(translations).length - cached,
        failed,
        provider,
        usage,
      },
      error: llmError,
    })
  })

  // GET /meta — диагностика: версии плагинов, состояние LLM и кэша.
  register(`${API_PREFIX}/meta`, async (req, res) => {
    const error = checkRequest(req, 'GET', false)
    if (error !== null) return sendError(res, error === 'method-not-allowed' ? 405 : 400, error)
    const cfg = resolveConfig()
    const ru = await cacheFor('ru')
    const en = await cacheFor('en')
    sendJson(res, 200, {
      pluginVersion,
      llm: llmSummary(),
      plugins: await inventory.describe(),
      versionedPackages: Object.fromEntries(inventory.versions()),
      cache: { ru: ru.describe(), en: en.describe() },
      config: publicConfig(),
    })
  })

  // POST /forget — сброс кэша (для отладки и ручного обновления переводов).
  register(`${API_PREFIX}/forget`, async (req, res) => {
    const error = checkRequest(req, 'POST', true)
    if (error !== null) return sendError(res, error === 'missing-header' ? 403 : 400, error)
    const body = await readJsonBody(req)
    const all = isPlainObject(body) && body.all === true
    const langs = all ? ['ru', 'en'] : Array.isArray(body?.langs) ? body.langs.filter((lang) => LANGS.has(lang)) : []
    let removed = 0
    for (const lang of langs) removed += await (await cacheFor(lang)).forgetAll()
    sendJson(res, 200, { cleared: langs, removed })
  })

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* снятие маршрута не должно ломать выгрузку плагина */
      }
    }
  }
}
