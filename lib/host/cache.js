/**
 * Локальный кэш переводов.
 *
 * Требования, которые определяют структуру:
 * - кэш лежит на диске в домашнем каталоге DSH, а не в localStorage, и
 *   переживает перезапуск приложения;
 * - запись «привязана» к пакетам-владельцам строк и их версиям: после
 *   обновления плагина его строки переводятся заново, а строки остальных
 *   плагинов остаются в кэше;
 * - файл пишется атомарно (tmp + rename), чтобы обрыв процесса не оставил
 *   битый JSON;
 * - все записи одного языка — в одном файле, запись отложенная и сериализованная.
 * @module dsh-auto-translate-ui/host/cache
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { textHash, normalizeSource, delay } from './util.js'

/** Версия формата файла кэша: несовпадение означает сброс. */
const SCHEMA = 1

/** Задержка отложенной записи на диск, мс. */
const SAVE_DELAY_MS = 800

/**
 * Кэш переводов для одного целевого языка.
 */
export class TranslationCache {
  /**
   * @param {object} options - параметры кэша.
   * @param {string} options.dir - каталог кэша (создаётся при записи).
   * @param {string} options.lang - целевой язык (например, `ru`).
   * @param {number} options.ttlDays - срок жизни записи в днях.
   * @param {number} options.maxEntries - максимум записей.
   * @param {{warn: Function, info: Function}} options.log - логгер.
   */
  constructor({ dir, lang, ttlDays, maxEntries, log }) {
    this.dir = dir
    this.lang = lang
    this.ttlDays = ttlDays
    this.maxEntries = maxEntries
    this.log = log
    /** @type {Map<string, {src: string, dst: string, owners: Record<string,string>, ts: number, used: number}>} */
    this.entries = new Map()
    /** Негативный кэш: текст, который не удалось перевести, не повторяем сразу. */
    this.misses = new Map()
    this.stats = {
      batches: 0,
      inputTokens: 0,
      outputTokens: 0,
      translated: 0,
      failed: 0,
      hits: 0,
      seeded: 0,
      startedAt: new Date().toISOString(),
    }
    this.loaded = false
    this.dirty = false
    this.saveTimer = null
    this.saveChain = Promise.resolve()
  }

  /** Путь к файлу кэша этого языка. */
  get file() {
    return join(this.dir, `translations.${this.lang}.json`)
  }

  /**
   * Прочитать кэш с диска. Ошибки не фатальны: повреждённый файл уводится в
   * сторону, работа продолжается с пустым кэшем.
   * @returns {Promise<void>} завершается после загрузки.
   */
  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      if (raw?.schema !== SCHEMA || raw?.lang !== this.lang || typeof raw?.entries !== 'object') {
        this.log?.warn?.(`cache: файл ${this.file} несовместим, начинаю с пустого кэша`)
        return
      }
      for (const [hash, entry] of Object.entries(raw.entries)) {
        if (!entry || typeof entry.src !== 'string' || typeof entry.dst !== 'string') continue
        this.entries.set(hash, {
          src: entry.src,
          dst: entry.dst,
          owners: typeof entry.owners === 'object' && entry.owners !== null ? entry.owners : {},
          ts: Number(entry.ts) || Date.now(),
          used: Number(entry.used) || Number(entry.ts) || Date.now(),
        })
      }
      if (raw.stats && typeof raw.stats === 'object') this.stats = { ...this.stats, ...raw.stats }
      this.prune({ save: false })
      this.log?.info?.(`cache: загружено ${this.entries.size} переводов (${this.lang})`)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      this.log?.warn?.(`cache: не удалось прочитать ${this.file}:`, error?.message ?? error)
    }
  }

  /**
   * Проверить, «свежа» ли запись относительно текущих версий пакетов.
   * @param {{owners: Record<string,string>}|undefined} entry - запись кэша.
   * @param {Map<string,string>} versions - текущие версии пакетов.
   * @returns {boolean} истина, если ни один известный владелец не изменился.
   */
  static isFresh(entry, versions) {
    if (!entry || !entry.owners) return true
    for (const [pkg, ver] of Object.entries(entry.owners)) {
      const current = versions?.get?.(pkg)
      // Пакет не найден в инвентаре (удалён/не резолвится) — не считаем
      // запись устаревшей: версия появится, когда пакет снова станет виден.
      if (current !== undefined && current !== ver) return false
    }
    return true
  }

  /**
   * Найти перевод.
   * @param {string} src - исходный текст.
   * @param {Map<string,string>} versions - текущие версии пакетов.
   * @returns {{dst: string}|null} перевод или null при промахе/устаревании.
   */
  lookup(src, versions) {
    const hash = textHash(normalizeSource(src))
    const entry = this.entries.get(hash)
    if (!entry || entry.src !== normalizeSource(src)) return null
    if (!TranslationCache.isFresh(entry, versions)) return null
    entry.used = Date.now()
    this.stats.hits += 1
    this.dirty = true
    return { dst: entry.dst }
  }

  /**
   * Запомнить перевод и владельцев строки.
   * @param {string} src - исходный текст.
   * @param {string} dst - перевод.
   * @param {Record<string,string>|undefined} owners - пакет → версия.
   * @returns {void}
   */
  remember(src, dst, owners) {
    const norm = normalizeSource(src)
    if (!norm || typeof dst !== 'string' || dst.trim() === '') return
    const hash = textHash(norm)
    const prev = this.entries.get(hash)
    const merged = { ...(prev && prev.src === norm ? prev.owners : {}), ...(owners ?? {}) }
    this.entries.set(hash, {
      src: norm,
      dst: dst.trim(),
      owners: merged,
      ts: prev && prev.src === norm ? prev.ts : Date.now(),
      used: Date.now(),
    })
    this.stats.translated += 1
    this.dirty = true
    this.prune({ save: false })
    this.scheduleSave()
  }

  /**
   * Дописать владельца к существующему переводу (миграция записи).
   * Перевод не перезапрашивается: совпадающий текст переводится одинаково.
   * @param {string} src - исходный текст.
   * @param {Record<string,string>|undefined} owners - пакет → версия.
   * @returns {void}
   */
  adopt(src, owners) {
    if (!owners || Object.keys(owners).length === 0) return
    const hash = textHash(normalizeSource(src))
    const entry = this.entries.get(hash)
    if (!entry || entry.src !== normalizeSource(src)) return
    let changed = false
    for (const [pkg, ver] of Object.entries(owners)) {
      if (entry.owners[pkg] !== ver) {
        entry.owners[pkg] = ver
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  /**
   * Запомнить неудачу: не повторять перевод этой строки сразу.
   * @param {string} src - исходный текст.
   * @param {number} ttlMs - сколько миллисекунд держать запрет.
   * @returns {void}
   */
  rememberMiss(src, ttlMs) {
    if (ttlMs <= 0) return
    this.misses.set(textHash(normalizeSource(src)), Date.now() + ttlMs)
  }

  /**
   * Проверить негативный кэш.
   * @param {string} src - исходный текст.
   * @returns {boolean} истина, если перевод недавно уже падал.
   */
  isMiss(src) {
    const hash = textHash(normalizeSource(src))
    const until = this.misses.get(hash)
    if (until === undefined) return false
    if (until > Date.now()) return true
    this.misses.delete(hash)
    return false
  }

  /**
   * Снимок кэша для клиента: только «свежие» относительно версий записи.
   * Нужен, чтобы первый рендер страницы сразу получал переводы.
   * @param {Map<string,string>} versions - текущие версии пакетов.
   * @returns {{entries: Record<string,string>, total: number, skipped: number}} снимок.
   */
  seed(versions) {
    const entries = {}
    let total = 0
    let skipped = 0
    for (const entry of this.entries.values()) {
      if (!TranslationCache.isFresh(entry, versions)) {
        skipped += 1
        continue
      }
      entries[entry.src] = entry.dst
      total += 1
    }
    this.stats.seeded = total
    return { entries, total, skipped }
  }

  /**
   * Учесть расход токенов и число запросов к модели.
   * @param {{inputTokens?: number, outputTokens?: number}} usage - расход.
   * @returns {void}
   */
  noteUsage(usage) {
    this.stats.batches += 1
    this.stats.inputTokens += Number(usage?.inputTokens) || 0
    this.stats.outputTokens += Number(usage?.outputTokens) || 0
    this.dirty = true
    this.scheduleSave()
  }

  /** Учесть неудачный перевод. */
  noteFailure() {
    this.stats.failed += 1
    this.dirty = true
  }

  /**
   * Удалить устаревшие и лишние записи.
   * @param {{save?: boolean}} options - сохранять ли файл сразу.
   * @returns {void}
   */
  prune({ save = true } = {}) {
    const ttl = this.ttlDays * 24 * 60 * 60 * 1000
    const now = Date.now()
    let removed = 0
    for (const [hash, entry] of this.entries) {
      if (ttl > 0 && now - entry.ts > ttl) {
        this.entries.delete(hash)
        removed += 1
      }
    }
    if (this.entries.size > this.maxEntries) {
      const sorted = [...this.entries.entries()].sort((a, b) => a[1].used - b[1].used)
      for (let i = 0; i < sorted.length - this.maxEntries; i += 1) {
        this.entries.delete(sorted[i][0])
        removed += 1
      }
    }
    if (removed > 0) {
      this.dirty = true
      this.log?.debug?.(`cache: удалено записей — ${removed}`)
      if (save) this.scheduleSave()
    }
  }

  /** Отложить запись на диск. */
  scheduleSave() {
    if (this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush().catch(() => {})
    }, SAVE_DELAY_MS)
    this.saveTimer.unref?.()
  }

  /**
   * Записать кэш на диск атомарно. Вызовы сериализуются.
   * @returns {Promise<void>} завершается после записи.
   */
  async flush() {
    if (!this.dirty) return
    this.dirty = false
    const run = async () => {
      const payload = JSON.stringify({
        schema: SCHEMA,
        lang: this.lang,
        savedAt: new Date().toISOString(),
        entries: Object.fromEntries(this.entries),
        stats: this.stats,
      })
      try {
        // Кэш содержит пользовательский UI-текст: каталог и файл — только владельцу.
        await mkdir(this.dir, { recursive: true, mode: 0o700 })
        const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
        await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
        // Windows иногда держит файл антивирусом: один короткий повтор.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await rename(tmp, this.file)
            return
          } catch (error) {
            if (attempt === 1) throw error
            await delay(60)
          }
        }
      } catch (error) {
        this.dirty = true
        this.log?.warn?.(`cache: не удалось записать ${this.file}:`, error?.message ?? error)
      }
    }
    this.saveChain = this.saveChain.then(run, run)
    return this.saveChain
  }

  /**
   * Полностью очистить кэш языка (файл перезаписывается пустым).
   * @returns {Promise<number>} число удалённых записей.
   */
  async forgetAll() {
    const count = this.entries.size
    this.entries.clear()
    this.misses.clear()
    this.stats.hits = 0
    this.stats.translated = 0
    this.dirty = true
    await this.flush()
    return count
  }

  /** Краткая статистика для диагностического маршрута. */
  describe() {
    return {
      lang: this.lang,
      file: this.file,
      entries: this.entries.size,
      misses: this.misses.size,
      stats: { ...this.stats },
    }
  }
}

/**
 * Каталог кэша по умолчанию: `$DSH_HOME/cache/dsh-auto-translate`
 * (с запасным вариантом `~/.dsh/cache/...`).
 * @param {string} override - значение из конфига (может быть пустым).
 * @param {string} home - домашний каталог ОС.
 * @returns {string} абсолютный путь каталога.
 */
export function defaultCacheDir(override, home) {
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const dshHome = process.env.DSH_HOME?.trim() || join(home, '.dsh')
  return join(dshHome, 'cache', 'dsh-auto-translate')
}
