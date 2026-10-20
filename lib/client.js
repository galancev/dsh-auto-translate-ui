window.__ModuleLoader__.load({
  id: 'dsh-auto-translate-ui',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /**
     * Клиентская половина плагина автоперевода UI.
     *
     * Как это работает:
     * 1. при загрузке запрашиваем у хоста конфиг и снимок кэша переводов;
     * 2. оборачиваем `ctx.locale.translate` — если для возвращённой строки уже
     *    есть перевод, сразу отдаём его (React рендерит перевод без мигания);
     * 3. MutationObserver ищет в DOM текст на «иностранных» письменностях
     *    (обычно китайский) вне областей контента (чат, код, markdown);
     * 4. недостающие строки копятся с debounce и уходят одним POST-ом на хост,
     *    где DeepSeek Flash переводит пачку и кладёт результат в локальный кэш;
     * 5. пришедшие переводы применяются к уже отрисованным узлам DOM и
     *    запоминаются, поэтому повторный рендер сразу получает перевод.
     *
     * Кэш принадлежит хосту (файл в ~/.dsh/cache), поэтому переживает
     * перезапуск DSH и не требует повторного перевода страницы.
     */

    const API = '/api/dsh-auto-translate'
    const CSRF_HEADER = 'x-dsh-auto-translate'
    /** Коды целевых языков, которые умеет хост. */
    const LANGS = new Set(['ru', 'en'])
    /** Пауза перед повтором после неудачного перевода, мс. */
    const FAILURE_COOLDOWN_MS = 5 * 60 * 1000
    /** Пауза перед повтором, если хост сообщил об отсутствии модели, мс. */
    const UNAVAILABLE_COOLDOWN_MS = 30 * 1000
    /** Сколько строк отправлять в одном POST-е. */
    const CLIENT_POST_ITEMS = 120

    /** Диапазоны кодпоинтов «иностранных» письменностей. */
    const SCRIPT_RANGES = {
      cjk: [
        [0x2e80, 0x2eff],
        [0x3000, 0x303f],
        [0x3400, 0x4dbf],
        [0x4e00, 0x9fff],
        [0xf900, 0xfaff],
        [0x20000, 0x2a6df],
        [0x2a700, 0x2b73f],
        [0x2b740, 0x2b81f],
        [0x2b820, 0x2ceaf],
        [0x2ceb0, 0x2ebef],
        [0x30000, 0x3134f],
      ],
      kana: [
        [0x3040, 0x30ff],
        [0x31f0, 0x31ff],
        [0xff66, 0xff9d],
      ],
      hangul: [
        [0x1100, 0x11ff],
        [0x3130, 0x318f],
        [0xa960, 0xa97f],
        [0xac00, 0xd7af],
      ],
      thai: [[0x0e00, 0x0e7f]],
      devanagari: [[0x0900, 0x097f]],
      arabic: [
        [0x0600, 0x06ff],
        [0x0750, 0x077f],
        [0x08a0, 0x08ff],
        [0xfb50, 0xfdff],
        [0xfe70, 0xfeff],
      ],
      hebrew: [
        [0x0590, 0x05ff],
        [0xfb1d, 0xfb4f],
      ],
      greek: [
        [0x0370, 0x03ff],
        [0x1f00, 0x1fff],
      ],
      other: [
        [0x0530, 0x058f],
        [0x10a0, 0x10ff],
        [0x1780, 0x17ff],
        [0x0e80, 0x0eff],
        [0x1000, 0x109f],
        [0x0d80, 0x0dff],
        [0x0b80, 0x0bff],
        [0x0c00, 0x0c7f],
        [0x0c80, 0x0cff],
        [0x0d00, 0x0d7f],
        [0x0980, 0x09ff],
        [0x0a00, 0x0a7f],
        [0x0a80, 0x0aff],
        [0x0780, 0x07bf],
        [0x1200, 0x137f],
        [0x1e00, 0x1eff],
      ],
    }

    /** Латинские буквы с диакритикой — грубый признак не-английского текста. */
    const LATIN_DIACRITICS = /[À-ÖØ-öø-ÿĀ-žŁłŒœŠšŸŽž]/u

    /** Теги, внутри которых текст не является UI-копией. */
    const SKIPPED_TAGS = new Set([
      'SCRIPT',
      'STYLE',
      'NOSCRIPT',
      'TEXTAREA',
      'CODE',
      'PRE',
      'KBD',
      'SAMP',
      'SVG',
      'MATH',
      'SELECT',
      'INPUT',
    ])

    /** Базовые селекторы-исключения (объединяются с настройками плагина). */
    const BASE_SKIP_CSS = [
      ...SKIPPED_TAGS.values(),
      '[contenteditable]',
      '[translate="no"]',
      '[data-no-translate]',
      '[data-dsh-translate-skip]',
      '[data-lexical-editor]',
      '[data-composer-input]',
      '[role="textbox"]',
      '[data-code-block-banner]',
      '[data-code-block-content]',
      '[data-streaming]',
      '[data-markdown-variant]',
      '[data-slot-error]',
      '.katex',
      '[data-latex]',
    ].join(',')

    /**
     * Маркеры ленты чата. При `scope: 'ui'` содержимое разговора (сообщения
     * модели, рассуждения, инструментальные карточки) не переводим: это не
     * интерфейс, а также дорого и нестабильно (стриминг постоянно меняет текст).
     * Маркеры проверены по бандлу dsh-client-ui-chat.
     */
    const CHAT_CONTENT_CSS = [
      '[data-chat-flow]',
      '[data-chat-turn]',
      '[data-chat-node-key]',
      '[data-chat-flow-key]',
      '[data-chat-group-part]',
      '[data-turn-tail]',
      '[data-turn-process]',
      '[data-chat-running]',
      '[data-chat-motion]',
    ].join(',')

    /**
     * Проверить, содержит ли строка символы включённых «иностранных» письменностей.
     * @param {string} text - проверяемая строка.
     * @param {{includeScripts: string[], latinDetection: boolean}} cfg - конфиг.
     * @returns {boolean} истина, если строку стоит переводить.
     */
    function isForeign(text, cfg) {
      if (typeof text !== 'string' || text === '') return false
      const scripts = cfg?.includeScripts ?? []
      for (const script of scripts) {
        const ranges = SCRIPT_RANGES[script]
        if (ranges === undefined) continue
        for (let i = 0; i < text.length; i += 1) {
          const code = text.charCodeAt(i)
          for (const [start, end] of ranges) {
            if (code >= start && code <= end) return true
          }
        }
      }
      if (cfg?.latinDetection === true && LATIN_DIACRITICS.test(text)) return true
      return false
    }

    /**
     * Отсеять не-текстовые значения: числа, пунктуацию, URL, пути, идентификаторы.
     * @param {string} text - обрезанная строка.
     * @returns {boolean} истина, если это похоже на код/идентификатор.
     */
    function isLikelyCode(text) {
      if (/^(?:https?:\/\/|mailto:|www\.)/i.test(text)) return true
      // Нет ни одной буквы — числа, символы, разделители.
      if (!/\p{L}/u.test(text)) return true
      // Одна «бесскобочная» строка без пробелов из ASCII-идентификаторов.
      if (/^[\w.@:/\\%+~#-]+$/u.test(text) && /[/@:\\]/.test(text)) return true
      // Шестнадцатеричные хэши, версии, uuid.
      if (/^[0-9a-f]{8,}$/i.test(text)) return true
      if (/^v?\d+(?:\.\d+)+$/.test(text)) return true
      // Одиночные символы и очень короткие обрывки не переводим.
      if (text.trim().length < 2) return true
      return false
    }

    /**
     * Собрать безопасный CSS-селектор исключений: базовые правила + настройки.
     * Некорректные селекторы из ручного конфига отбрасываются, чтобы не ломать
     * `closest()` на всей странице.
     * @param {string[]} configured - селекторы из настроек.
     * @param {'ui'|'all'} [scope] - область: ui исключает ленту чата.
     * @returns {string} итоговый CSS-селектор.
     */
    function buildSkipCss(configured, scope = 'ui') {
      const valid = []
      for (const selector of Array.isArray(configured) ? configured : []) {
        if (typeof selector !== 'string' || selector === '') continue
        try {
          document.querySelector(selector)
          valid.push(selector)
        } catch {
          /* некорректный селектор из конфига игнорируем */
        }
      }
      const parts = [BASE_SKIP_CSS]
      if (scope !== 'all') parts.push(CHAT_CONTENT_CSS)
      parts.push(...valid)
      return parts.join(',')
    }

    /**
     * Селектор исключений для атрибутов: сам элемент с переводом атрибута
     * (например, `<input placeholder>`) допустим, поэтому теговые правила из
     * {@link BASE_SKIP_CSS} здесь не годятся — только явные запреты.
     * @param {string[]} configured - селекторы из настроек.
     * @param {'ui'|'all'} [scope] - область: ui исключает ленту чата.
     * @returns {string} CSS-селектор.
     */
    function buildAttrSkipCss(configured, scope = 'ui') {
      const parts = ['[data-no-translate],[data-dsh-translate-skip],[translate="no"],[contenteditable]']
      if (scope !== 'all') parts.push(CHAT_CONTENT_CSS)
      for (const selector of Array.isArray(configured) ? configured : []) {
        if (typeof selector !== 'string' || selector === '') continue
        try {
          document.querySelector(selector)
          parts.push(selector)
        } catch {
          /* некорректный селектор из конфига игнорируем */
        }
      }
      return parts.join(',')
    }

    /**
     * Проверить, находится ли узел внутри области, которую нельзя переводить.
     * Кэшированный `closest()` заметно дешевле обхода предков с `matches()` на
     * каждый узел.
     * @param {Node} node - узел.
     * @param {string} skipCss - CSS-селектор исключений.
     * @returns {boolean} истина, если перевод запрещён.
     */
    function isInsideSkipped(node, skipCss) {
      const element = node.nodeType === 1 ? node : node.parentElement
      if (element === null || element === undefined) return true
      try {
        return element.closest(skipCss) !== null
      } catch {
        return false
      }
    }

    /**
     * Применить текущую точку входа: создать контроллер автоперевода.
     * @param {object} ctx - клиентский контекст Cordis.
     * @returns {void}
     */
    function apply(ctx) {
      const state = {
        enabled: false,
        config: null,
        targetLang: 'ru',
        translations: new Map(),
        pending: new Map(),
        failures: new Map(),
        patchedText: new WeakMap(),
        patchedAttr: new WeakMap(),
        // Анти-эхо: последнее записанное нами значение узла/атрибута. Без этого
        // characterData-наблюдатель зацикливается на собственных записях.
        writtenText: new WeakMap(),
        writtenAttr: new WeakMap(),
        // 'ui' исключает ленту чата; 'all' — включает (scope из настроек).
        skipCss: `${BASE_SKIP_CSS},${CHAT_CONTENT_CSS}`,
        attrSkipCss: `[data-no-translate],[data-dsh-translate-skip],[translate="no"],[contenteditable],${CHAT_CONTENT_CSS}`,
        observer: null,
        flushTimer: null,
        configTimer: null,
        scanTimer: null,
        originalTranslate: null,
        wrappedTranslate: null,
        localeUnsubscribe: null,
        lastActive: null,
        unavailableUntil: 0,
        started: false,
        disposed: false,
      }

      const locale = ctx.locale

      /**
       * Время в миллисекундах.
       * @returns {number} now.
       */
      const now = () => Date.now()

      /**
       * Активный язык интерфейса.
       * @returns {string} код языка.
       */
      const activeLocale = () => {
        try {
          const snapshot = locale?.getSnapshot?.() ?? locale?.getLocale?.()
          return typeof snapshot?.active === 'string' ? snapshot.active : 'ru'
        } catch {
          return 'ru'
        }
      }

      /**
       * Целевой язык перевода: явный из конфига либо активный язык UI.
       * @returns {'ru'|'en'} код языка.
       */
      const resolveTarget = () => {
        const configured = state.config?.targetLanguage
        if (configured === 'ru' || configured === 'en') return configured
        const active = activeLocale().toLowerCase()
        if (active.startsWith('ru')) return 'ru'
        return 'en'
      }

      /**
       * Является ли строка уже переведённой или подлежащей переводу.
       * @param {string} text - обрезанная строка.
       * @returns {boolean} истина, если строку надо отправить на перевод.
       */
      const needsTranslation = (text) => state.enabled && isForeign(text, state.config) && !isLikelyCode(text)

      /**
       * Поставить строку в очередь на перевод.
       * @param {string} text - обрезанная строка.
       * @param {string|null} ns - пространство имён локализации, если известно.
       * @returns {void}
       */
      const enqueue = (text, ns) => {
        if (!needsTranslation(text)) return
        if (state.translations.has(text)) return
        const failedAt = state.failures.get(text)
        if (failedAt !== undefined && now() - failedAt < FAILURE_COOLDOWN_MS) return
        if (state.pending.has(text)) return
        if (text.length > (state.config?.maxTextChars ?? 320)) return
        state.pending.set(text, { ns: typeof ns === 'string' && ns !== '' ? ns : null })
        scheduleFlush()
      }

      /** Запланировать отправку очереди с debounce. */
      const scheduleFlush = () => {
        if (state.flushTimer !== null) return
        const delay = Math.max(50, state.config?.debounceMs ?? 300)
        state.flushTimer = setTimeout(() => {
          state.flushTimer = null
          flushQueue().catch(() => {})
        }, delay)
      }

      /**
       * Отправить накопленные строки на хост одним или несколькими POST-ами.
       * @returns {Promise<void>} завершается после применения ответов.
       */
      async function flushQueue() {
        if (!state.enabled || state.pending.size === 0) return
        if (now() < state.unavailableUntil) {
          // Модель недоступна — не долбим хост, но строки оставляем в очереди.
          scheduleFlush()
          return
        }
        const entries = [...state.pending.entries()].slice(0, CLIENT_POST_ITEMS)
        if (entries.length === 0) return
        for (const [text] of entries) state.pending.delete(text)
        const items = entries.map(([text, meta]) => ({ t: text, ns: meta.ns }))
        try {
          const response = await fetch(`${API}/translate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
            body: JSON.stringify({ lang: state.targetLang, items }),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          if (payload?.disabled === true) {
            state.pending.clear()
            return
          }
          const translations = payload?.translations
          let applied = 0
          const appliedTexts = new Set()
          if (translations && typeof translations === 'object') {
            for (const [src, dst] of Object.entries(translations)) {
              if (typeof dst !== 'string' || dst === '' || dst === src) continue
              state.translations.set(src, dst)
              appliedTexts.add(src)
              applied += 1
            }
            if (applied > 0) repatch()
          }
          // Строки, которые хост не перевёл (негативный кэш, отсев по длине и
          // т.п.), не должны немедленно возвращаться в очередь: ставим локальный
          // cooldown, иначе DOM-скан будет бесконечно повторять один и тот же запрос.
          for (const [text] of entries) {
            if (!appliedTexts.has(text)) state.failures.set(text, now())
          }
          if (typeof payload?.error === 'string' && payload.error !== '') {
            if (payload.error === 'no-provider' || payload.error === 'llm-unavailable') {
              state.unavailableUntil = now() + UNAVAILABLE_COOLDOWN_MS
              console.warn('[dsh-auto-translate-ui] переводчик недоступен:', payload.error)
            } else {
              for (const [text] of entries) state.failures.set(text, now())
            }
          }
        } catch (error) {
          // Сеть/сервер недоступны: строки вернутся в очередь после паузы.
          for (const [text, meta] of entries) {
            if (!state.pending.has(text)) state.pending.set(text, meta)
            state.failures.set(text, now())
          }
          state.unavailableUntil = now() + UNAVAILABLE_COOLDOWN_MS
          console.warn('[dsh-auto-translate-ui] не удалось получить переводы:', error?.message ?? error)
        } finally {
          if (state.pending.size > 0) scheduleFlush()
        }
      }

      /**
       * Заменить значение текстового узла, сохранив исходный текст для отката.
       * @param {Text} node - текстовый узел.
       * @param {string} src - исходная (обрезанная) строка.
       * @param {string} dst - перевод.
       * @returns {boolean} истина, если узел изменён.
       */
      const patchTextNode = (node, src, dst) => {
        const current = node.nodeValue ?? ''
        const trimmed = current.trim()
        if (trimmed !== src) return false
        const previous = state.patchedText.get(node)
        if (previous === undefined) {
          state.patchedText.set(node, { src, dst })
        } else {
          previous.dst = dst
        }
        const leading = current.slice(0, current.indexOf(src))
        const trailing = current.slice(current.indexOf(src) + src.length)
        const next = `${leading}${dst}${trailing}`
        state.writtenText.set(node, next)
        node.nodeValue = next
        return true
      }

      /**
       * Перевести существующий узел, если для его текста есть перевод.
       * @param {Text} node - текстовый узел.
       * @returns {void}
       */
      const applyTranslationToText = (node) => {
        const current = node.nodeValue ?? ''
        // Это наша собственная запись, а не новый рендер React.
        if (state.writtenText.get(node) === current) return
        const trimmed = current.trim()
        if (trimmed === '') return
        const known = state.translations.get(trimmed)
        if (known !== undefined) {
          patchTextNode(node, trimmed, known)
          return
        }
        if (needsTranslation(trimmed)) enqueue(trimmed, null)
      }

      /**
       * Перевести атрибут элемента (placeholder, title, aria-label, alt).
       * @param {Element} element - элемент.
       * @param {string} attr - имя атрибута.
       * @returns {void}
       */
      const applyTranslationToAttr = (element, attr) => {
        const value = element.getAttribute(attr)
        if (value === null) return
        const written = state.writtenAttr.get(element)
        if (written !== undefined && written.get(attr) === value) return
        const trimmed = value.trim()
        if (trimmed === '') return
        if (isInsideSkipped(element, state.attrSkipCss)) return
        const known = state.translations.get(trimmed)
        if (known !== undefined) {
          if (known !== trimmed) {
            let originals = state.patchedAttr.get(element)
            if (originals === undefined) {
              originals = new Map()
              state.patchedAttr.set(element, originals)
            }
            if (!originals.has(attr)) originals.set(attr, value)
            const next = value.replace(trimmed, known)
            if (written === undefined) state.writtenAttr.set(element, new Map([[attr, next]]))
            else written.set(attr, next)
            element.setAttribute(attr, next)
          }
          return
        }
        if (needsTranslation(trimmed)) enqueue(trimmed, null)
      }

      /**
       * Полный проход по документу: применить известные переводы и собрать
       * новые строки. Вызывается после ответа хоста и при включении плагина.
       * @returns {void}
       */
      function repatch() {
        if (state.disposed) return
        const body = document.body
        if (body === null) return
        try {
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null)
          let node = walker.nextNode()
          while (node !== null) {
            if (!isInsideSkipped(node, state.skipCss)) applyTranslationToText(node)
            node = walker.nextNode()
          }
          const attrs = state.config?.translateAttributes ?? []
          if (attrs.length > 0) {
            const selector = attrs.map((attr) => `[${attr}]`).join(',')
            for (const element of body.querySelectorAll(selector)) {
              for (const attr of attrs) applyTranslationToAttr(element, attr)
            }
          }
          if (typeof document.title === 'string' && document.title !== '') {
            const translated = state.translations.get(document.title.trim())
            if (translated !== undefined && document.title.trim() !== translated) document.title = translated
            else if (needsTranslation(document.title.trim())) enqueue(document.title.trim(), null)
          }
        } catch (error) {
          console.warn('[dsh-auto-translate-ui] DOM-проход не удался:', error?.message ?? error)
        }
      }

      /**
       * Обработать добавленное поддерево или изменённый текстовый узел.
       * @param {Node} root - корень обхода.
       * @returns {void}
       */
      const scanNode = (root) => {
        if (state.disposed) return
        if (root === null || root === undefined) return
        if (root.nodeType === 3) {
          if (!isInsideSkipped(root, state.skipCss)) applyTranslationToText(root)
          return
        }
        if (root.nodeType !== 1) return
        const element = root
        if (isInsideSkipped(element, state.skipCss)) {
          // Область-исключение может содержать UI вне контента: не трогаем целиком.
          return
        }
        try {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null)
          let node = walker.nextNode()
          while (node !== null) {
            if (!isInsideSkipped(node, state.skipCss)) applyTranslationToText(node)
            node = walker.nextNode()
          }
          for (const attr of state.config?.translateAttributes ?? []) {
            applyTranslationToAttr(element, attr)
            for (const child of element.querySelectorAll(`[${attr}]`)) applyTranslationToAttr(child, attr)
          }
        } catch {
          /* элемент мог быть удалён из DOM — это нормально для SPA */
        }
      }

      /** Установить MutationObserver на документ. */
      const startObserver = () => {
        if (state.observer !== null || typeof MutationObserver !== 'function') return
        if (document.body === null) {
          // Модуль мог материализоваться раньше, чем появился <body>.
          setTimeout(() => {
            if (!state.disposed && state.enabled) startObserver()
          }, 100)
          return
        }
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === 'characterData') {
              scanNode(record.target)
            } else if (record.type === 'attributes') {
              const element = record.target
              if (element.nodeType === 1) {
                applyTranslationToAttr(element, record.attributeName)
              }
            } else {
              for (const added of record.addedNodes) scanNode(added)
            }
          }
        })
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: state.config?.translateAttributes ?? ['placeholder', 'title', 'aria-label', 'alt'],
        })
        state.observer = observer
      }

      /** Остановить MutationObserver. */
      const stopObserver = () => {
        if (state.observer === null) return
        state.observer.disconnect()
        state.observer = null
      }

      /** Вернуть все изменённые узлы к исходному тексту. */
      const restoreDom = () => {
        // WeakMap нельзя перебрать, поэтому обходим документ: это происходит
        // только при выключении плагина/смене языка и потому не горячо.
        const body = document.body
        if (body === null) return
        try {
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null)
          let node = walker.nextNode()
          while (node !== null) {
            const previous = state.patchedText.get(node)
            if (previous !== undefined) {
              const current = node.nodeValue ?? ''
              const index = current.indexOf(previous.dst)
              if (index !== -1) node.nodeValue = `${current.slice(0, index)}${previous.src}${current.slice(index + previous.dst.length)}`
              state.patchedText.delete(node)
            }
            node = walker.nextNode()
          }
          for (const element of body.querySelectorAll('*')) {
            const originals = state.patchedAttr.get(element)
            if (originals === undefined) continue
            for (const [attr, value] of originals) element.setAttribute(attr, value)
            state.patchedAttr.delete(element)
          }
        } catch {
          /* документ мог измениться во время отката */
        }
      }

      /** Подписаться на смену языка интерфейса. */
      const watchLocale = () => {
        if (state.localeUnsubscribe !== null) return
        try {
          const unsubscribe = locale.subscribe(() => {
            const active = activeLocale()
            if (active === state.lastActive) return
            state.lastActive = active
            const next = resolveTarget()
            if (next === state.targetLang) return
            state.targetLang = next
            state.translations.clear()
            restoreDom()
            loadSeed().then(() => repatch())
          })
          state.localeUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null
        } catch {
          state.localeUnsubscribe = null
        }
      }

      /** Подписаться на смену языка (снять подписку при остановке). */
      const unwatchLocale = () => {
        if (state.localeUnsubscribe === null) return
        try {
          state.localeUnsubscribe()
        } catch {
          /* подписка могла быть снята вместе с плагином локали */
        }
        state.localeUnsubscribe = null
      }

      /** Обернуть `locale.translate`, чтобы известные переводы отдавались сразу. */
      const installTranslateHook = () => {
        if (state.wrappedTranslate !== null) return
        try {
          const original = locale.translate
          if (typeof original !== 'function') return
          state.originalTranslate = original
          const wrapped = function (ns, key, params) {
            const result = original.call(locale, ns, key, params)
            if (typeof result !== 'string' || result === '') return result
            const trimmed = result.trim()
            const known = state.translations.get(trimmed)
            if (known !== undefined) {
              const index = result.indexOf(trimmed)
              return `${result.slice(0, index)}${known}${result.slice(index + trimmed.length)}`
            }
            if (needsTranslation(trimmed)) enqueue(trimmed, typeof ns === 'string' ? ns : null)
            return result
          }
          locale.translate = wrapped
          state.wrappedTranslate = wrapped
        } catch (error) {
          console.warn('[dsh-auto-translate-ui] не удалось перехватить translate:', error?.message ?? error)
        }
      }

      /** Снять обёртку `locale.translate` (если её не переопределили другие). */
      const removeTranslateHook = () => {
        if (state.wrappedTranslate === null) return
        try {
          if (locale.translate === state.wrappedTranslate) locale.translate = state.originalTranslate
        } catch {
          /* сервис мог быть выгружен */
        }
        state.wrappedTranslate = null
        state.originalTranslate = null
      }

      /**
       * Загрузить снимок кэша с хоста.
       * @returns {Promise<void>} завершается после заполнения памяти.
       */
      async function loadSeed() {
        try {
          const response = await fetch(`${API}/translations?lang=${encodeURIComponent(state.targetLang)}`)
          if (!response.ok) return
          const payload = await response.json()
          const entries = payload?.entries
          if (entries === null || typeof entries !== 'object') return
          for (const [src, dst] of Object.entries(entries)) {
            if (typeof dst === 'string' && dst !== '' && src.trim() !== '') state.translations.set(src, dst)
          }
        } catch {
          /* без снимка плагин просто запросит переводы по мере надобности */
        }
      }

      /**
       * Запросить конфиг у хоста.
       * @returns {Promise<object|null>} конфиг или null.
       */
      async function fetchConfig() {
        try {
          const response = await fetch(`${API}/config`)
          if (!response.ok) return null
          const payload = await response.json()
          return payload?.config ?? null
        } catch {
          return null
        }
      }

      /**
       * Полный запуск автоперевода: конфиг, кэш, обёртка translate, DOM.
       * @returns {Promise<void>} завершается после первого прохода.
       */
      async function start() {
        if (state.started) return
        const config = await fetchConfig()
        if (config === null || config.enabled !== true) {
          // Хост недоступен или плагин выключен: попробуем позже.
          scheduleConfigPoll()
          return
        }
        state.config = config
        state.targetLang = resolveTarget()
        state.lastActive = activeLocale()
        state.skipCss = buildSkipCss(config.skipSelectors, config.scope)
        state.attrSkipCss = buildAttrSkipCss(config.skipSelectors, config.scope)
        await loadSeed()
        state.enabled = true
        state.started = true
        installTranslateHook()
        watchLocale()
        startObserver()
        repatch()
        scheduleConfigPoll()
      }

      /** Остановить автоперевод и вернуть UI к исходному тексту. */
      function stop() {
        state.enabled = false
        state.started = false
        if (state.flushTimer !== null) {
          clearTimeout(state.flushTimer)
          state.flushTimer = null
        }
        if (state.scanTimer !== null) {
          clearTimeout(state.scanTimer)
          state.scanTimer = null
        }
        stopObserver()
        unwatchLocale()
        removeTranslateHook()
        restoreDom()
        state.pending.clear()
        state.translations.clear()
      }

      /** Периодический опрос конфига: включение/выключение без перезагрузки страницы. */
      function scheduleConfigPoll() {
        if (state.disposed || state.configTimer !== null) return
        state.configTimer = setTimeout(async () => {
          state.configTimer = null
          if (state.disposed) return
          const config = await fetchConfig()
          if (config !== null) {
            const wasEnabled = state.config?.enabled === true
            const previousLayout = JSON.stringify([
              state.config?.scope,
              state.config?.skipSelectors,
              state.config?.translateAttributes,
              state.config?.includeScripts,
              state.config?.latinDetection,
              state.config?.targetLanguage,
            ])
            state.config = config
            if (config.enabled === true) {
              if (!state.started) {
                start().catch(() => {})
              } else {
                // Применяем изменения, влияющие на разметку, только если они есть.
                const nextTarget = resolveTarget()
                const nextLayout = JSON.stringify([
                  config.scope,
                  config.skipSelectors,
                  config.translateAttributes,
                  config.includeScripts,
                  config.latinDetection,
                  config.targetLanguage,
                ])
                if (nextTarget !== state.targetLang) {
                  state.targetLang = nextTarget
                  state.translations.clear()
                  restoreDom()
                  loadSeed().then(() => repatch())
                } else if (nextLayout !== previousLayout) {
                  state.skipCss = buildSkipCss(config.skipSelectors, config.scope)
                  state.attrSkipCss = buildAttrSkipCss(config.skipSelectors, config.scope)
                  repatch()
                }
              }
            } else if (wasEnabled && state.started) {
              stop()
            }
          }
          scheduleConfigPoll()
        }, 10000)
        state.configTimer.unref?.()
      }

      // Первый запуск: планируем асинхронно, чтобы не блокировать загрузку GUI.
      setTimeout(() => {
        start().catch((error) => {
          console.warn('[dsh-auto-translate-ui] запуск не удался:', error?.message ?? error)
          scheduleConfigPoll()
        })
      }, 0)

      ctx.effect(() => {
        return () => {
          state.disposed = true
          stop()
          if (state.configTimer !== null) clearTimeout(state.configTimer)
          state.configTimer = null
        }
      }, 'dsh-auto-translate-ui: lifecycle')
    }

    module.exports = {
      apply,
      inject: ['locale'],
      __internals: { isForeign, isLikelyCode, SCRIPT_RANGES, SKIPPED_TAGS },
    }
    return module.exports
  },
})
