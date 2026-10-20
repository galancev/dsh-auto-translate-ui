# Стенд проверки DSH-плагина без вмешательства в GUI

Статус: **работает**. `node tools/harness.mjs --smoke` поднимает второй изолированный
`dsh web`, устанавливает fixture-плагин реальным установщиком, проверяет авторизацию,
индекс, boot-graph, раздачу клиентского модуля, host-маршруты и API-admission,
гасит сервер и печатает PASS/FAIL. Эталонный прогон: **7 PASS, 1 SKIP, 0 FAIL,
exit 0** (SKIP — headless-браузер заблокирован песочницей DSH, см. §8).

Проверено на: DSH Desktop `0.2.1-rc.2` (Windows 11, x64), bundled Node `v24.21.0`,
bundled pnpm `11.28.5`, workspace-песочница `workspace-write`.
Пользовательский GUI на `http://127.0.0.1:50362` и `~/.dsh` **не затрагиваются**.

---

## 0. TL;DR

```powershell
$node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node tools\harness.mjs --smoke          # полный прогон; exit code 0 = PASS
& $node tools\harness.mjs --verbose        # без DOM-smoke, с деталями
& $node tools\harness.mjs --only api       # только проверки, чьё имя содержит «api»
& $node tools\harness.mjs --port 52001     # свой порт изолированного сервера
```

Всё изолированное состояние — `.verify/`. Удалить стенд целиком:
`Remove-Item -Recurse -Force .verify` (каталог уже в `.gitignore`).

Проверка будущего реального плагина (когда он появится):

```powershell
& $node tools\harness.mjs --plugin dsh-auto-translate-ui --plugin-spec link:. --profile verify-plugin --smoke
```

(отдельный профиль, чтобы незаконченный плагин не ломал fixture-прогоны)

---

## 1. Что именно проверяется

| # | Проверка | Что доказывает |
|---|---|---|
| 1 | `GET /` без cookie → **401** | браузерный auth-fence реально включён |
| 2 | `GET /?token=…` → **303** + `Set-Cookie` | launch-токен из stdout обменивается на подписанную cookie |
| 3 | `GET /` с cookie → **200** + boot-graph | авторизованный индекс и `globalThis["__DSH_BOOT__"]` |
| 4 | `GET /plugins/??<id>/client.js&rev=…` → **200** | клиентский модуль плагина **раздаётся по HTTP**, content-type `text/javascript`, тело содержит `window.__ModuleLoader__.load` |
| 5* | `GET /fixture/hello` → **200 JSON** | host-половина fixture смонтирована Loader'ом в изолированном сервере |
| 6* | `POST /fixture/echo` JSON → **200 эхо** | `probe.postJson` и POST на host-маршрут |
| 7 | `/api/nope` без cookie → **401**; `/connect` → **302** + cookie; `/api/nope` с cookie → **404** | API-канал закрыт, `/connect` выдаёт API-cookie, admission проходит |
| 8 | DOM-smoke (`--smoke`) | см. §8: VM-шим PASS, настоящий браузер — SKIP |

`*` — проверки, специфичные для fixture; для реального плагина пропускаются.

Проверки 1–4 и 7 — универсальные для любого web-плагина, потому что опираются только
на штатные механизмы DSH (auth, boot-graph, `/plugins`).

---

## 2. Изоляция: где что лежит

```
<workspace>/
├─ .verify/                          ← всё состояние стенда; можно удалить целиком
│  ├─ dsh-home/                      ← $DSH_HOME изолированного экземпляра
│  │  ├─ .credentials.yaml           ← секрет подписи cookie (создаёт BrowserAuth)
│  │  ├─ profiles/verify/            ← изолированный профиль
│  │  │  ├─ package.json             ← зависимости + dsh.profile.bundles
│  │  │  ├─ cordis.patch.yml         ← пользовательский слой профиля
│  │  │  ├─ pnpm-workspace.yaml      ← nodeLinker: hoisted
│  │  │  ├─ pnpm-lock.yaml
│  │  │  └─ node_modules/            ← junction на tools/fixture-plugin
│  │  ├─ storages/                   ← workspace.json и пр. состояние
│  │  └─ logs/                       ← startup-диагностика DSH (если были падения)
│  ├─ pnpm-store/                    ← store pnpm (флаг --store-dir)
│  ├─ logs/                          ← server.out.log, server.err.log, plugin-add.log…
│  └─ smoke/                         ← dump-dom.html / dump-dom.err.log (улики)
└─ tools/
   ├─ harness.mjs                    ← оркестратор (этот стенд)
   ├─ probe.mjs                      ← аутентифицированный HTTP-хелпер + CLI
   ├─ smoke-dom.mjs                  ← DOM-smoke: VM-шим + попытка headless-браузера
   └─ fixture-plugin/                ← крошечный проверочный плагин (bundle + client)
```

Env дочерних процессов (`isolatedEnv` в `tools/harness.mjs`):

| Переменная | Значение | Зачем |
|---|---|---|
| `DSH_HOME` | `.verify/dsh-home` | уводит профили/креды/сессии от `~/.dsh` |
| `DSH_AGENTS_HOME` | `.verify/agents-home` | не читать/писать общий `~/.agents` |
| `ELECTRON_RUN_AS_NODE` | `1` | Electron-бинарь работает как Node (так же, как `dsh.cmd`) |
| `DSH_DESKTOP_NODE_EXECUTABLE` | путь к `DeepSeek Harness.exe` | pnpm запускается тем же носителем |
| `DSH_TELEMETRY_DISABLED` | `1` | без телеметрии |
| `npm_config_store_dir` | `.verify/pnpm-store` | подстраховка; надёжно работает флаг `--store-dir` |
| `CI` | `1` | pnpm не интерактивен |

Гарантии чистоты:

* порт по умолчанию **51999** (не 50362 и не 3080); занятый порт = немедленный FAIL
  без попыток тронуть чужой процесс (проверено: чужой listener остаётся жив);
* `startServer()` регистрирует `stop()`, который убивает дерево процессов
  (`forceKillTree` → `taskkill /T /F`, затем `child.kill`), ждёт `exit` и **проверяет
  фактическое освобождение порта** через `netstat -ano` (факт `exit` родителя ещё не
  значит, что унаследованный слушающий сокет закрыт). Оставшихся слушателей НАШЕГО порта
  он добивает и, если порт всё ещё занят, падает громким FAIL'ом с pid'ами — тихой
  утечки процесса не бывает. `stop()` вызывается из `finally` (в т.ч. при исключении и
  `--only`); порт 51999 после успешного прогона свободен (проверяется вручную `netstat`);
* `--keep-server` оставлен только для ручной отладки в нормальном терминале;
* никаких записей в `~/.dsh`/`~/.agents`: при попытке запуска без `DSH_HOME` первая же
  инициализация профиля падает на `EPERM` из-за песочницы — поэтому harness всегда
  задаёт `DSH_HOME` явно.

---

## 3. Как поднимается второй `dsh web`

### 3.1. Носитель CLI

`resources/runtime/cli/bin/dsh.cmd` устроен так:

```bat
set "ELECTRON_RUN_AS_NODE=1"
"…\DeepSeek Harness.exe" --expose-internals "…\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
```

То есть CLI — это **Electron-бинарь в режиме Node** (только он умеет читать `app.asar`).
`dsh-desktop-host/lib/cli.js` вызывает `runCli()` из `@deepseek-ai/dsh/lib/bin.js` и
передаёт ему `packageManager` = `{ command: process.execPath, args: [pnpm.mjs] }`, то есть
`dsh plugin` использует **встроенный pnpm**.

`tools/harness.mjs` не дергает `.cmd` (кавычки в cmd проблемные) — он запускает
тот же бинарь напрямую:

```js
spawn(electron, ['--expose-internals', cliScript, '--profile', 'verify', '--host', '127.0.0.1',
                 '--port', '51999', '--no-open'], { env: isolatedEnv(electron), stdio: ['ignore', fd, fd] })
```

где `cliScript = <dirname exe>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`.
Проверять существование `cliScript` обычным `fs` нельзя (путь внутри asar) — harness
проверяет существование самого `app.asar`.

> **Важно для песочницы.** `child_process.spawn(..., { stdio: 'pipe' })` под песочницей
> DSH падает с `EPERM` (именованные каналы запрещены). Поэтому все дочерние процессы
> (сервер, pnpm, браузер) запускаются с `stdio: ['ignore', outFd, errFd]` — вывод пишется
> в файлы, а harness читает файлы. Тот же приём обязателен в любых будущих скриптах.

### 3.2. Флаги web-приложения

`dsh --profile <p> [launcher-флаги] [флаги приложения]`; после `--profile` всё, что не
принадлежит лаунчеру, уходит приложению. Флаги web-приложения (`dsh-web-app/lib/startup.js`):

| Флаг | Смысл |
|---|---|
| `--host <ip>` | конкретный локальный IP; wildcard запрещён |
| `--port <n>` | порт; `0` — выбрать свободный |
| `--no-open` | не открывать браузер |
| `--public-url <url>` | рекламируемый URL (не даёт trust) |
| `--trusted-host <authority…>` | доп. authority для `/api`-fence |
| `--tls-cert/--tls-key <file>` | HTTPS-листенер |

### 3.3. Изолированный профиль

Имена `web`, `headless`, `acp`, `sdk`, `sdk-minimal` — **штатные шаблоны**
(`PROFILE_TEMPLATES` в `@deepseek-ai/dsh-app-boot`), `desktop` зарезервирован за
Electron-приложением. Стенд создаёт собственный профиль `verify` из шаблона `web`
(слой `dsh-base` + `dsh-web-app`):

```powershell
# инициализирует профиль и печатает дерево, не монтируя плагины
& $exe --expose-internals $cli --profile verify --from-default-profile web --dump-config
```

`--dump-config` — самый дешёвый способ «создать профиль без запуска сервера»:
`prepareProfile()` вызывает `initializeProfileFromDefault()`, пишет `package.json`,
`cordis.patch.yml`, `pnpm-workspace.yaml`, `cordis.yml`, затем печатает композицию.
Файл `cordis.yml` — пустой корень-включение; реальная композиция собирается из слоёв.

### 3.4. Готовность и launch-токен

После успешного boot'а `dsh-web-app` печатает в stdout ровно одну строку
(`dsh-web-app/lib/index.js`):

```
dsh web: http://127.0.0.1:51999/?token=<launch-token>
```

`harness` ждёт эту строку (до 120 с), затем дополнительно ждёт, пока `GET /` начнёт
отвечать `401`/`200`. Токен живёт только в этом процессе (32 случайных байта base64url,
`PROCESS_LAUNCH_TOKENS` в `dsh-client-connection/lib/index.js`); на диск он не пишется,
поэтому потеря строки = перезапуск сервера. Строка с токеном остаётся в
`.verify/logs/server.out.log` — не публиковать её во внешних отчётах.

---

## 4. Авторизация HTTP API: как реально устроено

> Гипотеза из постановки — «за авторизацию отвечает `dsh-authorization`» — **неверна**.
> `@deepseek-ai/dsh-authorization` — про интерактивное получение *credentials*
> (OAuth/api-key flows для LLM-провайдеров), к HTTP-транспорту GUI она отношения не имеет.
> HTTP-авторизацию держит `@deepseek-ai/dsh-client-connection` (host-половина).

Цепочка ответственности:

* `@deepseek-ai/dsh-host-webserver` — «тупой» реестр маршрутов; **своей авторизации не
  имеет** («No server-wide authentication or origin policy — route owners enforce their
  own request policy»);
* `@deepseek-ai/dsh-host-frontend-static` — владелец fallback-места (SPA dist); на каждый
  индексный ответ зовёт `ctx.connection.authorizeIndex(req, res)`;
* `@deepseek-ai/dsh-client-connection` — единственный владелец `/api` и браузерной
  аутентификации: `/` (индекс), `/api/**` (prefix), `/connect` (exact); `/plugins/**`
  регистрирует `dsh-client-modules` и он **публичен**.

### 4.1. Launch-token

* генерируется на процесс: `randomBytes(32)` → base64url;
* печатается только в stdout-строке `dsh web:` как `?token=…` (переменная
  `DSH_WEB_URL` содержит рекламируемый URL **без** токена);
* принимается **только**:
  * `GET /` c ровно одним `?token=…` — обмен на браузерную cookie;
  * `GET /connect?token=…&interactions=answer|none` — обмен на API-cookie;
* **никакого `Authorization`-заголовка** не принимается; неверный/просроченный токен →
  `401`.

### 4.2. Браузерная сессия

`GET /?token=<ok>` → `303 Location: ./` + `Set-Cookie`:

* имя: `dsh-auth-<base64url(sha256(authority))>`, где `authority` = `host:port`
  (порт нормализуется, для TLS — `https:`-audience);
* значение: `v1.<base64url(payload)>.<base64url(HMAC-SHA256(payload))>`, payload =
  `{version, authority, issuedAt, expiresAt}`; секрет HMAC — owner-scoped запись
  `client-connection/browser-session` в `ctx.credentials`, локальный провайдер хранит её
  в `$DSH_HOME/.credentials.yaml` (в изолированном home — своя);
* атрибуты: `Path=/`, `HttpOnly`, `SameSite=Strict`, `Max-Age` = `cookieMaxAgeDays`
  (по умолчанию 30 дней), `Secure` только на TLS-листенере;
* cookie **привязана к authority** (host+port): cookie, снятая с порта 51999, не
  аутентифицирует другой порт.

### 4.3. API-сессия

`GET /connect?token=<ok>&interactions=answer|none` → `302 Location: ./api/remote.mux` +
отдельная cookie `v2` (с `id` Peer). `interactions` по умолчанию `none`; повторное
объявление или неизвестное значение → `400`. Дальше `ctx.connection.admit(request)`
проверяет:

1. **trust fence** (до всякой аутентификации): `Host` должен быть loopback, равен
   bind-IP листенера или входить в `trustedHosts`; `Origin`, если есть, обязан совпадать
   с authority; `sec-fetch-site: cross-site` запрещён. Провал → **403**.
2. **аутентификация**: подпись/срок/authority cookie. Провал → **401**.

Поэтому для API-проверок нужен `probe` с cookie из `/connect`, а для «просто HTTP» —
браузерная cookie из `GET /?token=…`.

### 4.4. Почему `http://127.0.0.1:50362` отвечает 401

Это тот же fence: у браузера пользователя cookie `dsh-auth-…` уже есть, а у «голого»
запроса без cookie — нет. Проверено однократным `Invoke-WebRequest`:

```
GET http://127.0.0.1:50362/  →  401 Unauthorized
```

Это поведение **ожидаемо**; стенд на 50362 не ходит и его не трогает.

### 4.5. Тело ответов

`401` — текст `dsh web authentication required; reopen the URL printed by dsh web.`
(либо `unauthorized` на `/api`), `403` — `forbidden`, `/connect` при неверном токене —
`401` с тем же текстом.

### 4.6. Опорные места в коде (0.2.1-rc.2)

| Файл | Что смотреть |
|---|---|
| `.reference/asar/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js` | `TOKEN_QUERY`, `AUTH_RECORD_KEY`, `BrowserAuth.authenticatedUrl/authorizeIndex/authorizeConnect/isAuthenticated`, `admit`, регистрация `/api` и `/connect` |
| `.reference/asar/dsh/node_modules/@deepseek-ai/dsh-host-frontend-static/lib/index.js` | fallback-место, `authorizeIndex` на индексе, «прочие ассеты публичны» |
| `.reference/asar/dsh/node_modules/@deepseek-ai/dsh-web-app/lib/index.js` | печать `dsh web: <authenticatedUrl>` и `--no-open` |
| `.reference/asar/dsh/node_modules/@deepseek-ai/dsh-client-connection/README.md` | раздел «Browser authentication and request trust» |

---

## 5. Установка плагина «как реальный установщик»

### 5.1. Что делает настоящий установщик

```
dsh plugin --profile <p> add <spec>
  → @deepseek-ai/dsh/lib/plugin-*.js: runPlugin()
  → @deepseek-ai/dsh-plugin-manager/lib/types/operations.js: runPluginCommand()
      → pnpm add <spec> (встроенный pnpm 11.28.5, cwd = каталог профиля)
      → reconcile(): для новых зависимостей с dsh.bundle.patch
           • валидирует патч-файлы, • дописывает имя в dsh.profile.bundles
  → профиль: package.json (dependencies + dsh.profile.bundles), pnpm-lock.yaml,
             node_modules/<name> (для link: — junction), .plugin-manager/logs
```

То есть **не нужно руками править `cordis.patch.yml`**: bundle-слой подключается через
`package.json → dsh.profile.bundles`, а сам патч-файл — из `dsh.bundle.patch` пакета.
Ровно это же делает кнопка «Install» в Web-плагин-менеджере (общая реализация
`installBundle`/`runProfilePnpm`).

### 5.2. Команда, которой пользуется стенд

```powershell
& $exe --expose-internals $cli plugin --profile verify `
       add "link:<repo>\tools\fixture-plugin" --store-dir "<repo>\.verify\pnpm-store"
```

* `link:` — dev-форма (junction на каталог), изменения в fixture видны без переустановки;
  реальный установщик так же ставит dev-плагины (`link:<абсолютный путь>`);
* `file:` — копирование/локальный tar-подобный вариант, `registry`/`git` — обычные спеки
  (и Fixture, и реальный плагин здесь не нуждаются в сети);
* `--store-dir` — единственный надёжный способ увести pnpm-store в `.verify`:
  переменные `npm_config_*` дочернему pnpm от `dsh plugin` не гарантированы (dsh чистит
  env для pnpm), а без флага pnpm создаёт `.pnpm-store` рядом с cwd. Флаг пробрасывается
  в pnpm как есть (`dsh plugin` форвардит аргументы).

Результат в `.verify/dsh-home/profiles/verify/package.json`:

```json
{
  "name": "dsh-profile-verify",
  "private": true,
  "dependencies": {
    "dsh-fixture-plugin": "link:<абсолютный путь к репозиторию>/tools/fixture-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-fixture-plugin"
      ]
    }
  }
}
```

### 5.3. Как устроен fixture-плагин

`tools/fixture-plugin/` — одновременно **bundle** и **плагин** (одно имя пакета):

| Файл | Роль |
|---|---|
| `package.json` | `name: dsh-fixture-plugin`, `type: module`, `exports["."]`, `exports["./client"]`, `dsh.bundle.patch`, `dsh.client.platform: "web"` |
| `cordis.patch.yml` | `insert: [{ id: fixture-plugin, name: dsh-fixture-plugin }]` — слой профиля |
| `lib/index.js` | host-половина: `name`, `inject: ["webServer"]`, `apply(ctx)` регистрирует `GET /fixture/hello` и `POST /fixture/echo` через `ctx.webServer.register(...)` + `ctx.effect` |
| `lib/client.js` | браузерная половина: `window.__ModuleLoader__.load({ id: "dsh-fixture-plugin", factory(require){…} })`; в `apply()` ставит `document.documentElement.dataset.fixturePlugin = "loaded"` |

Ключевые требования формата (см. §6):

1. `dsh.bundle.patch` → относительный путь к YAML-патчу; патч должен раскладываться
   (`loadOverlayPatches`) — иначе `dsh plugin add` откажется его активировать;
2. `dsh.client.platform === "web"` и `exports["./client"]` → **собранный** `client.js`;
   id клиентского модуля = `name` из `package.json` (никаких отдельных id);
3. host-половина не должна бросать на mount — иначе boot профиля падает и сервер не
   поднимется (ошибка будет в `.verify/logs/server.err.log`);
4. никаких зависимостей не нужно — fixture ставится офлайн.

---

## 6. Раздача клиентских модулей по HTTP

### 6.1. Как формируется граф

Host-половина `@deepseek-ai/dsh-client-modules` сканирует **живые Loader-записи**:
для каждого entry берёт манифест пакета, и если есть `dsh.client.platform === "web"` —
добавляет строку графа. `id` строки = имя пакета; путь к бандлу = `exports["./client"]`
(host-половина обязана потребовать его существования: «missing client bundle» = громкая
ошибка активации).

Индекс получает в `<head>` (в таком порядке): инлайн-фасад
`window.__ModuleLoader__` (queue-режим), preload-ссылки приложенческих combo,
parser-blocking combo бандла `@deepseek-ai/dsh-client-modules`, затем глобал
`globalThis["__DSH_BOOT__"] = { rev, release, entries, batches }`. **Ключ набора —
`entries`, а не `modules`.**

### 6.2. URL'ы

Для строки `{ id, url: "plugins/??<id>/client.js&rev=<rev>" }`:

* абсолютный URL одного модуля: `/plugins/??<id>/client.js&rev=<rev>`
  (это combo-форма; слэш перед `??` важен, `?` в пути — часть combo-ключа);
* ленивые чанки: `/plugins/<id>/client.<name>.js?rev=<rev>`;
* source map: тот же URL + `.map`.

Реально наблюдавшийся ответ:

```
GET /plugins/??dsh-fixture-plugin/client.js&rev=7cfdb96c4d6a
→ 200, text/javascript; charset=utf-8, cache-control: public, max-age=31536000, immutable, 1488 Б
   (без cookie — 200: маршрут публичен)
```

Тело начинается с обёртки:

```js
window.__ModuleLoader__.load({
  id: "dsh-fixture-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // …тело модуля…
    exports.apply = apply;
    return module.exports;
  }
});
```

Правила, которые проверены на живом сервере:

* `id` в обёртке **должен** совпадать с именем пакета (иначе браузер зарегистрирует
  «чужой» id и строка boot-graph не материализуется);
* объект `exports` — CJS-подобный; `apply`/`inject`/`name` — обычные поля (как в штатных
  бандлах, например `@deepseek-ai/dsh-experimental-client-ui-cot-translation`);
* `sourceMappingURL` не обязателен (карта строится identity-секцией);
* `rev` — метаданные файла (`mtimeMs/ctimeMs/size`), меняется при пересборке; стенд
  **не хардкодит** rev, а читает его из boot-graph.

### 6.3. Найти URL программно

`tools/probe.mjs` умеет разбирать граф:

```js
import { readFile } from 'node:fs/promises'
import { parseLaunchUrl, createProbe, parseBootGraph, bootEntry } from './tools/probe.mjs'

const launch = parseLaunchUrl(await readFile('.verify/logs/server.out.log', 'utf8'))
const probe = createProbe(launch)
await probe.exchangeBrowserSession()                       // cookie
const index = await probe.getAuthenticated('/')            // HTML 200
const graph = parseBootGraph(index.text)                   // { rev, release, entries, batches }
const row = bootEntry(graph, 'dsh-fixture-plugin')         // { id, url, rev }
const module = await probe.get('/' + row.url)              // 200 + JS
```

---

## 7. Инструменты и их интерфейсы

### 7.1. `tools/harness.mjs`

```
node tools/harness.mjs [--port N] [--smoke] [--only substring] [--verbose]
                       [--plugin NAME] [--plugin-spec SPEC] [--profile NAME]
                       [--force-install] [--keep-server]
```

* По умолчанию проверяет fixture (`dsh-fixture-plugin`,
  `link:<workspace>/tools/fixture-plugin`) в изолированном профиле `verify`.
* `--plugin/--plugin-spec` (или env `DSH_VERIFY_PLUGIN`/`DSH_VERIFY_PLUGIN_SPEC`) —
  переключение на реальный плагин; fixture-специфичные проверки автоматически SKIP.
  Для реального плагина берите **отдельный профиль** (`--profile verify-plugin`), чтобы
  сломанный плагин не блокировал boot fixture-профиля.
* Печатает `[PASS]/[SKIP]/[FAIL] <имя> — <улика> (<мс>)`, затем
  `Итог: N PASS, M SKIP, K FAIL`; exit code `0` только при `FAIL = 0`.
* Тайминги: тёплый прогон (профиль и плагин на месте) ≈ 3.3 с; холодный (init + pnpm add)
  ≈ 6–8 с; запуск сервера ≈ 2–4 с.
* Логи: `.verify/logs/server.out.log` (строка с токеном), `server.err.log`,
  `init-profile.log`, `plugin-add.log` (+ `.err`).

### 7.2. `tools/probe.mjs`

Модуль: `parseLaunchUrl`, `parseBootGraph`, `bootEntry`, `createProbe({origin, token})`:
`get/head/postJson/request`, `exchangeBrowserSession()`, `connectApi()`,
`ensureBrowserCookie()`, `ensureApiCookie()`, `getAuthenticated()`,
`apiGet()`, `apiPostJson()`. Ручные редиректы (можно инспектировать `303/302`),
таймаут на запрос (`AbortSignal.timeout`), разбор JSON при `content-type: application/json`.

CLI (нужен живой сервер):

```powershell
& $node tools\probe.mjs --log .verify\logs\server.out.log --no-body GET /
& $node tools\probe.mjs --log .verify\logs\server.out.log --api --no-body GET /api/nope
& $node tools\probe.mjs --origin http://127.0.0.1:51999 --token <t> --json '{"a":1}' POST /fixture/echo
```

### 7.3. `tools/smoke-dom.mjs`

```powershell
& $node tools\smoke-dom.mjs --log .verify\logs\server.out.log            # шим + браузер
& $node tools\smoke-dom.mjs --log .verify\logs\server.out.log --shim     # только VM-шим
& $node tools\smoke-dom.mjs --log .verify\logs\server.out.log --require-browser
```

Сам достаёт boot-graph, находит бандл плагина, исполняет его в `node:vm` и (если браузер
доступен) открывает `/?token=…` в headless Chrome/Edge с `--dump-dom`. Подробности и
ограничения — §8.

---

## 8. Headless-браузер: что удалось и что нет

### 8.1. Что найдено в системе

* `%ProgramFiles%\Google\Chrome\Application\chrome.exe` — есть;
* `%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe` — есть;
* `playwright`/`puppeteer` в workspace **не установлены** (`node_modules` плагина их не
  содержит; ставить не потребовалось);
* Electron-бинарь (`DeepSeek Harness.exe`) — это GUI-приложение, а не headless-браузер;
  запускать его как «третье окно» нельзя (конфликт с GUI пользователя), а как
  `ELECTRON_RUN_AS_NODE` он браузером не является.

### 8.2. Почему настоящий браузер не запускается из песочницы агента

Chromium/Edge используют **именованные каналы** (Mojo IPC) и crashpad; песочница DSH
запрещает и то, и другое. Наблюдаемые отказы (реальный stderr из
`.verify/smoke/dump-dom.err.log`):

```
[ERROR:third_party\crashpad\crashpad\client\crashpad_client_win.cc:430] OpenProcess: Access is denied. (0x5)
[ERROR:third_party\crashpad\crashpad\client\crashpad_client_win.cc:144] crash server failed to launch, self-terminating
```

Edge идёт дальше и падает на Mojo:

```
[FATAL:mojo\public\cpp\platform\platform_channel.cc:187] Check failed: . : Access is denied. (0x5)
```

Проверены варианты `--headless=new`, `--headless=old`, `--single-process`, `--no-zygote`,
`--in-process-gpu`, `--disable-crash-reporter` — результат один: браузер завершается на
этапе IPC, DOM не печатается (0 байт).

**Вывод:** автоматизировать DOM через настоящий headless-браузер *внутри песочницы
DSH-агента* нельзя. Из обычного терминала пользователя (вне песочницы) — должно работать,
и `tools/smoke-dom.mjs` для этого готов (см. 8.4), но это не проверено в данной сессии.

### 8.3. Что даёт VM-шим (работает всегда)

`runModuleShim()` берёт **реально разданный по HTTP** бандл и исполняет его в `node:vm`:

* подставляет `window.__ModuleLoader__` (queue-фабрика, собирает registrations),
  минимальный `document.documentElement.setAttribute/getAttribute`, заглушку `ctx`;
* проверяет: `id` = имя пакета; `factory` — функция; `factory(require)` материализуется;
  `apply()` вызывается без исключения; fixture ставит `data-fixture-plugin="loaded"`.

Это ловит синтаксис, неверный `id`, падения браузерной половины и регистрацию фабрики —
но **не** заменяет проверку реальным шпионом shell'а (React-дерево, слоты, HMR).
Поэтому уровень честно помечается SKIP, а не PASS.

### 8.4. Как запустить настоящий DOM-smoke

Из обычного (не песочного) терминала пользователя, при живом сервере:

```powershell
& $node tools/smoke-dom.mjs --log .verify\logs\server.out.log
# ожидаемо: [PASS] браузер Microsoft Edge: PASS — DOM … найден data-fixture-plugin="loaded"
```

Можно задать браузер: `--browser "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"` (или
env `DSH_SMOKE_BROWSER`). `--require-browser` превращает SKIP в FAIL — для CI-машины,
где браузер обязан работать.

### 8.5. HTTP-only fallback (по умолчанию в песочнице)

`harness` всегда проверяет: boot-graph содержит строку плагина, бандл отдаётся `200` с
правильным `content-type`, тело — валидная обёртка `window.__ModuleLoader__.load` с
правильным `id`, и эта обёртка исполняется шимом. Этого достаточно, чтобы поймать
«плагин не установился», «bundle не собрался», «client.js не объявлен/не раздаётся»,
«id не совпадает» — то есть большинство ошибок интеграции **до** появления реального UI.

---

## 9. Как проверить будущий реальный плагин

```powershell
$node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node tools\harness.mjs --plugin dsh-auto-translate-ui --plugin-spec "link:$((Get-Location).Path)" --profile verify-plugin --smoke
```

Отдельный профиль (`verify-plugin`) важен: если реальный плагин ещё не поднимается, его
boot падает, и все проверки в этом профиле становятся FAIL — но fixture-профиль `verify`
продолжает работать. Удалить профиль: `Remove-Item -Recurse -Force .verify/dsh-home/profiles/verify-plugin`.

Чек-лист для плагина (в порядке появления ошибок):

1. `package.json` объявляет `dsh.bundle.patch` (иначе `dsh plugin add` поставит пакет как
   обычную зависимость с предупреждением и не подключит bundle);
2. патч-файл — валидный YAML-массив loader-патчей (валидируется при установке);
3. `dsh.client.platform === "web"` и `exports["./client"]` указывает на **собранный**
   `lib/client.js` (в dev-профиле никто не собирает за вас: `pnpm run build`);
4. имя пакета = id клиентского модуля; обёртка `window.__ModuleLoader__.load({ id, factory })`;
5. host-половина не бросает на mount (иначе `server.err.log` и FAIL всех проверок):
   сервисы для `inject` должны существовать в web-профиле;
6. после правок перезапуск harness обязателен (новый сервер = новый boot профиля);
   live-HMR (`pnpm run dev:web` + `dsh-client-hmr`) стендом не используется.

Ожидаемый полезный вывод — строка `[PASS] client-module: … /plugins/??dsh-auto-translate-ui/client.js&rev=… → 200 …`
и (на машине без песочницы) `[PASS] dom-smoke`.

---

## 10. Ограничения и открытые вопросы

* **API unary RPC не перечислен.** Доказан только admission (`/api` с cookie проходит
  до 404), конкретные endpoint'ы (`/api/remote.*`, JSON-конверт `rpcId`) не
  инвентаризированы — для проверки UI-плагина обычно не нужно.
* **Desktop-shell путь аутентификации не исследован.** В Electron-приложении страница
  грузится по `file://`, а fetch идёт через IPC-мост/`__DSH_TRANSPORT__`; `50362` —
  это desktop-носитель, его auth может отличаться от `dsh web`. Стенд его сознательно
  не трогает.
* **HMR/live-composition не проверены** (нужен вотчер `pnpm run dev:web`, отдельный
  сценарий).
* **Токен не сохраняется на диск** — только stdout; при `--keep-server` строку берите из
  `.verify/logs/server.out.log`, после рестарта она недействительна.
* **Cookie привязана к host:port**, поэтому переиспользовать cookie между разными
  портами/запусками нельзя.
* **pnpm-операции** для `registry`/`git`-спеков потребуют сети; fixture ставится офлайн
  (`link:`), поэтому стенд работает без сети. `allowBuilds` для пакетов со скриптами —
  отдельная тема (`pnpm-workspace.yaml`).
* **Версионные exemption'ы** (`compatibility.json`, `allow-version`) не упражнялись:
  fixture их не требует.
* **Ленивые чанки и source map'ы** (`client.<name>.js`, `.map`) не проверяются — fixture
  их не имеет.

---

## 11. Журнал эталонного прогона

```
DSH verify harness
  workspace : <repo>
  DSH home  : <repo>\.verify\dsh-home
  профиль   : verify
  плагин    : dsh-fixture-plugin (link:<repo>\tools\fixture-plugin)
  порт      : 51999
[harness] плагин уже установлен: dsh-fixture-plugin → link:…\tools\fixture-plugin
[harness] запуск: dsh --profile verify --host 127.0.0.1 --port 51999 --no-open
[harness] сервер готов: http://127.0.0.1:51999 (pid 19880)

[PASS] auth-fence: GET / без cookie → 401 — 401 dsh web authentication required (13 мс)
[PASS] token-exchange: GET /?token=… → 303 + подписанная cookie — 303 → ./ ; cookie dsh-auth-mZKgvQqhgJ8S9Rl… (4 мс)
[PASS] index: аутентифицированный GET / → 200 + boot-graph — HTML 37640 Б, boot-graph rev c5fec349488c, строк 70 (10 мс)
[PASS] client-module: раздача /plugins/…/client.js по boot-graph — /plugins/??dsh-fixture-plugin/client.js&rev=7cfdb96c4d6a → 200, 1488 Б, text/javascript; charset=utf-8; без cookie: 200 (12 мс)
[PASS] host-route: fixture-маршрут регистрируется на web-сервере — 200 {"ok":true,"plugin":"fixture-plugin","route":"/fixture/hello","pid":19880} (5 мс)
[PASS] post-json: probe POST JSON → host-маршрут fixture — 200 {"ok":true,"plugin":"fixture-plugin","route":"/fixture/echo","received":{"ping":"harness","at":"fixture-echo"}} (11 мс)
[PASS] api: /api без cookie → 401, /connect → 302 + cookie, с cookie → admission пройден — 401 → 302 (cookie dsh-auth-mZKgvQqhgJ8S9Rl…) → 404 (20 мс)
[SKIP] dom-smoke: шим: PASS (id dsh-fixture-plugin; фабрика материализована; apply() вызван; документ помечен data-fixture-plugin=loaded); браузер Microsoft Edge: SKIP — не запускается в песочнице DSH (named pipes/OpenProcess): … OpenProcess: Access is denied. (0x5) | … mojo … Access is denied. (0x5) (228 мс)
[harness] сервер остановлен (pid 19880)

Итог: 7 PASS, 1 SKIP, 0 FAIL (всего 8)
```

Наблюдавшиеся факты:

* `GET /` без cookie → `401`, тело `dsh web authentication required; reopen the URL printed by dsh web.`;
* `GET /?token=…` → `303`, `location: ./`, `set-cookie: dsh-auth-mZKgvQqhgJ8S9Rl…` (имя = хэш authority `127.0.0.1:51999`);
* `GET /` с cookie → `200`, HTML 37 640 Б, в нём `globalThis["__DSH_BOOT__"]` с 70 строками;
* строка fixture: `{ id: "dsh-fixture-plugin", url: "plugins/??dsh-fixture-plugin/client.js&rev=7cfdb96c4d6a", rev: "7cfdb96c4d6a" }`;
* бандл → `200`, `text/javascript`, 1488 Б, обёртка `window.__ModuleLoader__.load`, публичен;
* `GET /fixture/hello` → `200 {"ok":true,"plugin":"fixture-plugin",…}`;
* `/api/nope` без cookie → `401`; `/connect` → `302 ./api/remote.mux` + cookie; `/api/nope` с cookie → `404` (admission пройден);
* после прогона порт 51999 свободен, процессов-сирот нет.

---

## Приложение A. Ручной запуск (если harness не нужен)

Один вызов PowerShell живёт, пока жив сервер, поэтому в одной команде:

```powershell
$root=(Get-Location).Path
$exe="$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$cli="$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
$node="$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$env:DSH_HOME="$root\.verify\dsh-home"; $env:ELECTRON_RUN_AS_NODE='1'
$out="$root\.verify\logs\manual.out.log"
$p = Start-Process -FilePath $exe -ArgumentList @('--expose-internals', "`"$cli`"", '--profile','verify','--host','127.0.0.1','--port','51999','--no-open') `
     -RedirectStandardOutput $out -RedirectStandardError "$out.err" -PassThru -NoNewWindow
try {
  while (-not ((Get-Content $out -Raw -ErrorAction SilentlyContinue) -match 'dsh web:')) { Start-Sleep -Milliseconds 300 }
  & $node tools\probe.mjs --log .verify\logs\manual.out.log --no-body GET /
  & $node tools\probe.mjs --log .verify\logs\manual.out.log --api --no-body GET /api/nope
} finally { & taskkill /PID $p.Id /T /F }
```

Из обычного терминала можно проще: `node tools/harness.mjs --keep-server` — harness
напечатает origin и pid, сервер останется жив до ручного `taskkill`.

> Ручной `taskkill` под песочницей может ответить `Access denied` (и тогда сервер
> останется жив). После ручного запуска проверяйте
> `netstat -ano | findstr :51999` и при необходимости повторяйте `taskkill /PID <pid> /T /F`
> либо полагайтесь на `tools/harness.mjs`, который освобождение порта проверяет сам.

## Приложение B. Где что искать в `app.asar`

Распакованная копия (только чтение): `.reference/asar/dsh/node_modules/@deepseek-ai/`.
Полный список файлов архива: `.reference/list-asar.mjs <подстрока>`, распаковка:
`.reference/extract-asar.mjs <имя-пакета> …` (класть можно только в `.reference/asar`).

| Пакет | Зачем открывался |
|---|---|
| `dsh-desktop-host/lib/cli.js` | как Desktop запускает CLI и встроенный pnpm |
| `dsh/lib/bin.js`, `profile-*.js`, `plugin-*.js` | парсинг CLI, профиль, `plugin add` |
| `dsh-app-boot/lib/index.js` | `PROFILE_TEMPLATES`, `initProfile`, `loadProfile` |
| `dsh-home-paths/lib/index.js` | `DSH_HOME`, `DSH_AGENTS_HOME` |
| `dsh-web-app/lib/{index,startup}.js` | флаги web-приложения, печать URL с токеном |
| `dsh-host-webserver/lib/index.js` + README | маршруты, отсутствие «серверной» авторизации |
| `dsh-client-connection/lib/index.js` + README | токен, cookie, `/connect`, `/api`, trust fence |
| `dsh-host-frontend-static/lib/index.js` | авторизация индекса, fallback-место SPA |
| `dsh-client-modules/lib/{index,client}.js` + README | boot-graph, `/plugins`, формат `__ModuleLoader__` |
| `dsh-plugin-manager/lib/types/operations.js` + README | `runPluginCommand`, `reconcile`, pnpm-окружение |
| `dsh-authorization/*` | проверено и **отброшено**: это credential-flows, не HTTP-auth |
