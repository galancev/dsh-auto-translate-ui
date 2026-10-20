/**
 * Экономичный вызов DeepSeek Flash через сервис `ctx.llm`.
 *
 * Почему именно так:
 * - `prepareCall` с `reasoningEffort: 'off'` отключает рассуждения: для перевода
 *   UI они бесполезны и стоят токенов;
 * - `temperature: 0` делает перевод детерминированным (и позволяет переиспользовать
 *   одинаковые строки в кэше);
 * - в запросе нет истории диалога и инструментов — только фиксированная
 *   инструкция и JSON-массив строк;
 * - лимит вывода считается от длины входа, поэтому не оплачивается «воздух»;
 * - если модель обрезала ответ (`max-tokens`) или вернула невалидный JSON, пачка
 *   дробится пополам и переводится повторно — так строки не теряются, а
 *   переплата остаётся локальной;
 * - сетевые и auth-ошибки провайдера запоминаются на несколько минут, чтобы не
 *   тратить попытки впустую.
 *
 * Сервис `ctx.llm` берётся через `ctx.get('llm')`: внутренние пакеты DSH
 * стороннему плагину не импортируются, поэтому все проверки — защитные.
 * @module dsh-auto-translate-ui/host/llm
 */

import { service } from './util.js'
import {
  buildSystemPrompt,
  buildUserMessage,
  estimateMaxTokens,
  parseTranslationArray,
  normalizeUsage,
} from './batch.js'

/**
 * Ошибка перевода с машинным кодом (текст сообщения не содержит переводимых строк).
 */
export class TranslateError extends Error {
  /**
   * @param {string} code - машинный код.
   * @param {string} message - диагностическое сообщение.
   * @param {Error} [cause] - исходная ошибка.
   */
  constructor(code, message, cause) {
    super(message)
    this.name = 'TranslateError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/** Коды, после которых провайдера нет смысла пробовать несколько минут. */
const PROVIDER_DOWN_CODES = new Set([
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'NO_ADAPTER',
  'QUOTA_EXCEEDED',
  'ACCOUNT_QUOTA_EXCEEDED',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'RATE_LIMIT',
])

/** Сколько держать «провайдер недоступен», мс. */
const PROVIDER_DOWN_MS = 5 * 60 * 1000

/** @type {Map<string, number>} провайдер → момент, до которого его не пробуем */
const providerDownUntil = new Map()

/** @type {Map<string, {at: number, ok: boolean}>} результаты проверки каталога модели */
const eligibilityCache = new Map()

/** Как долго кэшировать положительный и отрицательный вердикт готовности провайдера. */
const ELIGIBLE_TTL_MS = 5 * 60 * 1000
const INELIGIBLE_TTL_MS = 60 * 1000

/**
 * Проверить готовность провайдера к Flash без инференса: каталог моделей должен
 * содержать запрошенную модель. У `deepseek-account` это `GET /models` (до 5 с),
 * поэтому проверка ограничена коротким дедлайном и кэшируется.
 * @param {object} ctx - контекст плагина.
 * @param {string} provider - идентификатор провайдера.
 * @param {string} model - идентификатор модели.
 * @returns {Promise<boolean>} истина, если провайдер готов.
 */
async function eligible(ctx, provider, model) {
  const cached = eligibilityCache.get(provider)
  if (cached !== undefined) {
    const ttl = cached.ok ? ELIGIBLE_TTL_MS : INELIGIBLE_TTL_MS
    if (Date.now() - cached.at < ttl) return cached.ok
  }
  const llm = service(ctx, 'llm')
  let ok = true
  if (llm && typeof llm.listModels === 'function') {
    const timeout = AbortSignal.timeout(1500)
    try {
      const models = await Promise.race([
        llm.listModels(provider),
        new Promise((_, reject) => {
          timeout.addEventListener('abort', () => reject(new Error('models-timeout')), { once: true })
        }),
      ])
      ok = Array.isArray(models) && models.some((row) => (typeof row === 'string' ? row : row?.id) === model)
    } catch {
      // Каталог недоступен/пуст (не выполнен вход, нет ключа) — провайдер не готов.
      ok = false
    }
  }
  eligibilityCache.set(provider, { at: Date.now(), ok })
  return ok
}

/**
 * Доступные провайдеры модели, без сетевых вызовов.
 * @param {object} ctx - контекст плагина.
 * @returns {string[]} идентификаторы зарегистрированных провайдеров.
 */
export function listProviders(ctx) {
  const llm = service(ctx, 'llm')
  if (!llm || typeof llm.listProviders !== 'function') return []
  try {
    return llm
      .listProviders()
      .map((row) => (typeof row === 'string' ? row : row?.id))
      .filter((id) => typeof id === 'string' && id !== '')
  } catch {
    return []
  }
}

/**
 * Порядок провайдеров: явно выбранный, иначе аккаунт DeepSeek, затем официальный API.
 * @param {string[]} available - зарегистрированные провайдеры.
 * @param {string} preference - значение `provider` из конфига.
 * @returns {string[]} провайдеры, которые имеет смысл пробовать.
 */
export function providerOrder(available, preference) {
  const preferred =
    preference === 'auto' || preference === undefined
      ? ['deepseek-account', 'deepseek-official']
      : [preference]
  return preferred.filter((id) => available.includes(id))
}

/**
 * Пометить провайдера временно нерабочим.
 * @param {string} provider - идентификатор.
 * @returns {void}
 */
function markProviderDown(provider) {
  providerDownUntil.set(provider, Date.now() + PROVIDER_DOWN_MS)
}

/**
 * Проверить, что провайдер не помечен нерабочим.
 * @param {string} provider - идентификатор.
 * @returns {boolean} истина, если провайдера можно пробовать.
 */
function providerUp(provider) {
  const until = providerDownUntil.get(provider)
  if (until === undefined) return true
  if (until > Date.now()) return false
  providerDownUntil.delete(provider)
  return true
}

/**
 * Один запрос к модели с отключённым reasoning.
 * @param {object} ctx - контекст плагина.
 * @param {string} provider - идентификатор провайдера.
 * @param {string} model - идентификатор модели.
 * @param {string} system - системная инструкция.
 * @param {string} user - пользовательское сообщение (JSON-массив).
 * @param {object} cfg - конфигурация плагина.
 * @param {AbortSignal} signal - общий сигнал отмены (таймаут + отмена запроса).
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number}}>} сырой ответ.
 */
async function callProvider(ctx, provider, model, system, user, cfg, signal) {
  const llm = service(ctx, 'llm')
  if (!llm || typeof llm.prepareCall !== 'function') throw new TranslateError('llm-unavailable', 'LLM service is not mounted')
  let prepared
  try {
    prepared = await llm.prepareCall(
      {
        provider,
        model,
        reasoningEffort: 'off',
        temperature: 0,
        maxTokens: cfg.maxOutputTokens,
      },
      signal,
    )
  } catch (error) {
    throw new TranslateError('prepare-failed', `prepareCall failed for ${provider}/${model}`, error)
  }
  if (prepared?.config?.reasoningEffort !== 'off' && cfg.allowThinkingFallback !== true) {
    throw new TranslateError('reasoning-not-disabled', 'Provider cannot disable reasoning; economical mode forbids it')
  }
  const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }]
  let text = ''
  let usage = { inputTokens: 0, outputTokens: 0 }
  let terminal
  try {
    // Форма options строго повторяет prepared.config: иначе DSH отвергнет вызов
    // (INVALID_PREPARED_CALL), поэтому добавляем только system/messages/signal.
    const stream = prepared.stream({ ...prepared.config, system, messages, signal })
    for await (const chunk of stream) {
      switch (chunk?.type) {
        case 'text-delta':
          text += chunk.text ?? ''
          break
        case 'usage':
          usage = normalizeUsage(chunk.usage)
          break
        case 'finish':
          terminal = chunk.reason
          break
        case 'reasoning-delta':
          // Модель начала «думать» — это нарушение экономичного режима.
          throw new TranslateError('reasoning-unexpected', 'Provider returned reasoning output')
        case 'tool-call-delta':
          throw new TranslateError('invalid-response', 'Provider returned a tool call')
        default:
          // block-start/block-end не влияют на текст.
          break
      }
    }
  } catch (error) {
    if (error instanceof TranslateError) throw error
    if (signal?.aborted) throw new TranslateError('aborted', 'Translation request was aborted', error)
    throw new TranslateError('request-failed', 'Model request failed', error)
  }
  if (terminal?.kind === 'error') {
    const code = terminal.failure?.code ?? 'request-failed'
    throw new TranslateError(code, `Model request failed: ${code}`)
  }
  if (terminal?.kind === 'aborted') throw new TranslateError('aborted', 'Model request was aborted')
  if (terminal?.kind === 'max-tokens') throw new TranslateError('truncated', 'Model response hit the output limit')
  if (terminal?.kind !== 'stop') throw new TranslateError('invalid-terminal', 'Model request did not finish normally')
  return { text, usage }
}

/**
 * Разбить пачку пополам (для повторного перевода после обрезки/битого JSON).
 * @param {number[]} indexes - индексы исходного массива.
 * @returns {[number[], number[]]} две половины.
 */
function splitIndexes(indexes) {
  const middle = Math.ceil(indexes.length / 2)
  return [indexes.slice(0, middle), indexes.slice(middle)]
}

/**
 * Перевести набор строк одним или несколькими запросами.
 *
 * Возвращает значения, выровненные по входному массиву: `null` означает, что
 * строку перевести не удалось — вызывающий оставит оригинал в UI.
 * @param {object} ctx - контекст плагина.
 * @param {object} cfg - конфигурация плагина.
 * @param {string} lang - целевой язык.
 * @param {string[]} texts - уникальные строки для перевода.
 * @returns {Promise<{values: (string|null)[], usage: {inputTokens: number, outputTokens: number}, provider: string|null, error: string|null}>} результат.
 */
export async function translateTexts(ctx, cfg, lang, texts) {
  const values = new Array(texts.length).fill(null)
  const usage = { inputTokens: 0, outputTokens: 0 }
  if (texts.length === 0) return { values, usage, provider: null, error: null }
  const available = listProviders(ctx)
  const candidates = providerOrder(available, cfg.provider)
  if (candidates.length === 0) return { values, usage, provider: null, error: 'no-provider' }
  const system = buildSystemPrompt(lang)
  const timeout = AbortSignal.timeout(Math.max(1000, cfg.requestTimeoutMs))
  const errors = []
  let providerUsed = null

  /**
   * Перевести подмножество индексов, при необходимости дробя пачку.
   * @param {number[]} indexes - индексы в исходном массиве.
   * @param {number} depth - глубина дробления (защита от рекурсии).
   * @returns {Promise<void>} завершается после заполнения `values`.
   */
  async function run(indexes, depth) {
    if (indexes.length === 0) return
    const batchTexts = indexes.map((index) => texts[index])
    const maxTokens = estimateMaxTokens(batchTexts, cfg.maxOutputTokens)
    let lastError = null
    for (const provider of candidates) {
      if (!providerUp(provider)) continue
      if (!(await eligible(ctx, provider, cfg.model))) {
        markProviderDown(provider)
        errors.push('provider-not-eligible')
        continue
      }
      try {
        const response = await callProvider(ctx, provider, cfg.model, system, buildUserMessage(batchTexts), {
          ...cfg,
          maxOutputTokens: maxTokens,
        }, timeout)
        const parsed = parseTranslationArray(response.text, batchTexts.length)
        if (parsed.error !== null) {
          // Обрезка/битый JSON: сначала пробуем меньшие пачки, а не меняем провайдера.
          if (indexes.length > 1 && depth < 6) {
            for (const half of splitIndexes(indexes)) await run(half, depth + 1)
            return
          }
          throw new TranslateError(parsed.error, `Unparsable model response: ${parsed.error}`)
        }
        parsed.values.forEach((value, position) => {
          values[indexes[position]] = value
        })
        usage.inputTokens += response.usage.inputTokens
        usage.outputTokens += response.usage.outputTokens
        providerUsed = provider
        return
      } catch (error) {
        lastError = error
        if (error?.code === 'truncated' && indexes.length > 1 && depth < 6) {
          for (const half of splitIndexes(indexes)) await run(half, depth + 1)
          return
        }
        if (error?.code === 'aborted') {
          errors.push(error.code)
          return
        }
        if (PROVIDER_DOWN_CODES.has(error?.code)) markProviderDown(provider)
        // Провайдер недоступен/вернул мусор — пробуем следующий.
      }
    }
    errors.push(lastError?.code ?? 'translation-failed')
  }

  await run(
    texts.map((_, index) => index),
    0,
  )
  const failed = values.some((value) => value === null)
  return { values, usage, provider: providerUsed, error: failed ? errors[0] ?? 'translation-failed' : null }
}

/**
 * Диагностическая сводка по LLM: провайдеры и выбранный маршрут.
 * @param {object} ctx - контекст плагина.
 * @param {object} cfg - конфигурация плагина.
 * @returns {{providers: string[], candidates: string[], model: string, reasoningOff: boolean}} сводка.
 */
export function describeLlm(ctx, cfg) {
  const available = listProviders(ctx)
  return {
    providers: available,
    candidates: providerOrder(available, cfg.provider),
    model: cfg.model,
    reasoningOff: true,
  }
}
