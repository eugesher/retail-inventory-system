---
created: 2026-05-15
updated: 2026-05-16
tags: [retail-inventory-system, observability, library, otel, amqp, rabbitmq]
status: review
related:
  - "[[opentelemetry-overview]]"
  - "[[jaeger-backend]]"
  - "[[lib-opentelemetry-auto-instrumentations-node]]"
  - "[[lib-opentelemetry-api]]"
  - "[[rabbitmq-as-bus]]"
  - "[[nest-microservices-transport]]"
  - "[[message-vs-event-patterns]]"
  - "[[routing-keys-and-contracts]]"
---

# Библиотека: @opentelemetry/instrumentation-amqplib

> [!abstract] Кратко
> `@opentelemetry/instrumentation-amqplib@^0.65.0` —
> **единственная** инструментация во всём OTel-стеке, без
> которой trace `gateway → retail → inventory → notification`
> превращается из одного дерева в четыре несвязанных
> «острова». Она патчит `amqplib`'s Channel: при `publish`
> инжектит W3C `traceparent`-заголовок в
> `properties.headers` сообщения, при `consume` — извлекает
> его обратно и восстанавливает trace-context. Под капотом
> `amqp-connection-manager` использует **реальные** amqplib
> Channel'ы, поэтому патч прозрачно работает через обёртку.
> Пакет уже входит в bundle
> `@opentelemetry/auto-instrumentations-node`, но мы держим
> его top-level-зависимостью в `package.json` именно ради
> явного version-pin'а — это **load-bearing** библиотека.

## Проблема, которую решает

Без неё каждый сервис получал бы свой собственный root-span
(потому что AMQP-consume не знал бы про
parent-span-publisher'а), и в Jaeger UI запрос
`PUT /api/order/:id/confirm` отображался бы как:

```
trace A   (api-gateway)    POST /api/order/:id/confirm   ← root, isolated
trace B   (retail)         retail.order.confirm process  ← root, isolated
trace C   (inventory)      inventory.order.confirm process ← root, isolated
trace D   (notification)   retail.order.confirmed process ← root, isolated
```

Четыре отдельных trace'а, без видимой связи. Operator,
смотрящий в Jaeger, видит «retail-handler был» и
«inventory-handler был», но не понимает, что они **тот же**
запрос. Это — фундаментальная проблема: HTTP-context (через
W3C `traceparent`-header) propagate'ится автоматически
(`instrumentation-http`), а AMQP — нет, если никто не пропишет
inject/extract вручную в payload.

`instrumentation-amqplib` пишет этот inject/extract **за
нас**, прозрачно для app-кода.

## Применение в проекте

### Где подключается

```typescript
// libs/observability/tracer.ts
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
// ...
instrumentations: [getNodeAutoInstrumentations()],
```

> [GitHub: libs/observability/tracer.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/tracer.ts#L17-L53)

Сам `instrumentation-amqplib` не упоминается явно — он
**внутри** bundle'а
`@opentelemetry/auto-instrumentations-node`. Но в
`package.json` он top-level:

```json
"@opentelemetry/instrumentation-amqplib": "^0.65.0",
```

Это сделано намеренно: bundle тянет его транзитивно, но если
завтра bundle решит сбросить версию — мы хотим иметь явный
pin, чтобы знать, какая именно версия патчит наш amqplib.
Без явного pin'а версия могла бы измениться неожиданно на
`yarn install` после обновления bundle'а.

### Что патчится

Инструментация патчит экспорты `amqplib`'а: класс `Channel`
и его методы:

- `Channel.publish(exchange, routingKey, content, options)` —
  запускается span `<exchange or queue> send` или `<...> publish`;
  W3C-propagator делает `inject(activeContext, options.headers)`,
  и `traceparent` уходит в headers AMQP-message'а.
- `Channel.sendToQueue(queue, content, options)` — аналогично.
- `Channel.consume(queue, callback)` — обёртка вокруг
  `callback`'а: на входе извлекает `traceparent` из
  `msg.properties.headers`, восстанавливает trace-context,
  запускает span `<queue> process` как ребёнок producer'а.
- `Channel.ack(msg)` / `Channel.nack(msg)` — закрывают span
  `process`. Это **место** «~62-секундной длительности»-артефакта
  в Jaeger UI, см. [[jaeger-backend]] §«Артефакт».

App-код всего этого не знает. `RetailRabbitmqAdapter` зовёт
`client.send(pattern, payload)`, под капотом `ClientProxy` из
`@nestjs/microservices` зовёт `Channel.sendToQueue(...)` —
и **в этот момент** `traceparent` инжектится. На consume
стороне — то же самое.

### Что в `properties.headers` сообщения

Если бы мы вытащили raw AMQP-message из RabbitMQ Management
UI, в `properties.headers` мы увидели бы (помимо
NestJS-метаданных):

```json
{
  "traceparent": "00-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d-1234567890abcdef-01",
  "tracestate": "",
  "...nestjs-routing-fields..."
}
```

`traceparent` — W3C-формат:
`version-traceId-spanId-flags`. `spanId` в заголовке — это
**span publisher'а**, и именно он становится parent'ом для
consume-span'а.

### `amqp-connection-manager`: почему работает

`package.json` подгружает `amqp-connection-manager` для
auto-reconnect. Возникает вопрос: если мы используем
**обёртку** над amqplib, патч от instrumentation-amqplib не
обходится?

Ответ — **нет**. `amqp-connection-manager` под капотом
требует `amqplib`'а и работает с реальными `Channel`-объектами
оттуда (а не с собственными wrapper-объектами). Когда
`amqplib` загружается через `require()`, его экспорты
патчатся; `amqp-connection-manager` получает уже-патченные
`Channel`'ы. Подтверждено манульным smoke-тестом ([carryover-10](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/tasks/_carryover-10.md)
§8 #3): `PUT /api/order/:id/confirm` даёт один trace со
span'ами всех четырёх сервисов.

### Реальная картина в Jaeger

После confirm-flow в Jaeger видно:

```
trace 1a2b…
└─ POST /api/order/:id/confirm           ← root, api-gateway HTTP-instrumentation
   ├─ retail_queue send                    ← amqplib-instrumentation, publish (gateway)
   │  └─ retail.order.confirm process       ← amqplib-instrumentation, consume (retail)
   │     ├─ UPDATE orders                    ← mysql2-instrumentation (retail)
   │     ├─ inventory_queue send             ← amqplib-instrumentation, publish (retail)
   │     │  └─ inventory.order.confirm process ← amqplib-instrumentation, consume (inventory)
   │     │     ├─ UPDATE product_stock        ← mysql2-instrumentation (inventory)
   │     │     └─ inventory.stock.low publish ← amqplib-instrumentation (inventory, conditional)
   │     │        └─ inventory.stock.low process ← amqplib-instrumentation (notification)
   │     └─ notification_events send         ← amqplib-instrumentation (retail)
   │        └─ retail.order.confirmed process ← amqplib-instrumentation (notification)
   └─ HTTP 200                              ← api-gateway HTTP-instrumentation
```

Каждый `publish`/`process` — span от
instrumentation-amqplib. Это и есть «дерево», для которого
вся эта статья.

### Что особенного в version `0.65.0`

Версия `^0.65.0` — относительно новая. До неё (вплоть до
`0.x` ранних) поведение `process`-span'а отличалось: span
закрывался **сразу** на возврат из callback'а, а не на
`channel.ack`. Это меняет картинку: ранние версии давали
короткие `process`-span'ы (~10ms), а теперь они закрываются
**на ack**, и могут «висеть» дольше — что и приводит к
артефакту «~62 секунды» в notification ([[jaeger-backend]]).

Это не баг, это сознательное изменение в дизайне:
correct-state, когда `process` корректно охватывает всё, что
происходит **внутри** обработки сообщения, включая внутренние
await'ы. Цена — некоторое визуальное «искажение» в UI для
наших asnyc-flow'ов, где `ack` может произойти позже самой
бизнес-логики.

## Что этот пакет НЕ делает

- **Не патчит сам RabbitMQ.** RabbitMQ — это сервер, не
  Node-модуль. Инструментация работает на client-side, в
  amqplib-коде в нашем Node-процессе.
- **Не патчит `amqp-connection-manager` напрямую.** Обёртка
  работает через amqplib-Channel'ы, которые уже патчены.
- **Не патчит `@nestjs/microservices`.** Транспортные
  абстракции Nest'а патчатся через
  `instrumentation-nestjs-core` ([[lib-opentelemetry-auto-instrumentations-node]]).
  Но **AMQP-publish/consume** видится отсюда.
- **Не пропагирует custom-headers.** Только W3C
  `traceparent`/`tracestate`. Если нужен B3-формат
  (Zipkin-стиль), пришлось бы заменить propagator на
  уровне SDK (через `propagation.setGlobalPropagator(...)`).
- **Не сериализует payload-сообщения как span-attribute.**
  Content message'а не попадает в span; это правильно
  (privacy + size).
- **Не дедуплицирует** span'ы при redelivery (с `noAck:
  false` и nack-redelivery каждое consume — отдельный
  `process`-span; они вложены в один и тот же
  publisher-parent).
- **Не задаёт sampling.** Sampling — SDK
  ([[lib-opentelemetry-sdk-node]]).
- **Не позволяет** «выключить inject, оставить только
  extract» через простую опцию — это **связанные**
  поведения. Если бы понадобилось отключить inject (например,
  ради downstream-системы, которая не выносит W3C-headers),
  пришлось бы патчить propagator.

## Связанные решения

- [[opentelemetry-overview]] — общая картина: span / trace /
  propagation; именно отсюда trace «лезет» в AMQP.
- [[jaeger-backend]] — Jaeger UI и артефакт «~62s»
  notification-consumer'а.
- [[lib-opentelemetry-auto-instrumentations-node]] — bundle,
  в котором эта инструментация уже сидит транзитивно.
- [[lib-opentelemetry-api]] — `trace.getTracer('amqplib-spans')`
  под капотом.
- [[rabbitmq-as-bus]] — какие очереди и через что они
  проходят.
- [[nest-microservices-transport]] — как `ClientProxy` зовёт
  amqplib под капотом.
- [[message-vs-event-patterns]] — `@MessagePattern` и
  `@EventPattern` обе становятся `process`-span'ами.
- [[routing-keys-and-contracts]] — `correlationId` в payload
  существует **параллельно** `traceparent` в headers.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@opentelemetry/instrumentation-amqplib` | Инструментация amqplib. |
| `amqplib` | Underlying AMQP-client для Node. |
| `amqp-connection-manager` | Wrapper над amqplib для auto-reconnect. Используется `@nestjs/microservices` RMQ-transport'ом. |
| `Channel.publish` / `sendToQueue` | Методы amqplib для отправки сообщения. Патчатся: inject `traceparent`. |
| `Channel.consume` | Метод amqplib для обработки. Патчится: extract `traceparent`, start child-span. |
| `Channel.ack` / `Channel.nack` | Методы amqplib для подтверждения. Патчатся: end `process`-span. |
| `properties.headers` | Подполе AMQP-message'а; именно сюда инжектится `traceparent`. |
| `traceparent` | W3C-header `version-traceId-spanId-flags`. |
| `tracestate` | Опциональный W3C-header для vendor-specific метаданных. |
| `publish`-span | Span на стороне producer'а. |
| `process`-span | Span на стороне consumer'а. Closes on `ack`/`nack`. |
| ~62s artefact | Particular notification-consumer span показ удлинён в Jaeger UI; не настоящая латентность. См. [[jaeger-backend]]. |
| Version pin | Явная top-level зависимость в `package.json` для контроля версии. |

> [!faq]- Проверь себя
> 1. Я удалил `@opentelemetry/instrumentation-amqplib` из
>    `package.json` (но bundle оставил). Что произойдёт в
>    Jaeger UI?
> 2. Я заменил `amqp-connection-manager` на голый `amqplib`.
>    Какие изменения произойдут в trace'ах?
> 3. RabbitMQ Management UI показывает сообщение, в
>    `properties.headers` которого нет поля `traceparent`.
>    О чём это говорит про producer'а?
> 4. `process`-span закрывается в `ack`. Что если в
>    handler'е забыли вызвать `ack` (или channel сделал
>    `nack` без redelivery)?
> 5. Я хочу, чтобы notification-consumer-span не был «62
>    секунды». Где надо менять — в `instrumentation-amqplib`,
>    в `amqp-connection-manager`, в Jaeger-UI-фильтре?

## Что почитать дальше

- [`@opentelemetry/instrumentation-amqplib` README](https://www.npmjs.com/package/@opentelemetry/instrumentation-amqplib) —
  список опций (есть ли preferred-span-naming, attribute-mask'и).
- [W3C Trace Context: AMQP propagation](https://w3c.github.io/trace-context-amqp/) —
  спецификация, по которой `traceparent` ходит в
  `properties.headers`.
- [`amqp-connection-manager` wrapping `amqplib`](https://github.com/jwalton/node-amqp-connection-manager) —
  устройство обёртки; почему patch'и проникают.
