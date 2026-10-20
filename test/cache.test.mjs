/**
 * Тесты кэша переводов: версии плагинов, снимок для клиента, сохранение.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranslationCache, defaultCacheDir } from '../lib/host/cache.js'

const log = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * Создать кэш во временном каталоге.
 * @param {object} [options] - переопределения.
 * @returns {Promise<{cache: TranslationCache, dir: string}>} кэш и каталог.
 */
async function makeCache(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-translate-test-'))
  const cache = new TranslationCache({ dir, lang: 'ru', ttlDays: 30, maxEntries: 100, log, ...options })
  await cache.load()
  return { cache, dir }
}

test('кэш возвращает перевод, пока версия плагина не изменилась', async () => {
  const { cache, dir } = await makeCache()
  try {
    cache.remember('Сохранить', 'Save', { 'dsh-example': '1.0.0' })
    const versions = new Map([['dsh-example', '1.0.0']])
    assert.deepEqual(cache.lookup('Сохранить', versions), { dst: 'Save' })
    const updated = new Map([['dsh-example', '2.0.0']])
    assert.equal(cache.lookup('Сохранить', updated), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('строка без владельца не инвалидируется версиями', async () => {
  const { cache, dir } = await makeCache()
  try {
    cache.remember('保存', 'Сохранить', undefined)
    assert.deepEqual(cache.lookup('保存', new Map([['dsh-example', '9.9.9']])), { dst: 'Сохранить' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('adopt дописывает владельца без перезапроса перевода', async () => {
  const { cache, dir } = await makeCache()
  try {
    cache.remember('删除', 'Удалить', { 'pkg-a': '1.0.0' })
    cache.adopt('删除', { 'pkg-b': '0.1.0' })
    const versions = new Map([
      ['pkg-a', '1.0.0'],
      ['pkg-b', '0.1.0'],
    ])
    assert.deepEqual(cache.lookup('删除', versions), { dst: 'Удалить' })
    // Обновление второго владельца инвалидирует общую запись.
    assert.equal(cache.lookup('删除', new Map([['pkg-b', '0.2.0']])), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('снимок отдаёт только свежие записи', async () => {
  const { cache, dir } = await makeCache()
  try {
    cache.remember('a', 'A', { 'pkg-a': '1.0.0' })
    cache.remember('b', 'B', { 'pkg-b': '1.0.0' })
    cache.remember('c', 'C', undefined)
    const seed = cache.seed(new Map([['pkg-a', '1.0.0'], ['pkg-b', '2.0.0']]))
    assert.deepEqual(seed.entries, { a: 'A', c: 'C' })
    assert.equal(seed.skipped, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('негативный кэш не повторяет недавнюю неудачу', async () => {
  const { cache, dir } = await makeCache()
  try {
    cache.rememberMiss('плохая строка', 60_000)
    assert.equal(cache.isMiss('плохая строка'), true)
    assert.equal(cache.isMiss('другая строка'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('кэш сохраняется на диск и читается после перезапуска', async () => {
  const { cache, dir } = await makeCache()
  try {
    cache.remember('Отмена', 'Cancel', { 'pkg-a': '1.0.0' })
    await cache.flush()
    const text = await readFile(cache.file, 'utf8')
    assert.match(text, /Cancel/)
    const restored = new TranslationCache({ dir, lang: 'ru', ttlDays: 30, maxEntries: 100, log })
    await restored.load()
    assert.deepEqual(restored.lookup('Отмена', new Map([['pkg-a', '1.0.0']])), { dst: 'Cancel' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('повреждённый файл кэша не роняет загрузку', async () => {
  const { cache, dir } = await makeCache()
  try {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(cache.file, '{битый json', 'utf8')
    const broken = new TranslationCache({ dir, lang: 'ru', ttlDays: 30, maxEntries: 100, log })
    await broken.load()
    assert.equal(broken.describe().entries, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('forgetAll очищает кэш и файл', async () => {
  const { cache, dir } = await makeCache()
  try {
    cache.remember('a', 'A', { pkg: '1' })
    assert.equal(await cache.forgetAll(), 1)
    const restored = new TranslationCache({ dir, lang: 'ru', ttlDays: 30, maxEntries: 100, log })
    await restored.load()
    assert.equal(restored.describe().entries, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('defaultCacheDir учитывает override, DSH_HOME и домашний каталог', () => {
  const previous = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.equal(
      defaultCacheDir('', '/home/user').replace(/\\/g, '/'),
      '/home/user/.dsh/cache/dsh-auto-translate',
    )
    process.env.DSH_HOME = '/tmp/dsh'
    assert.equal(defaultCacheDir('', '/home/user').replace(/\\/g, '/'), '/tmp/dsh/cache/dsh-auto-translate')
    assert.equal(defaultCacheDir('/opt/cache', '/home/user').replace(/\\/g, '/'), '/opt/cache')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
