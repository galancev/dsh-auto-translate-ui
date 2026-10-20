/**
 * Схема конфигурации плагина и чтение «живых» значений.
 *
 * Все поля помечены `.volatile()`: только такие поля DSH-настройки показывают
 * в сгенерированной форме плагина и коммитят в работающий инстанс без
 * перемонтирования. Поэтому значения читаются через {@link resolveConfig}
 * в момент обработки запроса, а не кэшируются при старте.
 * @module dsh-auto-translate-ui/host/config
 */

import z from '@deepseek-ai/schemastery'

/** Имена «экзотических» письменностей, которые клиент ищет в UI по умолчанию. */
export const SCRIPT_GROUPS = [
  'cjk', // китайские иероглифы (включая расширения)
  'kana', // хирагана/катакана
  'hangul', // корейский
  'thai',
  'devanagari',
  'arabic',
  'hebrew',
  'greek',
  'other', // остальные нелатинские блоки (армянский, грузинский, кхмерский и т.п.)
]

/** Селекторы, внутри которых перевод UI-текста не выполняется. */
export const DEFAULT_SKIP_SELECTORS = [
  'pre',
  'code',
  'kbd',
  'samp',
  'script',
  'style',
  'noscript',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[data-no-translate]',
  '[data-dsh-translate-skip]',
  '[translate="no"]',
  '.no-translate',
  '.markdown-body',
  '.chat-message',
]

/**
 * Схема конфигурации. Экспортируется из точки входа плагина: по ней DSH
 * валидирует секцию профиля и генерирует страницу настроек.
 */
export const Config = z.object({
  /** Главный выключатель автоперевода. */
  enabled: z.boolean().default(true).volatile(),
  /** Язык перевода: auto — активный язык интерфейса. */
  targetLanguage: z.union(['auto', 'ru', 'en']).default('auto').volatile(),
  /** Провайдер модели: auto — первый доступный DeepSeek. */
  provider: z.union(['auto', 'deepseek-account', 'deepseek-official']).default('auto').volatile(),
  /** Идентификатор модели; Flash — самый дешёвый вариант. */
  model: z.string().default('deepseek-flash').volatile(),
  /** Сколько строк отправлять в одном запросе к модели. */
  maxBatchItems: z.natural().min(1).max(200).default(24).volatile(),
  /** Верхняя граница суммарной длины строк в одном запросе, символов. */
  maxBatchChars: z.natural().min(100).max(20000).default(1200).volatile(),
  /** Строки длиннее этого лимита не переводятся (обычно это контент, не UI). */
  maxTextChars: z.natural().min(20).max(4000).default(320).volatile(),
  /** Лимит выходных токенов на один запрос. */
  maxOutputTokens: z.natural().min(64).max(16384).default(2048).volatile(),
  /** Таймаут одного запроса к модели, мс. */
  requestTimeoutMs: z.natural().min(1000).max(300000).default(45000).volatile(),
  /** Пауза накопления строк перед отправкой, мс. */
  debounceMs: z.natural().min(50).max(5000).default(300).volatile(),
  /** Область перевода: ui — только интерфейс, all — включая содержимое чата. */
  scope: z.union(['ui', 'all']).default('ui').volatile(),
  /** Письменности, которые считаются «иностранными» и переводятся. */
  includeScripts: z
    .array(z.union(SCRIPT_GROUPS))
    .default([...SCRIPT_GROUPS])
    .volatile(),
  /** Считать иностранным и латинский текст с диакритикой (немецкий, польский…). */
  latinDetection: z.boolean().default(false).volatile(),
  /** HTML-атрибуты, значения которых тоже переводятся. */
  translateAttributes: z
    .array(z.string())
    .default(['placeholder', 'title', 'aria-label', 'alt'])
    .volatile(),
  /** Дополнительные селекторы-исключения. */
  skipSelectors: z.array(z.string()).default([...DEFAULT_SKIP_SELECTORS]).volatile(),
  /** Каталог кэша; пусто — $DSH_HOME/cache/dsh-auto-translate. */
  cacheDir: z.string().default('').volatile(),
  /** Срок жизни записи кэша, дней. */
  cacheTtlDays: z.natural().min(1).max(3650).default(180).volatile(),
  /** Максимум записей в кэше одного языка. */
  maxCacheEntries: z.natural().min(100).max(500000).default(20000).volatile(),
  /** Как долго не повторять неудачный перевод, минут. */
  negativeCacheMinutes: z.natural().min(0).max(1440).default(10).volatile(),
  /** Отдавать ли клиенту весь кэш при загрузке страницы (быстрый первый рендер). */
  seedOnStart: z.boolean().default(true).volatile(),
  /** Разрешать модели «думать», если провайдер не умеет полностью отключить reasoning. */
  allowThinkingFallback: z.boolean().default(false).volatile(),
  /** Уровень логирования плагина. */
  logLevel: z.union(['off', 'error', 'warn', 'info', 'debug']).default('info').volatile(),
})

/** Значения по умолчанию, повторяющие схему (нужны, когда config не передан). */
const FALLBACKS = {
  enabled: true,
  targetLanguage: 'auto',
  provider: 'auto',
  model: 'deepseek-flash',
  maxBatchItems: 24,
  maxBatchChars: 1200,
  maxTextChars: 320,
  maxOutputTokens: 2048,
  requestTimeoutMs: 45000,
  debounceMs: 300,
  scope: 'ui',
  includeScripts: [...SCRIPT_GROUPS],
  latinDetection: false,
  translateAttributes: ['placeholder', 'title', 'aria-label', 'alt'],
  skipSelectors: [...DEFAULT_SKIP_SELECTORS],
  cacheDir: '',
  cacheTtlDays: 180,
  maxCacheEntries: 20000,
  negativeCacheMinutes: 10,
  seedOnStart: true,
  allowThinkingFallback: false,
  logLevel: 'info',
}

/**
 * Прочитать значение поля конфига: volatile-поля приходят «живыми» ссылками
 * с методом `get()`, обычные — готовыми значениями.
 * @param {unknown} raw - значение из конфига.
 * @param {unknown} fallback - значение по умолчанию.
 * @returns {unknown} актуальное значение.
 */
function readValue(raw, fallback) {
  if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      const live = raw.get()
      return live === undefined ? fallback : live
    } catch {
      return fallback
    }
  }
  return raw === undefined ? fallback : raw
}

/**
 * Собрать актуальные значения конфига с подстановкой значений по умолчанию.
 * @param {object|undefined} config - конфиг, переданный загрузчиком профиля.
 * @returns {object} разрешённая конфигурация.
 */
export function resolveConfig(config) {
  const out = {}
  for (const [key, fallback] of Object.entries(FALLBACKS)) {
    out[key] = readValue(config?.[key], fallback)
  }
  // Защита от мусора после ручных правок cordis.patch.yml.
  if (!Array.isArray(out.includeScripts) || out.includeScripts.length === 0) out.includeScripts = [...SCRIPT_GROUPS]
  if (!Array.isArray(out.translateAttributes)) out.translateAttributes = ['placeholder', 'title', 'aria-label', 'alt']
  if (!Array.isArray(out.skipSelectors)) out.skipSelectors = [...DEFAULT_SKIP_SELECTORS]
  if (typeof out.cacheDir !== 'string') out.cacheDir = ''
  return out
}
