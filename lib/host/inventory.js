/**
 * Инвентарь плагинов: версии установленных пакетов и карта «пространство имён
 * локализации → пакет».
 *
 * Версии нужны, чтобы кэш переводов был привязан к версии плагина: после
 * обновления плагина его строки помечаются устаревшими и переводятся заново.
 *
 * Карта пространств имён строится сканированием собранных клиентских бандлов
 * (`lib/client.js`) установленных плагинов: вызовы `locale.register('<ns>', …)`
 * и объявления вида `const NS = '<ns>'`. Это надёжнее трассировки стека и
 * выполняется один раз на набор пакетов.
 * @module dsh-auto-translate-ui/host/inventory
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { service } from './util.js'

/** Максимальный размер читаемого клиентского бандла. */
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024

/** Как долго держать карту версий без пересканирования, мс. */
const VERSIONS_TTL_MS = 30_000

/**
 * Кандидаты пути клиентского бандла: объявленный в манифесте, затем типовые
 * места сборки (на случай плагинов без поля exports).
 * @param {object} manifest - package.json плагина.
 * @param {string} dir - каталог пакета.
 * @returns {string[]} абсолютные пути-кандидаты.
 */
function clientEntryCandidates(manifest, dir) {
  const exported = manifest?.exports?.['./client']
  const raw =
    typeof exported === 'string'
      ? exported
      : exported && typeof exported === 'object'
        ? exported.default ?? exported.import ?? exported.require
        : undefined
  const declared = typeof raw === 'string' && raw.startsWith('.') ? [join(dir, raw)] : []
  return [...declared, 'lib/client.js', 'dist/client.js', 'client.js'].map((candidate) =>
    candidate.startsWith(dir) ? candidate : join(dir, candidate),
  )
}

/**
 * Вырезать статические строки пространств имён из кода бандла.
 * @param {string} code - содержимое клиентского бандла.
 * @returns {string[]} найденные пространства имён.
 */
export function extractNamespaces(code) {
  const literals = new Map()
  const literalRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:'([^']{1,80})'|"([^"]{1,80})"|`([^`$]{1,80})`)/g
  for (let match = literalRe.exec(code); match !== null; match = literalRe.exec(code)) {
    const value = match[2] ?? match[3] ?? match[4]
    if (value !== undefined) literals.set(match[1], value)
  }
  const namespaces = new Set()
  const registerRe =
    /locale\s*(?:\.|\?\.)\s*register\s*\(\s*(?:'([^']{1,80})'|"([^"]{1,80})"|`([^`$]{1,80})`|([A-Za-z_$][\w$]*))/g
  for (let match = registerRe.exec(code); match !== null; match = registerRe.exec(code)) {
    const literal = match[1] ?? match[2] ?? match[3]
    const identifier = match[4]
    const value = literal ?? (identifier !== undefined ? literals.get(identifier) : undefined)
    if (value === undefined) continue
    const trimmed = value.trim()
    if (trimmed === '' || /\s/.test(trimmed) || trimmed.length > 80) continue
    namespaces.add(trimmed)
  }
  return [...namespaces]
}

/**
 * Кандидаты в пространства имён по имени пакета — эвристика для языковых
 * пакетов, регистрирующих пространства динамически.
 * @param {string} packageName - имя npm-пакета.
 * @returns {string[]} кандидаты.
 */
export function namespaceCandidates(packageName) {
  const base = String(packageName ?? '').replace(/^@[^/]+\//, '')
  const stripped = base.replace(/^dsh-/, '')
  return [...new Set([base, stripped, `dsh-${stripped}`, stripped.replace(/-/g, '.'), `settings.${stripped}`])]
}

/**
 * Создать инвентарь плагинов для хост-половины.
 * @param {object} ctx - контекст плагина.
 * @param {{info: Function, warn: Function, debug: Function}} log - логгер.
 * @returns {{versions: Function, namespaceOwner: Function, describe: Function}} инвентарь.
 */
export function createInventory(ctx, log) {
  const packages = () => service(ctx, 'pluginPackages')
  const loader = () => service(ctx, 'loader')

  /** @type {{at: number, map: Map<string,string>}|null} */
  let versionsCache = null
  /** @type {{signature: string, map: Map<string,string>}|null} */
  let namespaceCache = null

  /**
   * Текущая карта версий: имя пакета → версия.
   * @returns {Map<string,string>} карта версий.
   */
  function versions() {
    const now = Date.now()
    if (versionsCache !== null && now - versionsCache.at < VERSIONS_TTL_MS) return versionsCache.map
    const map = new Map()
    try {
      const resolved = packages()
      const entries = loader()?.entries?.() ?? []
      for (const entry of entries) {
        const name = entry?.options?.name
        if (typeof name !== 'string' || name === '') continue
        let version = 'unknown'
        try {
          const base = entry?.parent?.tree?.ctx?.baseUrl
          const pkg = resolved?.packageOf?.(name, base)
          if (pkg?.name) {
            map.set(pkg.name, String(pkg.version ?? 'unknown'))
            continue
          }
        } catch {
          /* резолвер недоступен — остаётся версия unknown */
        }
        map.set(name, version)
      }
    } catch (error) {
      log?.debug?.('inventory: не удалось прочитать версии пакетов:', error?.message ?? error)
    }
    versionsCache = { at: now, map }
    return map
  }

  /**
   * Пересобрать карту пространств имён, если набор пакетов или версий изменился.
   * @returns {Promise<Map<string,string>>} карта ns → имя пакета.
   */
  async function ensureNamespaces() {
    const current = versions()
    const signature = [...current.entries()].sort().map(([name, version]) => `${name}@${version}`).join('|')
    if (namespaceCache !== null && namespaceCache.signature === signature) return namespaceCache.map
    const map = new Map()
    const resolved = packages()
    let entries = []
    try {
      entries = [...(loader()?.entries?.() ?? [])]
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const name = entry?.options?.name
      if (typeof name !== 'string' || name === '') continue
      let pkg
      try {
        pkg = resolved?.packageOf?.(name, entry?.parent?.tree?.ctx?.baseUrl)
      } catch {
        pkg = undefined
      }
      if (!pkg?.dir || !pkg?.manifest) continue
      let code
      for (const file of clientEntryCandidates(pkg.manifest, pkg.dir)) {
        try {
          const buffer = await readFile(file)
          if (buffer.byteLength > MAX_BUNDLE_BYTES) continue
          code = buffer.toString('utf8')
          break
        } catch {
          /* пробуем следующий кандидат */
        }
      }
      if (code === undefined) continue
      for (const ns of extractNamespaces(code)) {
        if (!map.has(ns)) map.set(ns, pkg.name)
      }
    }
    namespaceCache = { signature, map }
    log?.debug?.(`inventory: пространств имён найдено — ${map.size}`)
    return map
  }

  /**
   * Владелец пространства имён: пакет и его текущая версия.
   * @param {string|null|undefined} ns - пространство имён локализации.
   * @returns {Promise<{pkg: string, version: string}|null>} владелец или null.
   */
  async function namespaceOwner(ns) {
    if (typeof ns !== 'string' || ns === '') return null
    const map = await ensureNamespaces()
    let pkg = map.get(ns)
    if (pkg === undefined) {
      for (const [candidate, packageName] of map) {
        if (candidate === ns) {
          pkg = packageName
          break
        }
      }
    }
    if (pkg === undefined) {
      // Эвристика: ns совпадает с нормализованным именем пакета.
      for (const packageName of versions().keys()) {
        if (namespaceCandidates(packageName).includes(ns)) {
          pkg = packageName
          break
        }
      }
    }
    if (pkg === undefined) return null
    return { pkg, version: versions().get(pkg) ?? 'unknown' }
  }

  /**
   * Список пакетов с клиентской половиной — для диагностического маршрута.
   * @returns {Promise<Array<{name: string, version: string}>>} список.
   */
  async function describe() {
    const resolved = packages()
    const list = []
    let entries = []
    try {
      entries = [...(loader()?.entries?.() ?? [])]
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const name = entry?.options?.name
      if (typeof name !== 'string' || name === '') continue
      let pkg
      try {
        pkg = resolved?.packageOf?.(name, entry?.parent?.tree?.ctx?.baseUrl)
      } catch {
        pkg = undefined
      }
      if (!pkg?.name) continue
      list.push({ name: pkg.name, version: String(pkg.version ?? 'unknown') })
    }
    list.sort((a, b) => a.name.localeCompare(b.name))
    return list
  }

  return { versions, namespaceOwner, describe }
}
