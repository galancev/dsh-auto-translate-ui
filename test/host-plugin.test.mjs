/**
 * Интеграционный тест хост-половины: маршруты, конфиг, кэш и привязка к версии
 * плагина. Веб-сервер, LLM и инвентарь пакетов подменяются фейками, поэтому
 * тест не требует запущенного DSH.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'

/**
 * Фейковый ответ Node-сервера, собирающий записанное тело.
 * @returns {object} объект с полями statusCode/headers/body и методами.
 */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
    },
  }
}

/**
 * Фейковый запрос: async-итератор по телу + заголовки/метод.
 * @param {string} method - HTTP-метод.
 * @param {string} url - путь с query.
 * @param {object} [body] - JSON-тело.
 * @param {object} [headers] - заголовки.
 * @returns {object} запрос.
 */
function fakeRequest(method, url, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    // Host нужен same-origin fence: реальный запрос от GUI приходит с ним.
    headers: { host: '127.0.0.1:51999', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/**
 * Собрать минимальный контекст Cordis с фейковыми сервисами.
 * @param {object} options - зависимости.
 * @returns {Promise<{ctx: object, routes: Map<string, Function>, calls: object[]}>} контекст и маршруты.
 */
async function makeHost(options = {}) {
  const routes = new Map()
  const calls = []
  const versions = new Map(options.versions ?? [])
  let enabled = options.enabled ?? true
  const llm = {
    listProviders: () => [{ id: 'deepseek-account' }],
    prepareCall: async (config) => {
      calls.push(config)
      return {
        config: { ...config, reasoningEffort: 'off' },
        stream: async function* (request) {
          const source = JSON.parse(request.messages[0].content[0].text)
          // options.echo имитирует модель, которая вернула исходник без перевода.
          const translated = options.echo === true ? source : source.map((text) => `RU:${text}`)
          yield { type: 'text-delta', index: 0, text: JSON.stringify(translated) }
          yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const pluginPackages = {
    packageOf: (name) => (versions.has(name) ? { name, version: versions.get(name), dir: '/nonexistent', manifest: {} } : undefined),
  }
  // Cordis-загрузчик: по строке на каждый известный пакет (имя + база резолва).
  const loader = {
    entries: () =>
      [...versions.keys()].map((name) => ({
        options: { name },
        parent: { tree: { ctx: { baseUrl: 'file:///profile/' } } },
      })),
  }
  const services = { llm, webServer, pluginPackages, loader }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    // Cordis выставляет сервисы и как свойства контекста, и через ctx.get().
    ...services,
    get: (name) => services[name],
    effect(fn) {
      return fn()
    },
    inject(_names, callback) {
      return callback(ctx)
    },
  }
  const config = {}
  /**
   * Конфиг с «живыми» значениями: плагин читает их через .get().
   * @param {object} values - значения.
   * @returns {object} конфиг.
   */
  for (const [key, value] of Object.entries({ enabled, ...options.config })) {
    config[key] = { get: () => value }
  }
  apply(ctx, config)
  return { ctx, routes, calls, setEnabled: (value) => (enabled = value) }
}

/**
 * Вызвать маршрут и вернуть разобранный JSON-ответ.
 * @param {object} routes - таблица маршрутов.
 * @param {string} path - путь.
 * @param {object} request - фейковый запрос.
 * @returns {Promise<{status: number, json: object}>} ответ.
 */
async function call(routes, path, request) {
  const response = fakeResponse()
  await routes.get(path)(request, response)
  return { status: response.statusCode, json: response.body === '' ? null : JSON.parse(response.body) }
}

test('плагин экспортирует схему конфигурации для страницы настроек', () => {
  assert.equal(typeof Config, 'function')
})

test('GET /config отдаёт настройки и состояние LLM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-translate-host-'))
  process.env.DSH_HOME = dir
  try {
    const { routes } = await makeHost({ config: { cacheDir: join(dir, 'cache') } })
    const { status, json } = await call(routes, '/api/dsh-auto-translate/config', fakeRequest('GET', '/api/dsh-auto-translate/config'))
    assert.equal(status, 200)
    assert.equal(json.config.enabled, true)
    assert.equal(json.config.targetLanguage, 'auto')
    assert.deepEqual(json.llm.candidates, ['deepseek-account'])
    assert.equal(json.pluginVersion, JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version)
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})

test('POST /translate переводит китайские строки и пишет кэш', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-translate-host-'))
  process.env.DSH_HOME = dir
  try {
    const { routes, calls } = await makeHost({
      versions: [['dsh-example', '1.0.0']],
      config: { cacheDir: join(dir, 'cache') },
    })
    const request = fakeRequest(
      'POST',
      '/api/dsh-auto-translate/translate',
      { lang: 'ru', items: [{ t: '保存', ns: 'example' }, { t: '删除' }] },
      { 'x-dsh-auto-translate': '1' },
    )
    const { status, json } = await call(routes, '/api/dsh-auto-translate/translate', request)
    assert.equal(status, 200)
    assert.deepEqual(json.translations, { 保存: 'RU:保存', 删除: 'RU:删除' })
    assert.equal(json.stats.requested, 2)
    assert.equal(json.stats.cached, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].provider, 'deepseek-account')
    assert.equal(calls[0].model, 'deepseek-flash')
    assert.equal(calls[0].temperature, 0)

    // Второй такой же запрос должен целиком обслужиться из кэша.
    const second = await call(
      routes,
      '/api/dsh-auto-translate/translate',
      fakeRequest(
        'POST',
        '/api/dsh-auto-translate/translate',
        { lang: 'ru', items: [{ t: '保存', ns: 'example' }, { t: '删除' }] },
        { 'x-dsh-auto-translate': '1' },
      ),
    )
    assert.equal(second.json.stats.cached, 2)
    assert.equal(calls.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})

test('обновление версии плагина инвалидирует только его строки', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-translate-host-'))
  process.env.DSH_HOME = dir
  try {
    const versions = new Map([
      ['dsh-a', '1.0.0'],
      ['dsh-b', '1.0.0'],
    ])
    const { routes, calls } = await makeHost({ versions, config: { cacheDir: join(dir, 'cache') } })
    const payload = {
      lang: 'ru',
      items: [{ t: '保存', ns: 'a' }, { t: '删除', ns: 'b' }],
    }
    await call(routes, '/api/dsh-auto-translate/translate', fakeRequest('POST', '/', payload, { 'x-dsh-auto-translate': '1' }))
    assert.equal(calls.length, 1)

    // Обновился только dsh-a: строка a переводится заново, строка b из кэша.
    versions.set('dsh-a', '2.0.0')
    // Инвентарь кэширует версии на 30 секунд, а кэш переводов пишется с
    // задержкой: пересоздаём плагин после того, как файл гарантированно записан.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const fresh = await makeHost({ versions, config: { cacheDir: join(dir, 'cache') } })
    const { json } = await call(
      fresh.routes,
      '/api/dsh-auto-translate/translate',
      fakeRequest('POST', '/', payload, { 'x-dsh-auto-translate': '1' }),
    )
    assert.equal(json.stats.cached, 1)
    assert.deepEqual(json.translations, { 保存: 'RU:保存', 删除: 'RU:删除' })
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})

test('GET /translations отдаёт снимок кэша для первого рендера', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-translate-host-'))
  process.env.DSH_HOME = dir
  try {
    const { routes } = await makeHost({ config: { cacheDir: join(dir, 'cache') } })
    await call(
      routes,
      '/api/dsh-auto-translate/translate',
      fakeRequest('POST', '/', { lang: 'ru', items: [{ t: '保存' }] }, { 'x-dsh-auto-translate': '1' }),
    )
    const { status, json } = await call(routes, '/api/dsh-auto-translate/translations', fakeRequest('GET', '/?lang=ru'))
    assert.equal(status, 200)
    assert.equal(json.lang, 'ru')
    assert.equal(json.entries['保存'], 'RU:保存')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})

test('POST /translate отклоняет запрос без защитного заголовка', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-translate-host-'))
  process.env.DSH_HOME = dir
  try {
    const { routes } = await makeHost({ config: { cacheDir: join(dir, 'cache') } })
    const { status, json } = await call(
      routes,
      '/api/dsh-auto-translate/translate',
      fakeRequest('POST', '/', { lang: 'ru', items: [] }),
    )
    assert.equal(status, 403)
    assert.equal(json.error.code, 'missing-header')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})

test('при выключенном плагине маршрут перевода не обращается к модели', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-translate-host-'))
  process.env.DSH_HOME = dir
  try {
    const { routes, calls } = await makeHost({ enabled: false, config: { cacheDir: join(dir, 'cache') } })
    const { json } = await call(
      routes,
      '/api/dsh-auto-translate/translate',
      fakeRequest('POST', '/', { lang: 'ru', items: [{ t: '保存' }] }, { 'x-dsh-auto-translate': '1' }),
    )
    assert.equal(json.disabled, true)
    assert.equal(calls.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})

test('POST /forget очищает кэш языка', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-translate-host-'))
  process.env.DSH_HOME = dir
  try {
    const { routes } = await makeHost({ config: { cacheDir: join(dir, 'cache') } })
    await call(
      routes,
      '/api/dsh-auto-translate/translate',
      fakeRequest('POST', '/', { lang: 'ru', items: [{ t: '保存' }] }, { 'x-dsh-auto-translate': '1' }),
    )
    const { json } = await call(
      routes,
      '/api/dsh-auto-translate/forget',
      fakeRequest('POST', '/', { langs: ['ru'] }, { 'x-dsh-auto-translate': '1' }),
    )
    assert.deepEqual(json.cleared, ['ru'])
    const seed = await call(routes, '/api/dsh-auto-translate/translations', fakeRequest('GET', '/?lang=ru'))
    assert.deepEqual(seed.json.entries, {})
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})

test('эхо исходной строки не кэшируется и считается неудачей', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-translate-host-'))
  process.env.DSH_HOME = dir
  try {
    const { routes } = await makeHost({ echo: true, config: { cacheDir: join(dir, 'cache') } })
    const { json } = await call(
      routes,
      '/api/dsh-auto-translate/translate',
      fakeRequest('POST', '/', { lang: 'ru', items: [{ t: '保存' }, { t: '删除' }] }, { 'x-dsh-auto-translate': '1' }),
    )
    // Ни одна строка не должна попасть в ответ как «перевод».
    assert.deepEqual(json.translations, {})
    assert.equal(json.stats.failed, 2)
    const seed = await call(routes, '/api/dsh-auto-translate/translations', fakeRequest('GET', '/?lang=ru'))
    assert.deepEqual(seed.json.entries, {})
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})
