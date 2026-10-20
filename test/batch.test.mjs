/**
 * Тесты чистых функций батч-перевода: планирование пачек, промпт, разбор ответа.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSystemPrompt,
  buildUserMessage,
  estimateMaxTokens,
  normalizeUsage,
  parseTranslationArray,
  planBatches,
  sanitizeText,
} from '../lib/host/batch.js'

test('sanitizeText схлопывает пробелы и срезает невидимые символы', () => {
  assert.equal(sanitizeText('  Сохранить\u200b\n изменения  '), 'Сохранить изменения')
  assert.equal(sanitizeText(null), '')
  assert.equal(sanitizeText('a\u0000b'), 'a b')
})

test('planBatches уважает лимиты числа строк и символов', () => {
  const texts = ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10), 'd'.repeat(10)]
  const batches = planBatches(texts, { maxBatchItems: 2, maxBatchChars: 1000 })
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [2, 2],
  )
  const byChars = planBatches(texts, { maxBatchItems: 10, maxBatchChars: 25 })
  assert.deepEqual(
    byChars.map((batch) => batch.length),
    [2, 2],
  )
  // Одна длинная строка больше лимита всё равно попадает в свою пачку.
  assert.deepEqual(planBatches(['x'.repeat(100)], { maxBatchItems: 4, maxBatchChars: 10 }), [[0]])
})

test('промпт стабилен для одного языка (KV-кэш провайдера) и называет язык', () => {
  assert.equal(buildSystemPrompt('ru'), buildSystemPrompt('ru'))
  assert.match(buildSystemPrompt('ru'), /Russian/)
  assert.match(buildSystemPrompt('en'), /English/)
  assert.notEqual(buildSystemPrompt('ru'), buildSystemPrompt('en'))
})

test('сообщение пользователя — компактный JSON-массив исходных строк', () => {
  const message = buildUserMessage(['Сохранить', 'Удалить "файл"'])
  assert.deepEqual(JSON.parse(message), ['Сохранить', 'Удалить "файл"'])
})

test('лимит вывода растёт от длины входа и не превышает жёсткий лимит', () => {
  const short = estimateMaxTokens(['', ''], 2048)
  assert.ok(short >= 64)
  assert.ok(short < 200)
  assert.equal(estimateMaxTokens(['x'.repeat(5000)], 2048), 2048)
})

test('parseTranslationArray разбирает валидный JSON и снимает кавычки', () => {
  const parsed = parseTranslationArray('["Сохранить","Удалить"]', 2)
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.values, ['Сохранить', 'Удалить'])
})

test('parseTranslationArray переживает markdown-обёртку и преамбулу', () => {
  const raw = 'Вот перевод:\n```json\n["Сохранить","Отмена"]\n```'
  const parsed = parseTranslationArray(raw, 2)
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.values, ['Сохранить', 'Отмена'])
})

test('parseTranslationArray сообщает о несовпадении длины', () => {
  const parsed = parseTranslationArray('["a"]', 2)
  assert.equal(parsed.error, 'length-mismatch:1/2')
  assert.deepEqual(parsed.values, [null, null])
})

test('parseTranslationArray сообщает о битом JSON и пустом ответе', () => {
  assert.equal(parseTranslationArray('не json', 1).error, 'no-json-array')
  assert.equal(parseTranslationArray('[1,2', 2).error, 'no-json-array')
  assert.equal(parseTranslationArray('', 1).error, 'empty-response')
  assert.equal(parseTranslationArray('null', 1).error, 'no-json-array')
})

test('parseTranslationArray помечает нестроковые элементы как null', () => {
  const parsed = parseTranslationArray('["ok", 3, null]', 3)
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.values, ['ok', null, null])
})

test('normalizeUsage понимает разные имена полей адаптеров', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 10, outputTokens: 20 }), { inputTokens: 10, outputTokens: 20 })
  assert.deepEqual(normalizeUsage({ prompt_tokens: 5, completion_tokens: 7 }), { inputTokens: 5, outputTokens: 7 })
  assert.deepEqual(normalizeUsage(undefined), { inputTokens: 0, outputTokens: 0 })
})
