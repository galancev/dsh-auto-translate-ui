/**
 * Хост-половина плагина `dsh-auto-translate-ui`.
 *
 * Задачи половины:
 * 1. держать HTTP-маршруты `/api/dsh-auto-translate/*` для клиентской половины;
 * 2. переводить недостающие строки через `ctx.llm` (DeepSeek Flash, reasoning off)
 *    одним батч-запросом на пачку строк;
 * 3. хранить переводы в локальном кэше, привязанном к версиям плагинов;
 * 4. отдавать клиенту снимок кэша, чтобы первый рендер страницы был сразу
 *    переведённым (без мигания оригиналом и без лишних запросов).
 *
 * Плагин не импортирует внутренние пакеты DSH: версии пакетов, LLM и веб-сервер
 * берутся через сервисы Cordis (`ctx.get`), что делает его совместимым с
 * установкой в профиль как сторонний пакет.
 * @module dsh-auto-translate-ui
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Config, resolveConfig } from './host/config.js'
import { createLogger } from './host/util.js'
import { createInventory } from './host/inventory.js'
import { TranslationCache, defaultCacheDir } from './host/cache.js'
import { registerRoutes } from './host/routes.js'

export { Config } from './host/config.js'

/** Версия самого плагина: читается из package.json рядом с точкой входа. */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * Подключить хост-половину к контексту Cordis.
 *
 * `webServer` подключается через `ctx.inject`, а не жёстким `inject`-массивом:
 * плагин должен загружаться и в композициях без веб-сервера (headless),
 * просто без HTTP-маршрутов.
 * @param {object} ctx - контекст плагина.
 * @param {object|undefined} config - конфигурация из профиля (volatile-ссылки).
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolve = () => resolveConfig(config)
  const log = createLogger(ctx, () => resolve().logLevel)
  const inventory = createInventory(ctx, log)

  /** @type {Map<string, TranslationCache>} кэши по ключу «язык|каталог|лимиты» */
  const caches = new Map()

  /**
   * Получить (при необходимости создать и загрузить) кэш языка.
   * Ключ включает каталог и лимиты: правка настроек не требует перезапуска.
   * @param {'ru'|'en'} lang - язык.
   * @returns {Promise<TranslationCache>} кэш.
   */
  const cacheFor = async (lang) => {
    const cfg = resolve()
    const dir = defaultCacheDir(cfg.cacheDir, homedir())
    const key = `${lang}|${dir}|${cfg.cacheTtlDays}|${cfg.maxCacheEntries}`
    const existing = caches.get(key)
    if (existing !== undefined) return existing
    const cache = new TranslationCache({
      dir,
      lang,
      ttlDays: cfg.cacheTtlDays,
      maxEntries: cfg.maxCacheEntries,
      log,
    })
    await cache.load()
    caches.set(key, cache)
    return cache
  }

  let stopped = false

  ctx.effect(() => {
    return () => {
      stopped = true
      // Перед выгрузкой дописываем кэш на диск.
      for (const cache of caches.values()) {
        cache.flush().catch(() => {})
      }
    }
  }, 'dsh-auto-translate-ui: cache flush on dispose')

  ctx.inject(['webServer'], (scope) => {
    if (stopped) return
    try {
      const disposeRoutes = registerRoutes({
        ctx: scope,
        log,
        resolveConfig: resolve,
        cacheFor,
        inventory,
        pluginVersion: PLUGIN_VERSION,
      })
      scope.effect(() => disposeRoutes, 'dsh-auto-translate-ui: HTTP routes')
      log.info(`маршруты /api/dsh-auto-translate/* зарегистрированы (v${PLUGIN_VERSION})`)
    } catch (error) {
      log.error('не удалось зарегистрировать HTTP-маршруты:', error?.message ?? error)
    }
  })
}
