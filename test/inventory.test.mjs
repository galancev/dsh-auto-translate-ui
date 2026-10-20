/**
 * Тесты инвентаря: извлечение пространств имён из клиентских бандлов.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractNamespaces, namespaceCandidates } from '../lib/host/inventory.js'

test('находит пространства имён из прямой строки в locale.register', () => {
  const code = `ctx.locale.register('git-graph', { zh, en })`
  assert.deepEqual(extractNamespaces(code), ['git-graph'])
})

test('находит пространства имён через переменную-литерал', () => {
  const code = `
    const NS = 'settings.pluginInventory'
    ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  `
  assert.deepEqual(extractNamespaces(code), ['settings.pluginInventory'])
})

test('находит несколько пространств имён без дублей', () => {
  const code = `
    const A = "one"
    const B = \`two\`
    locale.register(A, { en })
    locale.register('three', { en })
    locale.register(B, { en })
    locale.register('one', { en })
  `
  assert.deepEqual(extractNamespaces(code).sort(), ['one', 'three', 'two'])
})

test('игнорирует динамические и подозрительные аргументы', () => {
  const code = `
    const ns = getDynamic()
    ctx.locale.register(ns, { en })
    ctx.locale.register(someFunction(), { en })
    ctx.locale.register('', { en })
    ctx.locale.register('with space', { en })
  `
  assert.deepEqual(extractNamespaces(code), [])
})

test('не путает посторонние register с locale.register', () => {
  const code = `registry.register('component', factory)`
  assert.deepEqual(extractNamespaces(code), [])
})

test('эвристика кандидатов по имени пакета', () => {
  assert.deepEqual(namespaceCandidates('@scope/dsh-better-sidebar'), [
    'dsh-better-sidebar',
    'better-sidebar',
    'better.sidebar',
    'settings.better-sidebar',
  ])
})
