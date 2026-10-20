/**
 * Поведенческие тесты клиентской половины в jsdom: перехват translate,
 * DOM-слой, анти-эхо, исключения и применение снимка кэша.
 *
 * Настоящий браузер в песочнице агента недоступен, поэтому здесь эмулируются
 * ровно те глобалы, которые использует бандл (document, MutationObserver,
 * NodeFilter, fetch, window.__ModuleLoader__).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

/** Дождаться макротаски (даёт отработать debounce-таймерам клиента). */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Создать окружение: JSDOM, поддельный fetch, локал-сервис и загрузку бандла.
 * @param {object} options - настройки сценария.
 * @returns {Promise<object>} окружение и диспозер.
 */
async function setup({ html = '<p id="label">保存</p>', config = {}, seed = {}, translate = {} } = {}) {
  const dom = new JSDOM(`<html lang="ru"><head><title>t</title></head><body>${html}</body></html>`, {
    url: 'http://127.0.0.1:51999/',
  })
  const requests = []
  const fetchStub = async (url, init = {}) => {
    const body = init.body === undefined ? null : JSON.parse(String(init.body))
    requests.push({ url: String(url), body })
    if (String(url).includes('/config')) {
      return jsonResponse({
        config: {
          enabled: true,
          targetLanguage: 'auto',
          scope: 'ui',
          includeScripts: ['cjk', 'kana', 'hangul', 'thai', 'devanagari', 'arabic', 'hebrew', 'greek', 'other'],
          latinDetection: false,
          translateAttributes: ['placeholder', 'title', 'aria-label', 'alt'],
          skipSelectors: ['pre', 'code', '[data-no-translate]'],
          debounceMs: 20,
          maxTextChars: 200,
          maxBatchItems: 10,
          seedOnStart: true,
          ...config,
        },
      })
    }
    if (String(url).includes('/translations')) return jsonResponse({ lang: 'ru', entries: seed, total: Object.keys(seed).length })
    if (String(url).includes('/translate')) {
      const result = {}
      for (const item of body?.items ?? []) {
        const value = translate[item.t]
        if (typeof value === 'string') result[item.t] = value
      }
      return jsonResponse({ lang: 'ru', translations: result, stats: {}, error: null })
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  const created = []
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.NodeFilter = dom.window.NodeFilter
  globalThis.MutationObserver = dom.window.MutationObserver
  globalThis.fetch = fetchStub
  dom.window.fetch = fetchStub

  const registrations = []
  dom.window.__ModuleLoader__ = {
    load(registration) {
      registrations.push(registration)
    },
  }
  await import(new URL(`../lib/client.js?dom=${Date.now()}-${Math.random()}`, import.meta.url))
  const factory = registrations[0].factory
  const client = factory(() => {
    throw new Error('client bundle must not require modules')
  })

  const dictionary = {}
  const disposers = []
  const locale = {
    getSnapshot: () => ({ active: 'ru', locales: [{ id: 'ru' }, { id: 'en' }], revision: 1 }),
    getLocale() {
      return this.getSnapshot()
    },
    subscribe: () => () => {},
    translate(ns, key) {
      return dictionary[key] ?? key
    },
  }
  const ctx = {
    locale,
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    inject(_names, callback) {
      return callback(ctx)
    },
    get: () => undefined,
  }
  created.push({ locale, dictionary })
  const disposeAll = () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* остановка не должна падать */
      }
    }
  }
  client.apply(ctx)
  return { dom, requests, client, locale, dictionary, disposeAll }
}

/**
 * Обёртка ответа fetch.
 * @param {object} payload - JSON-тело.
 * @returns {Promise<object>} ответ с json().
 */
async function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload
    },
  }
}

test('снимок кэша применяется к уже отрисованному DOM', async () => {
  const env = await setup({ html: '<p id="label">保存</p>', seed: { 保存: 'Сохранить' } })
  try {
    await tick(120)
    assert.equal(env.dom.window.document.querySelector('#label').textContent, 'Сохранить')
  } finally {
    env.disposeAll()
    env.dom.window.close()
  }
})

test('переводы недостающих строк запрашиваются и применяются', async () => {
  const env = await setup({
    html: '<button id="b">取消</button>',
    translate: { 取消: 'Отмена' },
  })
  try {
    await tick(220)
    assert.equal(env.dom.window.document.querySelector('#b').textContent, 'Отмена')
    assert.ok(env.requests.some((request) => request.url.includes('/translate')))
  } finally {
    env.disposeAll()
    env.dom.window.close()
  }
})

test('атрибуты placeholder/title переводятся', async () => {
  const env = await setup({
    html: '<input id="i" placeholder="输入名称" title="提示" />',
    translate: { 输入名称: 'Введите имя', 提示: 'Подсказка' },
  })
  try {
    await tick(260)
    const input = env.dom.window.document.querySelector('#i')
    assert.equal(input.getAttribute('placeholder'), 'Введите имя')
    assert.equal(input.getAttribute('title'), 'Подсказка')
  } finally {
    env.disposeAll()
    env.dom.window.close()
  }
})

test('обёртка locale.translate отдаёт известный перевод синхронно', async () => {
  const env = await setup({ html: '<div></div>', translate: { 确认: 'Подтвердить' } })
  try {
    // Даём плагину загрузить конфиг и включиться.
    await tick(120)
    assert.equal(env.locale.translate('demo', '确认'), '确认')
    await tick(240)
    assert.equal(env.locale.translate('demo', '确认'), 'Подтвердить')
  } finally {
    env.disposeAll()
    env.dom.window.close()
  }
})

test('области-исключения (pre, data-no-translate) не переводятся', async () => {
  const env = await setup({
    html: `
      <pre id="code">保存代码</pre>
      <div data-no-translate id="keep">删除</div>
      <p id="ui">确认</p>
    `,
    translate: { 确认: 'Подтвердить', 删除: 'Удалить', 保存代码: 'X' },
  })
  try {
    await tick(260)
    const doc = env.dom.window.document
    assert.equal(doc.querySelector('#code').textContent, '保存代码')
    assert.equal(doc.querySelector('#keep').textContent, '删除')
    assert.equal(doc.querySelector('#ui').textContent, 'Подтвердить')
  } finally {
    env.disposeAll()
    env.dom.window.close()
  }
})

test('анти-эхо: собственная запись в DOM не вызывает повторный запрос', async () => {
  const env = await setup({ html: '<p id="p">保存</p>', translate: { 保存: 'Сохранить' } })
  try {
    await tick(260)
    const translateRequests = env.requests.filter((request) => request.url.includes('/translate'))
    assert.equal(translateRequests.length, 1)
    // Повторный скан после нашей же записи не должен порождать новых запросов.
    await tick(200)
    assert.equal(env.requests.filter((request) => request.url.includes('/translate')).length, 1)
    assert.equal(env.dom.window.document.querySelector('#p').textContent, 'Сохранить')
  } finally {
    env.disposeAll()
    env.dom.window.close()
  }
})

test('выключенный плагин не трогает DOM и не шлёт запросы', async () => {
  const env = await setup({ html: '<p id="p">保存</p>', config: { enabled: false }, translate: { 保存: 'Сохранить' } })
  try {
    await tick(200)
    assert.equal(env.dom.window.document.querySelector('#p').textContent, '保存')
    assert.equal(env.requests.filter((request) => request.url.includes('/translate')).length, 0)
  } finally {
    env.disposeAll()
    env.dom.window.close()
  }
})

test('новые узлы (SPA-рендер) переводятся по MutationObserver', async () => {
  const env = await setup({ html: '<div id="root"></div>', translate: { 关闭: 'Закрыть' } })
  try {
    await tick(120)
    const doc = env.dom.window.document
    const node = doc.createElement('span')
    node.textContent = '关闭'
    doc.querySelector('#root').appendChild(node)
    await tick(260)
    assert.equal(doc.querySelector('#root span').textContent, 'Закрыть')
  } finally {
    env.disposeAll()
    env.dom.window.close()
  }
})

test('scope=ui: лента чата не переводится, остальной UI переводится', async () => {
  const html = `
    <div data-chat-flow="1">
      <div data-chat-turn="1">
        <div data-chat-node-key="assistant">
          <p id="chat">保存</p>
          <input id="chat-input" placeholder="删除" />
        </div>
      </div>
    </div>
    <button id="ui">确认</button>
  `
  const env = await setup({
    html,
    translate: { 保存: 'Сохранить', 删除: 'Удалить', 确认: 'Подтвердить' },
  })
  try {
    await tick(260)
    const doc = env.dom.window.document
    assert.equal(doc.querySelector('#chat').textContent, '保存')
    assert.equal(doc.querySelector('#chat-input').getAttribute('placeholder'), '删除')
    assert.equal(doc.querySelector('#ui').textContent, 'Подтвердить')
  } finally {
    env.disposeAll()
    env.dom.window.close()
  }
})

test('scope=all: лента чата переводится', async () => {
  const html = `
    <div data-chat-flow="1"><div data-chat-turn="1"><p id="chat">保存</p></div></div>
  `
  const env = await setup({
    html,
    config: { scope: 'all' },
    translate: { 保存: 'Сохранить' },
  })
  try {
    await tick(260)
    assert.equal(env.dom.window.document.querySelector('#chat').textContent, 'Сохранить')
  } finally {
    env.disposeAll()
    env.dom.window.close()
  }
})
