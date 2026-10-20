/**
 * Тесты клиентской половины: определение иностранных строк, манифест пакета,
 * формат клиентского бандла.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Загрузить клиентский бандл в Node с поддельным модульным загрузчиком.
 * @returns {Promise<object>} module.exports клиентского модуля.
 */
async function loadClientBundle() {
  /** @type {Array<{id: string, factory: Function}>} */
  const registrations = []
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      },
    },
  }
  await import(new URL(`../lib/client.js?test=${Date.now()}`, import.meta.url))
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-auto-translate-ui')
  const factory = registrations[0].factory
  // Фабрика ждёт CJS-подобный require; клиентскому бандлу он не нужен.
  const exported = factory(() => {
    throw new Error('клиентский бандл не должен требовать модули')
  })
  assert.equal(typeof exported, 'object')
  delete globalThis.window
  return exported
}

test('клиентский модуль объявляет apply и inject', async () => {
  const client = await loadClientBundle()
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['locale'])
})

test('определяет китайский, японский, корейский и прочие письменности', async () => {
  const { isForeign } = (await loadClientBundle()).__internals
  const cfg = {
    includeScripts: ['cjk', 'kana', 'hangul', 'thai', 'devanagari', 'arabic', 'hebrew', 'greek', 'other'],
    latinDetection: false,
  }
  assert.equal(isForeign('保存更改', cfg), true)
  assert.equal(isForeign('キャンセル', cfg), true)
  assert.equal(isForeign('취소', cfg), true)
  assert.equal(isForeign('ยกเลิก', cfg), true)
  assert.equal(isForeign('إلغاء', cfg), true)
  assert.equal(isForeign('Сохранить', cfg), false)
  assert.equal(isForeign('Save changes', cfg), false)
  // Без диакритики латиница считается английской.
  assert.equal(isForeign('Speichern', cfg), false)
})

test('latinDetection включает перевод латиницы с диакритикой', async () => {
  const { isForeign } = (await loadClientBundle()).__internals
  const cfg = { includeScripts: ['cjk'], latinDetection: true }
  assert.equal(isForeign('Änderungen speichern', cfg), true)
  assert.equal(isForeign('Save changes', cfg), false)
})

test('отсеивает код, URL и идентификаторы', async () => {
  const { isLikelyCode } = (await loadClientBundle()).__internals
  assert.equal(isLikelyCode('https://example.com/保存'), true)
  assert.equal(isLikelyCode('abc123def456'), true)
  assert.equal(isLikelyCode('1.2.3'), true)
  assert.equal(isLikelyCode('保存更改'), false)
  assert.equal(isLikelyCode('Сохранить'), false)
})

test('манифест пакета объявляет клиентскую половину и bundle-патч', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-locale'])
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  await access(join(root, manifest.exports['.'].default))
  await access(join(root, manifest.exports['./client'].default))
  await access(join(root, manifest.dsh.bundle.patch))
})

test('bundle-патч вставляет строку плагина с ожидаемым id', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*auto-translate-ui/)
  assert.match(patch, /name:\s*dsh-auto-translate-ui/)
})
