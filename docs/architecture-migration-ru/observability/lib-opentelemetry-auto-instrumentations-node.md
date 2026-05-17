---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, observability, library, otel, instrumentation]
status: final
related:
  - "[[opentelemetry-overview]]"
  - "[[jaeger-backend]]"
  - "[[lib-opentelemetry-instrumentation-amqplib]]"
  - "[[lib-opentelemetry-sdk-node]]"
  - "[[lib-opentelemetry-api]]"
  - "[[rabbitmq-as-bus]]"
---

# Библиотека: @opentelemetry/auto-instrumentations-node

> [!abstract] Кратко
> `@opentelemetry/auto-instrumentations-node@^0.76.0` —
> **bundle** из ~30 инструментаций под популярные Node-модули:
> `http`, `mysql2`, `redis`, `amqplib`, `nestjs-core`,
> `express`, `pg`, `mongodb` и далее. Одна функция —
> `getNodeAutoInstrumentations()` — возвращает массив всех
> инструментаций, готовых к подключению через
> `NodeSDK({ instrumentations: [...] })`. Под капотом каждая
> инструментация регистрирует hook на `require()` через
> `require-in-the-middle`, и при первом подъёме модуля
> подменяет его экспорты на пропатченные. Это и есть тот
> механизм, благодаря которому в `tracer.ts` всего одна
> строка `getNodeAutoInstrumentations()` — а в Jaeger UI
> появляются span'ы на каждый HTTP-handler, SQL-запрос,
> Redis-команду и AMQP-publish.

## Проблема, которую решает

Альтернатива auto-instrumentation'у — **manual
instrumentation**: в каждом use-case'е, в каждом adapter'е
писать `tracer.startActiveSpan('name', async (span) => { ... })`.
Это работает, но:

- ~200 файлов в проекте надо было бы обернуть;
- каждый upgrade `@nestjs/microservices` или `mysql2` мог бы
  поломать span-shape;
- разработчик, забывший обернуть, тихо ломал бы trace-tree —
  ребёнок-span не находил бы родителя.

Auto-instrumentation решает это runtime-патчингом — **уровнем
ниже** app-кода. App-код не знает, что его HTTP-handler
обёрнут span'ом; SDK об этом знает за него.

Bundle-форма (`auto-instrumentations-node`) даёт ещё одну
выгоду: **одна** строка кода покрывает все стандартные модули.
Если завтра в проект придёт `pg` (PostgreSQL) — span'ы на
SQL-запросы появятся **сразу**, без правок `tracer.ts`.

## Применение в проекте

### Где подключается

```typescript
// libs/observability/tracer.ts
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  resource,
  traceExporter,
  // amqplib auto-instrumentation injects `traceparent` into AMQP message
  // headers on publish and extracts it on consume — which is how the
  // gateway → retail → inventory → notification trace stays a single
  // trace across RabbitMQ hops.
  instrumentations: [getNodeAutoInstrumentations()],
});
```

> [GitHub: libs/observability/tracer.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/tracer.ts#L17-L53)

Одна функция, один массив, всё.
`getNodeAutoInstrumentations()` без аргументов возвращает все
инструментации с default-конфигами. Если нужно тонко
настроить какую-то (например, выключить `instrumentation-fs`
для тишины) — функция принимает объект с per-instrumentation
options:

```typescript
getNodeAutoInstrumentations({
  '@opentelemetry/instrumentation-fs': { enabled: false },
})
```

В нашем `tracer.ts` без аргументов — пока все включены.

### Что попадает в bundle

Версия `0.76.0` тянет (среди прочего):

| Инструментация | Что патчит | Что мы получаем |
|---|---|---|
| `@opentelemetry/instrumentation-http` | Node `http`/`https`, `fetch` | Server-handler span'ы; outgoing-HTTP-client-span'ы; inject `traceparent` |
| `@opentelemetry/instrumentation-mysql2` | `mysql2` connection/query | Span на каждый SQL-запрос (`db.statement`, `db.system: mysql`) |
| `@opentelemetry/instrumentation-redis` | `@redis/client` | Span на каждую Redis-команду (`db.system: redis`) |
| `@opentelemetry/instrumentation-amqplib` | `amqplib`'s Channel | `publish`/`process` span'ы; inject/extract `traceparent` в headers AMQP-message'а |
| `@opentelemetry/instrumentation-nestjs-core` | NestJS controllers, microservice handlers | Span на каждый handler с context'ом класса/метода |
| `@opentelemetry/instrumentation-express` | Express middlewares | Под-span'ы на middleware-цепочку (известны шумом) |
| `@opentelemetry/instrumentation-fs` | Node `fs` | Span на каждый файл-read (избыточно для нашего use-case'а) |
| `@opentelemetry/instrumentation-net` | Node `net` | TCP-connection-span'ы (низкий уровень) |
| `@opentelemetry/instrumentation-dns` | Node `dns` | DNS-lookup-span'ы |
| `@opentelemetry/instrumentation-graphql` | `graphql`-resolvers | Не используем GraphQL — no-op |

Полный список — ~30 пакетов; см. `package.json`
`auto-instrumentations-node`'s peer-deps в node_modules. Те
инструментации, которые видят свой target-модуль в `require()`
— активируются; остальные просто молчат (отсутствие
`graphql` — это `enabled` но no-patch).

### Require-time patching: механика

`require-in-the-middle` — небольшая зависимость от Datadog,
которая регистрирует hook на CommonJS `require()`. Каждая
инструментация:

1. На `sdk.start()` зовёт `instrumentation.enable()`.
2. Это вызывает `Module._load`-shim, который регистрирует
   listener: «когда кто-то сделает `require('http')` — позови
   меня».
3. На **первом** `require('http')` (хоть из Nest, хоть из
   userland-кода) listener получает экспорты модуля, подменяет
   методы (`http.createServer`, `http.request`) на
   пропатченные обёртки.
4. С этого момента любой `http.createServer(...)`
   возвращает сервер, у которого каждый incoming-request
   автоматически оборачивается span'ом.

Это и есть **runtime monkey-patching**. Никакой кодогенерации,
никакого babel-plugin'а. Цена — `require()` стал чуть дороже
(одна функция на проход), но это разовое — после первого
импорта модуль закэширован.

### Почему **первая строка** `main.ts`

[[opentelemetry-overview]] §«Side-effect import» подробно
описывает правило, но повторим главное: если Nest успеет
`require('http')` **до** того, как `instrumentation.enable()`
зарегистрирует hook — Nest получит **непатченный** `http`-модуль.
Span'ов на HTTP-handler не будет, и SDK об этом не сообщит.

Это самый коварный класс багов. Решение —
`import '@retail-inventory-system/observability/tracer';`
**первой строкой** каждого `main.ts`, до любых других
импортов.

### `amqp-connection-manager` под капотом

В `package.json` мы используем `amqp-connection-manager` —
обёртку над `amqplib` для auto-reconnect. Возникает
естественный вопрос: «патч `instrumentation-amqplib`
сработает на обёртке?»

Ответ — **да**, потому что
`amqp-connection-manager` использует **реальные**
`amqplib`-Channel'ы под капотом. Когда `amqplib` загружается
(требование `amqp-connection-manager`), его экспорты
патчатся; обёртка получает уже-пропатченные Channel'ы.
Подтверждено манульным smoke-тестом ([carryover-10](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/tasks/_carryover-10.md)
§8 #3).

Это и причина, по которой
`@opentelemetry/instrumentation-amqplib` ([[lib-opentelemetry-instrumentation-amqplib]])
явно перечислен в `package.json` как top-level dep — даже
несмотря на то, что он уже входит в bundle. Версионная
пинировка важнее автоматики.

## Что этот пакет НЕ делает

- **Не реализует ни одну инструментацию сам.** Это просто
  **bundle** — каждая инструментация живёт в отдельном пакете
  (`instrumentation-http`, `instrumentation-mysql2`, …).
- **Не патчит TypeORM.** TypeORM не патчится напрямую (нет
  `instrumentation-typeorm` в bundle'е); вместо этого
  патчится `mysql2`-драйвер. Span'ы на SQL приходят
  оттуда, без TypeORM-метаданных.
- **Не патчит `@nestjs/microservices` transport.** Сам
  `@MessagePattern`-handler видится через
  `instrumentation-nestjs-core`; publish/consume на стороне
  AMQP — через `instrumentation-amqplib`.
- **Не работает на ESM-only-проектах без флага.** OTel
  частично поддерживает ESM, но в нашем CommonJS-проекте
  это не проблема.
- **Не патчит при install-time.** Только при `require()`.
  Если код когда-то импортирует модуль, обойдя `require`
  (через `import()`-async), патч может не сработать —
  редкий, но реальный риск.
- **Не дедуплицирует span'ы.** Если два HTTP-сервера в
  одном процессе слушают разные порты — каждый получает
  свой span на каждый запрос. Это by design.
- **Не задаёт sampling.** Сэмплирование — задача `NodeSDK`
  ([[lib-opentelemetry-sdk-node]]) и его `sampler`-аргумента.
- **Не задаёт format export'а.** Export — задача
  `[[lib-opentelemetry-exporter-trace-otlp-http]]`.

## Связанные решения

- [[opentelemetry-overview]] — общий контекст
  auto-instrumentation'а и правило «первой строки».
- [[jaeger-backend]] — там видно результат: span'ы каждого
  пропатченного модуля.
- [[lib-opentelemetry-instrumentation-amqplib]] —
  индивидуально пин'нутая инструментация, делающая
  cross-service-trace одним деревом.
- [[lib-opentelemetry-sdk-node]] — куда передаётся массив.
- [[lib-opentelemetry-api]] — `trace.getTracer('app-name')`,
  который каждая инструментация зовёт.
- [[rabbitmq-as-bus]] — какие AMQP-операции попадают под
  патч.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@opentelemetry/auto-instrumentations-node` | Bundle инструментаций. |
| `getNodeAutoInstrumentations(options?)` | Функция-фабрика; возвращает массив инструментаций. |
| `instrumentation` (концепт) | Объект с методом `.enable()`/`.disable()`; патчит конкретный модуль. |
| `require-in-the-middle` | NPM-пакет (от Datadog), перехватывающий `require()`. |
| Runtime monkey-patching | Подмена экспортов модуля в момент его подъёма. |
| `instrumentation-http` | Патч под Node `http`/`https`/`fetch`. |
| `instrumentation-mysql2` | Патч под `mysql2`-драйвер. TypeORM не патчится — она зовёт `mysql2` |
| `instrumentation-redis` | Патч под `@redis/client` (новый Redis-клиент). |
| `instrumentation-amqplib` | Патч под `amqplib`. См. dedicated-статью. |
| `instrumentation-nestjs-core` | Патч под Nest-handler'ы. |
| `instrumentation-fs` | Патч под Node `fs`. Шумный; можно выключить per-instrumentation. |
| `enabled` (опция) | Per-instrumentation-флаг для активации. |
| Bundle | Композитный пакет, тянущий другие пакеты как deps. |

> [!faq]- Проверь себя
> 1. Я добавил в проект `pg` (PostgreSQL-driver). Сколько
>    строк надо изменить в `tracer.ts`, чтобы получить
>    span'ы на SQL-запросы Postgres'а?
> 2. Если в код проекта попадёт `import http from 'node:http'`
>    (через ESM-import, обойдя `require()`) — будут ли
>    span'ы для HTTP-handler'ов?
> 3. Зачем `@opentelemetry/instrumentation-amqplib`
>    отдельно в `package.json`, если он уже входит в
>    bundle?
> 4. `getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })` —
>    что произойдёт при таком вызове? Какие span'ы
>    исчезнут?
> 5. TypeORM пишет в логах `query: SELECT ...`. Будут ли в
>    Jaeger'е соответствующие span'ы? От какого пакета?

## Что почитать дальше

- [`@opentelemetry/auto-instrumentations-node` README](https://www.npmjs.com/package/@opentelemetry/auto-instrumentations-node) —
  полный список включённых инструментаций.
- [`require-in-the-middle`](https://github.com/elastic/require-in-the-middle) —
  механика hook'инга `require()`.
- [OpenTelemetry Zero-code instrumentation in Node](https://opentelemetry.io/docs/zero-code/js/) —
  как auto-instrumentation подключается к существующему
  приложению без изменения кода.
