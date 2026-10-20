/**
 * Тесты same-origin fence хост-маршрутов: браузер, Electron-оболочка
 * (dsh-app://app), запросы без Origin и cross-site попытки.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTrustedRequest } from '../lib/host/routes.js'

/**
 * Собрать минимальный запрос для проверки fence.
 * @param {object} options - заголовки окружения.
 * @returns {object} фейковый IncomingMessage.
 */
function request({ host = '127.0.0.1:50463', origin, remote = '127.0.0.1', site } = {}) {
  const headers = {}
  if (host !== undefined) headers.host = host
  if (origin !== undefined) headers.origin = origin
  if (site !== undefined) headers['sec-fetch-site'] = site
  return { headers, socket: remote === undefined ? undefined : { remoteAddress: remote } }
}

test('браузер: same-origin запрос доверенный', () => {
  assert.equal(isTrustedRequest(request({ origin: 'http://127.0.0.1:50463' })), true)
})

test('браузер: cross-site Origin отклоняется', () => {
  assert.equal(isTrustedRequest(request({ origin: 'https://evil.example' })), false)
})

test('браузер: Sec-Fetch-Site: cross-site отклоняется даже при совпадении Origin', () => {
  assert.equal(
    isTrustedRequest(request({ origin: 'http://127.0.0.1:50463', site: 'cross-site' })),
    false,
  )
})

test('Electron: Origin dsh-app://app считается доверенным', () => {
  assert.equal(isTrustedRequest(request({ origin: 'dsh-app://app' })), true)
})

test('запрос без Origin с loopback-сокета доверенный (IPC-прокси, навигация)', () => {
  assert.equal(isTrustedRequest(request({ remote: '127.0.0.1' })), true)
  assert.equal(isTrustedRequest(request({ remote: '::1' })), true)
  assert.equal(isTrustedRequest(request({ remote: '::ffff:127.0.0.1' })), true)
})

test('запрос без Origin, Host и сокета отклоняется', () => {
  assert.equal(isTrustedRequest({ headers: {} }), false)
})

test('удалённый клиент с нелокальным Host отклоняется', () => {
  assert.equal(isTrustedRequest(request({ host: '192.168.1.20:50463', remote: '192.168.1.50' })), false)
})

test('удалённый клиент, обращающийся к loopback Host, но не к loopback-сокету, отклоняется', () => {
  assert.equal(isTrustedRequest(request({ host: '127.0.0.1:50463', remote: '10.0.0.5' })), false)
})

test('битый Origin отклоняется', () => {
  assert.equal(isTrustedRequest(request({ origin: 'not a url' })), false)
})
