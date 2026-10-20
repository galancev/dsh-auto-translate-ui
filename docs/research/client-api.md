# Клиентский API DSH: браузерная половина плагина автоперевода

Проверено по `app.asar` DeepSeek Harness **0.2.1-rc.2** (Node 24.21.0) и сторонним плагинам профиля `desktop`.
Только чтение исходников; ссылки — «файл:строка».

Пути: `REF/` = `.reference/asar/dsh/node_modules/@deepseek-ai/`; `TMP/` = `.reference/tmp/asar/dsh/node_modules/@deepseek-ai/`
(мои временные распаковки: `cordis`, `cordis-plugin-loader`, `dsh-client-ui-settings`, `dsh-client-ui-chat`,
`dsh-client-ui-conversation`, `dsh-web-frontend`; не коммитятся); `SHELL` = `TMP/dsh-web-frontend/dist/assets/index-CN7NIWNw.js`
(boot kernel); `PROF/` = `~/.dsh/profiles/desktop/node_modules/`; `RL/` = `PROF/@goodandready/dsh-russian-lang/`;
`GG/` = `PROF/@linxin666/dsh-client-ui-git-graph/`.

## 0. TL;DR

1. Клиентский модуль — CJS-подобный бандл: `window.__ModuleLoader__.load({id, factory})`; `factory(require)` возвращает `module.exports` с `apply(ctx)` и `inject` (имена **cordis-сервисов**).
2. Нужна **строка Loader в профиле** (`cordis.patch.yml`, host-половина хотя бы с пустым `apply`): сканер клиентских бандлов обходит только живые записи с `dsh.client.platform === "web"`.
3. `require()` = platform seed (react, cordis, zod, primitives, store, slots, dockkit, virtual) + загруженные модули + `dsh.client.external`; value-импорты между плагинами запрещены соглашением — только сервисы.
4. `ctx.locale` — единственный `LocaleRuntime` (`ctx.provide("locale", locale)`); `bind(ns)` зовёт `this.translate` в момент вызова, поэтому подмена `ctx.locale.translate` перехватывает все `t`-сиденья.
5. `translate` при промахе возвращает сам ключ; поиск: fallback-цепочка активного языка в `ns` → та же в `common` → ключ; плейсхолдеры `{name}` подставляются (и в ключ).
6. Ре-рендер после асинхронного перевода: `revision` snapshot'а, на неё подписаны все slot-outlet'ы; ревизию бампают `register`/`addLanguage`/`setLocale`, отдельного публичного «nudge» нет.
7. **Версии плагинов в браузере нет**: boot-граф даёт `{id(package),url,rev,inject,external}` и `release{version,commit}` самого DSH, `ctx.remote.pluginInventory.list()` — без версии; нужна своя host-ручка (§4.3).
8. DOM не несёт атрибутов владельца: есть `data-slot="<slotKey>"`, разметка чата (`data-chat-*`, `data-streaming`, `data-markdown-variant`) и `style[data-plugin="<pkg>"]` (только стили); атрибуцию «строка → пакет» строим сами.
9. `registrant` slot-записи = `options.registrant ?? fiber.name`; у клиентских записей `fiber.name` фактически `"root"` — как идентификатор владельца не годится.
10. HMR смонтирован всегда и опрашивает `stat` бандлов (500 мс): пересборка `lib/client.js` подхватывается без рестарта DSH; dev-watcher (`pnpm run dev:web`) нужен только чтобы создавать пересборки.

## 1. Как клиентский модуль попадает в браузер

### 1.1 Декларация пакета

Нужны экспорт `./client`, блок `dsh.client` и строка Loader в профиле. Эталон — `REF/dsh-client-locale/package.json:16-40`:

```json
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
  "./package.json": "./package.json" },
"dsh": { "client": { "platform": "web", "immediately": true,
  "inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-ui-renderer",
             "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-api-remotes"] } }
```

Валидатор `REF/dsh-client-modules/lib/index.js:61-75,720-750`: `platform` обязателен и сканируется только `"web"`;
`inject`/`external` — массивы точных спецификаторов; `exports["./client"]` обязателен (строка или `{default}`), иначе
активация падает. `<id>/client` и `<id>` нормализуются в одно (`REF/dsh-client-modules/lib/client.js:89-100`).

### 1.2 Строка Loader в профиле (обязательна)

Сканер идёт по `ctx.loader.entries()` и берёт только записи с живым fiber и `!disabled`
(`REF/dsh-client-modules/lib/index.js:851-876`). Минимум — `PROF/@goodandready/dsh-russian-lang/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-russian-lang            # id записи Loader (host); он же ключ ctx.configForms и entryId в инвентаре
      name: '@goodandready/dsh-russian-lang'
```

`id` ≠ имя пакета ≠ id клиентской записи (последний случайный, §4.1).

### 1.3 Boot-граф и фасад `window.__ModuleLoader__`

Сервер отдаёт `<head>`-строки: инлайн-фасад очереди, preload батчей, bootstrap-скрипты, затем `window.__DSH_BOOT__`
(`REF/dsh-client-modules/lib/index.js:460-505`). Ядро строит `r.create({boot: t.__DSH_BOOT__, staticModules: SZ(), ...})`,
предзагружает `immediately`-тир и поднимает дерево (`SHELL:188-190`). Ядро фасада (токены дословно, форматирование
сжато; `REF/dsh-client-modules/lib/index.js:461-481`):

```js
window.__ModuleLoader__={ mode:"queue", pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){ /* материализует @deepseek-ai/dsh-client-modules, проверяет его exports face и вызывает
                       exports.createClientModuleSystem(this,{id:registration.id,exports},options) */ } }
```

`load` — просто очередь; после boot фасад переключается в live-режим и `load` сразу регистрирует фабрику
(`REF/dsh-client-modules/lib/client.js:692-700`).

### 1.4 Контракт модуля

Скелет бандла (`REF/dsh-client-locale/lib/client.js:1-23`, дословная структура):

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-locale",          // = имя пакета; суффикс "/client" срезается
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    exports.apply = apply; exports.inject = inject;   // inject — cordis-сервисы
    return module.exports;
  },
});
```

Чанк (`require.async("./client.x.js")`) регистрируется с полем `chunk: "client.<name>.js"`
(`REF/dsh-client-modules/lib/client.js:702-713`); повторная регистрация того же `id` без инвалидации бросает
`duplicate factory registration`. Резолвинг `require` (`ibid:832-849`): platform seed → материализованный модуль →
зарегистрированная фабрика (рекурсивно) → throw. Platform seed ровно (`SHELL:188`, `SZ()`): `react`, `react/jsx-runtime`,
`react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`,
`@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`.
Остальное — только через `dsh.client.external`; value-импорты между плагинами запрещены соглашением
(`TMP/dsh-client-ui-settings/lib/client.js:1245-1250`).

### 1.5 Как потребляются `exports`

Loader импортирует модуль и монтирует как cordis-плагин: `unwrapExports(moduleNamespace)` →
`registry.plugin(plugin, config)` (`SHELL:17-18`; `TMP/cordis-plugin-loader/src/config/entry.ts:233-237`).

- `module.exports` — объект-плагин с `apply`; `inject` оттуда — cordis-сервисы; `name` (если экспортировать) станет именем fiber'а; `Config` клиенту не нужен.
- `apply(ctx, config)` получает `config === undefined` (клиентская запись создаётся `loader.create({name:id})`, `REF/dsh-client-modules/lib/client.js:483-491`); конфигурация — только через `ctx.configForms` (§6).
- `dsh.client.inject` (доставка кода) и `exports.inject` (активация по сервисам) — разные вещи, нужны оба.

### 1.6 Порядок загрузки, HMR, URL

- Записи стартуют конкурентно: `Promise.all(manifest.plugins.map(create))` + `loader.await()` (`REF/dsh-client-modules/lib/client.js:383-398`); порядок гарантирует только cordis-`inject`, не массив.
- `immediately: true` не ускоряет старт, только предзагружает код (`SHELL:190`).
- HMR смонтирован всегда (`REF/dsh-web-app/cordis.patch.yml:218-220`); stat-поллинг 500 мс → `clientModules.rebuilt(id)` → SSE `/plugins/events` (`REF/dsh-client-hmr/lib/index.js:9-17,45-115`). Dev-watcher нужен только для пересборок.
- Бандл: `/plugins/<package>/client.js?rev=<rev>`; чанки `/plugins/<package>/client.<name>.js?rev=`; combo `/plugins/??...&rev=` (`REF/dsh-client-modules/lib/index.js:933-997`); `rev` — из `mtime/ctime/size`, не хэш.

## 2. Cordis-контекст в `apply` (v4.0.5, `TMP/cordis/src/*.ts`; миксины — `SHELL:11-18`)

- `ctx.effect(execute, label?)` — регистрирует эффект и возвращает дисposer; `execute` → `() => void`, promise или iterable дисposer'ов; освобождение в обратном порядке при выгрузке fiber; `label` — для диагностики (`fiber.ts:415-418`).
- `ctx.inject(deps, cb)` — `deps: string[] | {name: config}`; запускает `cb(ctx2, config)`, когда сервисы активны; перезапускает при смене реализации; возвращает fiber (`registry.ts:176,300-302`).
- `ctx.get(name, strict=true)` — читает сервис без inject-требования; `undefined`, если не предоставлен; `strict` отсекает неактивного провайдера (`reflect.ts:225-243`).
- `ctx.provide(name, value)` — публикует сервис (владелец — текущий fiber), возвращает async-дисposer; повторная публикация бросает (`reflect.ts:267-305`).
- `ctx.on(event, cb)`/`ctx.emit` — шина, `{global:true, prepend:true}` для перехватов, возвращает дисposer (`events.ts`). `ctx.fiber` — `uid` (`null` после dispose), `state`, `name`, `entry?`, `config`, `await()` (`fiber.ts:184-201,335-354`).
- Всё созданное (регистрации слотов, подписки, observers, таймеры, обёртки) — через `ctx.effect`: HMR/выключение плагина снимут это само.

## 3. `ctx.locale` — рантайм локали

`LocaleRuntime` создаётся в `apply` плагина локали и публикуется как сервис `locale`
(`REF/dsh-client-locale/lib/client.js:1517-1526`); сам плагин: `inject = ["slots","remote","configForms"]`
(`ibid:1490-1495`) + `dsh.client.inject` §1.1.

| Метод (строки `REF/dsh-client-locale/lib/client.js`) | Поведение |
|---|---|
| `getLocale()` 1232; `getSnapshot()` 1250 | `{active, locales:[{id,label,fallback?}], revision}`, frozen, стабильная ссылка до изменения |
| `subscribe(fn)` 1260 | `fn()` без аргументов на каждое изменение; возвращает unsubscribe |
| `translate(ns,key,params?)` 1423 | см. §3.1; `lookup(ns,key,chain)` 1429 — внутренний, но вызываемый |
| `bind(ns)` 1414 | кэшированная `(key,params) => this.translate(ns,key,params)` |
| `register(ns,dicts)` / `register(ns,locale,dict)` 1387 | 2-арг `{zh,en}`, 3-арг один язык; возвращает дисposer ровно на свои записи |
| `addLanguage({id,label,fallback})` 1297 | fallback обязан существовать, цепочка — дойти до `en`; возвращает дисposer |
| `setLocale(id)` 1278 | единственная запись предпочтения; бросает на неизвестный id; пишет в host-настройки |
| `resolveText(text)` 1241 | строка → как есть; `LocalizedText`-карта → перевод; словари не использует |

Ошибки `register`: невалидный BCP-47 id, повторная пара (`ns`,`locale`) → throw; повторное удаление — no-op.

### 3.1 Семантика `translate` и рецепт перехвата

```js
translate(ns, key, params) {
  const chain = this.fallbackChain(this.snapshot.active);
  const template = this.lookup(ns, key, chain) ?? (ns !== "common" ? this.lookup("common", key, chain) : void 0) ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
}
```

Промах → сам ключ (для 3-арг словарей это исходная китайская строка). Обёртка (`RL/lib/client.js:648-697`):

```js
ctx.effect(() => {
  const origTranslate = runtime.translate;                       // runtime = ctx.locale
  const wrapped = function (ns, key, params) {
    return origTranslate.call(this, ns, key, params);            // наш слой: кэш/мутация
  };
  runtime.translate = wrapped;
  return () => { if (runtime.translate === wrapped) runtime.translate = origTranslate; };  // не затираем поздние
}, 'auto-translate: translate-wrapper');
```

`RL` восстанавливает метод безусловно (`RL/lib/client.js:693`) — при нескольких перехватчиках ломает цепочку. Ставим на
**экземпляр** (`runtime.translate = ...`), не на прототип. Регистрировать словари в чужие namespace нельзя (дубликат пары
ns/locale): переводы чужих строк держим только в обёртке.

### 3.2 Ре-рендер после асинхронного перевода

Каждый outlet подписан на ревизию и пересоздаёт `t`-сиденья: `localeSeat(face, ns)` кэширует по `(face, ns, revision)`
(`REF/dsh-client-ui-renderer/lib/client.js:533-558`), `useLocaleRevision` = `face.subscribe`/`getSnapshot().revision`
(`ibid:567-590,1117-1120`). Ревизию бампает `publish` (`REF/dsh-client-locale/lib/client.js:1443-1455`) из
`register`/`addLanguage`/`setLocale`. Публичного «уведомить» нет; для позднего перевода в чужом namespace: (а)
регистрировать новую пару ns/locale каждый раз — штатно, но мусорно; (б) мутировать собственный объект словаря и звать
внутренний `locale.publish(locale.getSnapshot().active, false)` — не задокументировано, но стабильно в 0.2.1-rc.2 (метод
класса без `#`). Жёстко зашитый в JSX текст ревизией не лечится — только DOM-слой (§5).

## 4. Идентичность плагина и версия в браузере

### 4.1 Что доступно

- Клиентские пакеты: `ctx.modules.manifest.modules` / `.plugins`, `ctx.modules.graphRows` → `{id(=имя пакета), url, rev, inject, external}` (`REF/dsh-client-modules/lib/client.js:108-176,639-700`).
- `ctx.modules.manifest.rev` и релиз Host `{version, commit}` (`ibid:170-191`; `REF/dsh-client-modules/lib/index.js:539-543`).
- Свой пакет: `ctx.fiber.entry?.options.name` — id клиентской записи случайные 8 hex, `name` — пакет (`REF/dsh-client-modules/lib/client.js:483-491`; `SHELL:17`).
- Loader: `ctx.loader` (или `ctx.get('loader')`) → `entries()`, `locate(fiber)`, `resolve(id)` (`TMP/cordis-plugin-loader/src/index.ts:186-194`).
- Инвентарь: `inject: ['remote','remote.pluginInventory']` → `ctx.remote.pluginInventory.list()` (`REF/dsh-client-ui-settings-plugin-inventory/lib/client.js:723-742`). **Версии пакета в браузере нет** (§4.2).

### 4.2 Чего нет

Boot-граф (`REF/dsh-client-modules/lib/client.js:130-141,170-175`) версий не содержит. `pluginInventory/list` даёт
`entryId`, `moduleName`, `meta{title,description,icon,error}`, `enabled`, `fiberPhase`, `agentPresets` — без версии
(`REF/dsh-host-plugin-inventory/lib/typert.remote-client.js:7-48`). `ctx.slots`-записи владельца не дают:
`registrant = options.registrant ?? fiber.name`, а `fiber.name` у клиентских плагинов фактически `"root"`
(`SHELL:11,13`; предупреждение о подделке registrant — каталог типов в `TMP/dsh-cordis-client-runner/lib/client.js`).

### 4.3 Рекомендуемая схема «пакет+версия» для кэша

1. Своя host-ручка: `GET /api/auto-translate-ui/inventory` → `{hostRelease:{version,commit}, packages:{[pkg]:{version,dir}}}`. Источник на хосте — `ctx.get('pluginPackages').packageOf(specifier, parentURL)` →
  `{name,version,dir,manifestPath,manifest}` (`REF/dsh-app-boot/lib/index.js:3492-3566`) либо чтение `node_modules/<pkg>/package.json` (у `package.json` профиля только диапазоны, `PROF/../package.json`).
2. Клиент один раз тянет ручку (`fetch`, `accept: application/json`) и кэширует в памяти; ретрай по `connection/reset`/ошибке.
3. Namespace → пакет строим сами: явная таблица алиасов (как `PACKAGE_ALIASES`, `RL/lib/client.js:9-12`) + эвристики (`ns === pkg`, `pkg` без scope, без `dsh-`, `settings.<short>`). Универсальной связи нет.
4. Ключ кэша: `<pkg>@<version>|<dshVersion>:<ns>|<key>|<locale>`; без версии — `unversioned` + `rev` пакета.
5. DOM-строки: ключ по нормализованному тексту (+`data-slot`); пакет подставляется, если текст связан с namespace через наш реестр `text → {ns,key}` (аналог `translationRegistry`, `RL/lib/client.js:682`).

## 5. DOM: что есть и чего нет

### 5.1 Реальные маркеры

- `data-slot="<slotKey>"` / `data-slot-error` — outlet рендерера (`REF/dsh-client-ui-renderer/lib/client.js:1124`; ошибки — `ibid:643,1172,1239`): контейнер содержимого слота.
- `data-chat-flow`, `data-chat-turn`, `data-chat-node-key`, `data-chat-flow-kind`, `data-chat-group-part`, `data-chat-running`, `data-chat-motion`, `data-turn-tail`, `data-turn-process-*` — лента чата (`TMP/dsh-client-ui-chat/lib/client.js`); `flow-kind` = `tool`/`assistant`/`reasoning`/…
- `data-streaming` — reasoning/streaming-строки; `data-markdown-variant` — примитив `MarkdownText`, только `compact` (`SHELL:176`); `data-code-block-banner`/`data-code-block-content` — блок кода (примитивы в `SHELL`).
- `data-composer-*`, `data-lexical-editor`, `data-lexical-text` — composer (Lexical), ввод пользователя (`TMP/dsh-client-ui-conversation/lib/client.js`).
- `style[data-plugin="<pkg>"]` / `style[data-plugin-css="<id>"]` — единственные маркеры владельца-пакета, только на `<style>` (`REF/dsh-client-modules/lib/client.js:620-631`).

Атрибутов `data-dsh-plugin`/`data-plugin-owner` на контенте нет (грep по всем распакованным пакетам и `SHELL`).
Владельца строки из DOM не узнать.

### 5.2 Наблюдатель и безопасные исключения

```js
const SKIP = [
  '[data-no-translate],[data-no-translation],.no-translate',
  'code, pre, script, style, textarea, input, select, kbd, samp, math, .katex, [data-latex]',
  '[contenteditable="true"],[role="textbox"],[data-lexical-editor],[data-composer-input]',
  '[data-code-block-banner],[data-code-block-content],[data-streaming],[data-chat-running],[data-chat-motion]',
  '[data-markdown-variant],.footnotes,[data-footnotes]',            // содержимое модели не переводим
].join(',');
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;   // детектор иноязычности
const written = new WeakMap();                 // Text -> наша последняя запись (анти-эхо)
let scheduled = false;
const walk = (root) => {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const raw = n.nodeValue, p = n.parentElement;
    if (!raw || !raw.trim() || written.get(n) === raw || !p || p.closest(SKIP)) continue;
    const out = translateText(raw);            // синхронный кэш; иначе планируем async-перевод
    if (out !== null && out !== raw) { written.set(n, out); n.nodeValue = out; }
  }
};
const observer = new MutationObserver((records) => {
  for (const r of records) {
    if (r.type === 'characterData' && written.get(r.target) === r.target.nodeValue) continue; // наше эхо
    if (!scheduled) { scheduled = true; setTimeout(() => { scheduled = false; walk(document.body); }, 60); }
  }
});
ctx.effect(() => {
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}, 'auto-translate: dom-observer');
```

`characterData` обязателен: React обновляет текст на месте (`node.nodeValue = …`), и `childList`-only наблюдатель этого
не видит (у `RL` эта дыра: `RL/lib/client.js:877-881`). Анти-эхо через `WeakMap` обязателен, иначе цикл на собственных
записях. Идемпотентность: нет CJK/нет кэша — ничего не пишем; React перезапишет подмену при ре-рендере, наблюдатель
увидит characterData и переведёт снова. Атрибуты `title/placeholder/aria-label` правим отдельным проходом с тем же
`SKIP`; пропускаем узлы, пересекающиеся с текущим выделением (`getSelection().getRangeAt(0).intersectsNode(node)`).
Prior art `RL`: `ZH_WALKER`/`isProtectedTextNode` + дебаунс 80 мс (`RL/lib/client.js:813-867`), observer
`{childList,subtree}` + обход по `pointerup`/`click` (`ibid:869-886`), словари с host-ручек через `fetch` + Cache
API/`localStorage` с ETag (`ibid:521-575`), плагинные — лениво по имени namespace (`ibid:576-608`). Берём структуру
обхода, skip-селекторы, дебаунс, ленивую загрузку; не берём `childList`-only, безусловное восстановление `translate`,
широкие подстрочные эвристики (портят код/идентификаторы).

## 6. Интеграция настроек

### 6.1 `ctx.configForms` (`TMP/dsh-client-ui-settings/lib/client.js`)

- `ctx.configForms.get(entryId)` — форма **Host-записи Loader** (`id` из `cordis.patch.yml`, не имя пакета): `getSnapshot()` / `subscribe(fn)` / `set(field,value)` / `unset(field)` / `mutate(ops,
  expectedRevision?)`; snapshot `{status:'loading'|'ready'|'unavailable', value, base, user, revision, writable}` (`:1080-1244,1290-1301`).
- `ctx.configForms.whileServed(namespaces, register)` — `register(served)` вызывается, когда namespace есть в общем mirror; возвращает дисposer, оборачивать в `ctx.effect` (`:1302-1345`); `describe()` — общее зеркало настроек.

### 6.2 Куда регистрировать (каталог контрактов слотов в `TMP/dsh-cordis-client-runner/lib/client.js`)

- `settings.general.item` — строка в General (наш случай): `id`, `order`; `label` не проецируется — рисуем сами; `locale`+`inject`+`store` поддерживаются (`REF/dsh-client-locale/lib/client.js:1553-1560`).
- `settings.section` — отдельная страница: `id`, `order`, `label: string | (() => string)`.
- `plugins.item` — карточка на странице Plugins: `id`, `order`, `label`; обычно в `configForms.whileServed` (`RL/lib/client.js:1518-1526`). `settings.plugins.tab` — вкладка в Built-in plugins (`id`, `order`, `label`; `REF/dsh-client-ui-settings-plugin-inventory/lib/client.js:757-763`).

Регистрировать только через `ctx.slots.inject(name, () => ctx.slots.register(...))`: bare `register()` бросает на
необъявленном слоте (`GG/src/client/index.ts:262-269`). Компонент получает kit: `t` (если задан `locale`),
`useStore`/`actions` (если `store`), `renderSlot` (если дети), плюс результат `inject()`
(`REF/dsh-client-ui-renderer/lib/client.js:736-767`). `label`-thunk перечитывается при каждой проекции — локализация
следует за языком без перерегистрации.

### 6.3 Минимальный рабочий `client.js`

```js
window.__ModuleLoader__.load({
  id: '@scope/dsh-auto-translate-ui',
  factory: (require) => {
    const React = require('react')
    const NS = 'auto-translate', ENTRY_ID = 'auto-translate-ui'    // ENTRY_ID — id строки Loader (host)
    const RU = { title: 'Автоперевод интерфейса' }, EN = { title: 'Automatic UI translation' }
    function SettingsRow({ t, subscribe, getSnapshot, set }) {
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
      const enabled = snapshot.value?.enabled === true
      return React.createElement('label', null,
        React.createElement('input', { type: 'checkbox', checked: enabled, disabled: !snapshot.writable,
          onChange: (event) => set('enabled', event.target.checked) }),
        React.createElement('span', null, t('title')))
    }
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'auto-translate: en')
      ctx.effect(() => ctx.locale.register(NS, 'ru', RU), 'auto-translate: ru')
      if (!ctx.locale.getLocale().locales.some((l) => l.id === 'ru')) {
        ctx.effect(() => ctx.locale.addLanguage({ id: 'ru', label: 'Русский', fallback: 'en' }), 'auto-translate: ru-lang')
      }
      const form = ctx.configForms.get(ENTRY_ID)
      const subscribe = (fn) => form.subscribe(fn), getSnapshot = () => form.getSnapshot()
      const set = (field, value) => form.set(field, value)
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item', id: 'auto-translate', order: 40, locale: NS,
        inject: () => ({ subscribe, getSnapshot, set }),
      }, SettingsRow))
    }
    return { apply, inject: ['slots', 'locale', 'configForms'] }
  },
})
```

Host-половина: `Config`-схема (schemastery) с `.volatile()` и `ctx.settings.configure({ auto: false }, ctx.fiber)`, чтобы
DSH не генерировал автоматическую страницу (`PROF/../dsh-russian-lang/lib/index.js:60-75,135-163`; контракт —
`REF/dsh-settings/README.md:33-39`); подробности — `docs/research/host-api.md`.

## 7. Чеклист

1. `package.json`: `exports["./client"]`; `dsh.client = {platform:"web", inject:["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-slots"]}`; host `main` с
  пустым `apply`; bundle-patch профиля: `insert: [{id:"auto-translate-ui", name:"@scope/dsh-auto-translate-ui"}]`.
2. `client.js`: `load({id,factory})`; `require` только из seed; `exports = {apply, inject}`.
3. `apply`: `ctx.effect(register …)` для своих ru/en; `addLanguage('ru')` только если нет и в `try/catch`; `ctx.effect`-обёртка `translate` с chaining-восстановлением.
4. Асинхронные переводы: in-memory кэш + bump ревизии; лимит параллельных запросов и отрицательный кэш.
5. DOM: observer `{childList,subtree,characterData}`; `WeakMap`-анти-эхо; `SKIP` §5.2; идемпотентный детектор; отдельный проход по `title/placeholder/aria-label`.
6. Настройки: `settings.general.item` (+`settings.section`); форма — `ctx.configForms.get(<host entry id>)`.
7. Всё через `ctx.effect`; `fetch` с `AbortController`; после каждого `await` — проверка `ctx.fiber.uid === null`. Не полагаться на `ctx.loader.locate()` (id клиентской записи случайный); имя пакета — `entry.options.name`.
8. Проверка: `/plugins/<pkg>/client.js?rev=…` в Network; пакет в `ctx.modules.manifest.modules`; строка — Settings → Plugins → Plugin list.

## 8. Открытые вопросы и риски

1. **Версии в браузере нет** — нужна host-ручка (§4.3); формат/права уточняются в `host-api.md`.
2. **Атрибуция namespace → пакет** держится на эвристиках/таблице алиасов; ошибка портит только ключ кэша.
3. **`LocaleRuntime.publish`** — внутренний метод; при обновлении DSH может исчезнуть (переключатель на штатный `register` новой пары ns/locale). **`ctx.modules`** публикуется через
  `ctx.reflect.provide("modules", …)`; поля `manifest/factories/loadCache` не задокументированы как контракт — оборачивать в `try/catch`.
4. **Приоритет перехватов `translate`** с `dsh-russian-lang` контрактом не задан (конкурентный старт): нужен chaining и, желательно, ручное выключение одного из плагинов; двойной `addLanguage('ru')` бросает.
5. **Прямые записи в React-текст** — потенциально хрупко (dev-предупреждения, перезапись при ре-рендере); альтернативы на уровне React API нет.
6. **`data-markdown-variant`** ставится только для `compact`; обычный markdown-контейнер надёжного маркера не имеет — нужен отдельный тест на живом GUI и, возможно, эвристика/предок `data-slot`. **HMR** не
  сохраняет состояние: кэши/observer'ы пересоздаются при reload плагина; кэш переводов лучше держать в `localStorage`/`IndexedDB`.
7. **Живой браузер не проверялся** (GUI отдаёт 401 на голый запрос): выводы статические; проверку перехвата и `data-slot` делает harness из `docs/research/verify-harness.md`. Набор platform seed может измениться между релизами DSH — тогда понадобится `dsh.client.external`.
