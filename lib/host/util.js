/**
 * Мелкие утилиты хост-половины: безопасный доступ к сервисам Cordis,
 * стабильный хэш текста, отложенные записи и логирование.
 *
 * Плагин устанавливается в профиль пользователя, поэтому намеренно не тянет
 * внутренние пакеты DSH (`@deepseek-ai/dsh-*`): все сервисы берутся через
 * `ctx.get(...)`, а недостающие примитивы реализованы локально.
 * @module dsh-auto-translate-ui/host/util
 */

import { createHash } from 'node:crypto'

/**
 * Прочитать сервис Cordis, не падая при его отсутствии.
 * @param {object} ctx - контекст плагина.
 * @param {string} name - имя сервиса.
 * @returns {unknown} сервис или undefined.
 */
export function service(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * Стабильный короткий хэш строки: ключ записи кэша.
 * @param {string} text - нормализованный исходный текст.
 * @returns {string} 32 шестнадцатеричных символа sha256.
 */
export function textHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Нормализация исходного текста для ключа кэша: обрезка и схлопывание
 * пробельных серий. Перевод применяется к нормализованной форме.
 * @param {string} text - текст из UI.
 * @returns {string} нормализованная строка.
 */
export function normalizeSource(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Ограниченное ожидание.
 * @param {number} ms - миллисекунды.
 * @returns {Promise<void>} завершается по таймеру.
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Проверка, что значение является непустым объектом (не массивом).
 * @param {unknown} value - проверяемое значение.
 * @returns {boolean} истина для plain-объекта.
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Логгер плагина. `ctx.logger` есть не во всех композициях, поэтому при его
 * отсутствии пишем в console с префиксом; уровень регулируется конфигом.
 * @param {object} ctx - контекст плагина.
 * @param {() => string} levelOf - функция текущего уровня логирования.
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }} логгер.
 */
export function createLogger(ctx, levelOf) {
  const base = (() => {
    try {
      return ctx?.logger
    } catch {
      return undefined
    }
  })()
  const rank = { off: 0, error: 1, warn: 2, info: 3, debug: 4 }
  const enabled = (level) => (rank[levelOf?.() ?? 'info'] ?? 3) >= (rank[level] ?? 3)
  const emit = (level, args) => {
    if (!enabled(level)) return
    try {
      const fn = typeof base?.[level] === 'function' ? base[level].bind(base) : undefined
      fn?.('[dsh-auto-translate-ui]', ...args)
      // В продуктовых профилях у ctx.logger может не быть console-экспортёра,
      // поэтому предупреждения и ошибки дополнительно видны в stderr.
      if ((level === 'warn' || level === 'error') && fn !== undefined) {
        console[level]?.('[dsh-auto-translate-ui]', ...args)
      } else if (fn === undefined) {
        console[level]?.('[dsh-auto-translate-ui]', ...args)
      }
    } catch {
      /* логирование не должно ломать плагин */
    }
  }
  return {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
  }
}
