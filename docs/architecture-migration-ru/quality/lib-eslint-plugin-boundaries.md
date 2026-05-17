---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, quality, library, lint, architecture]
status: final
related:
  - "[[test-strategy]]"
  - "[[module-boundaries]]"
  - "[[hexagonal-architecture]]"
  - "[[clean-architecture-layers]]"
  - "[[shared-libs-philosophy]]"
  - "[[architecture-decision-records]]"
  - "[[use-cases-vs-fat-services]]"
  - "[[dto-by-direction]]"
  - "[[mappers-and-repositories]]"
---

# Библиотека: eslint-plugin-boundaries

> [!abstract] Кратко
> `eslint-plugin-boundaries@^6.0.2` — это lint-rule, который
> кодирует архитектурные правила проекта (`recommendation.md`
> §3 «Module boundary rules») как **eslint-конфиг**. Вместо
> «помните, что domain не должен импортировать TypeORM» —
> попытка такого импорта возвращает красную squiggle в
> редакторе и падающий `yarn lint` в CI. Источник правды —
> [`eslint.config.mjs`](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/eslint.config.mjs#L9-L413):
> 18 element-type'ов (по одному на слой и на shared-lib), один
> унифицированный `boundaries/dependencies`-rule с
> `default: 'disallow'` и `checkAllOrigins: true`, плюс
> per-source-disallow для денилистов внешних пакетов. Forced
> через `yarn lint --max-warnings 0` в CI (см. ADR-017 §5).
> Регрессии страхует
> [`tests/lint/architecture-lint.spec.ts`](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/tests/lint/architecture-lint.spec.ts) —
> spec, который при ослаблении правила падает до того, как
> плохой импорт долетит до production.

## Проблема, которую решает

К моменту task-11 миграции каждый сервис достиг целевой
формы (см. [[hexagonal-architecture]]), границы между
слоями зафиксированы в `recommendation.md` §3, а forbidden-
imports перечислены в `CLAUDE.md`. До task-12 эти правила
жили **в код-ревью**. Это работало, но имело две слабости,
названные ADR-017 «Context»:

1. **Regression drift.** Будущий PR незаметно вставит
   `Repository<XEntity>` в use-case или импортирует
   `@nestjs/cache-manager` за пределами `libs/cache`, и
   ревьюер пропустит. Архитектура декаирует **один PR за
   раз** — не сразу, но монотонно. К концу года таких PR'ов
   может быть десятки, и каждый по отдельности казался
   разумным.
2. **Onboarding friction.** Новый разработчик в команде
   читает `CLAUDE.md`, потом пишет код, потом узнаёт в
   ревью, что нарушает правило. Дорогой путь обучения.
   Красная squiggle в editor'е учит **на месте**.

`eslint-plugin-boundaries` решает обе сразу: правила
становятся **исполняемыми**, и каждое нарушение возвращает
конкретный rule-ID и pointer на файл, который видит
`yarn lint` в CI.

## Концепция

### Element types — словарь архитектуры в виде глобов

Плагин строит граф зависимостей не из директорий «как они
есть в файловой системе», а из **element-types**, которые
матчат шаблонные glob-pattern'ы. Каждый файл в проекте
получает один element-type (или ни одного — тогда он не
участвует в boundaries-checks).

В проекте — 18 element-type'ов (ADR-017 §2 + наблюдение в
коде):

| Element type | Pattern | Capture |
|---|---|---|
| `domain` | `apps/*/src/modules/*/domain/**` | `app`, `module` |
| `application-use-case` | `apps/*/src/modules/*/application/use-cases/**` | `app`, `module` |
| `application-port` | `apps/*/src/modules/*/application/ports/**` | `app`, `module` |
| `application-dto` | `apps/*/src/modules/*/application/dto/**` | `app`, `module` |
| `infrastructure` | `apps/*/src/modules/*/infrastructure/**` | `app`, `module` |
| `presentation` | `apps/*/src/modules/*/presentation/**` | `app`, `module` |
| `app-bootstrap` | `apps/*/src/main.ts`, `apps/*/src/app/**` | `app` |
| `app-shared` | `apps/*/src/common/**` | `app` |
| `lib-auth` / `lib-cache` / `lib-common` / `lib-config` / `lib-contracts` / `lib-database` / `lib-ddd` / `lib-messaging` / `lib-observability` | `libs/<name>/**` | — |

Source —
[`eslint.config.mjs` L9-L71](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/eslint.config.mjs#L9-L71):

```javascript
const boundariesElements = [
  {
    type: 'domain',
    pattern: 'apps/*/src/modules/*/domain/**',
    mode: 'file',
    capture: ['app', 'module'],
  },
  {
    type: 'application-use-case',
    pattern: 'apps/*/src/modules/*/application/use-cases/**',
    mode: 'file',
    capture: ['app', 'module'],
  },
  // ... остальные шесть app-layer элементов ...
  { type: 'lib-auth', pattern: 'libs/auth/**', mode: 'file' },
  { type: 'lib-cache', pattern: 'libs/cache/**', mode: 'file' },
  // ... остальные семь lib-* ...
];
```

`mode: 'file'` означает «каждый файл — отдельный element-
instance». Альтернатива — `mode: 'folder'` сжала бы все
файлы в директории до одного узла, но в проекте каждый
`.ts`-файл может зависеть от своего набора другого кода, и
file-mode позволяет линту видеть это.

### `capture: ['app', 'module']` — параметризация имени

`capture` — самая важная фича плагина для нашей архитектуры.
Когда element-type матчит file через
`apps/*/src/modules/*/domain/**`, плагин **запоминает**, что
матчил первый `*` (= имя app'а) и второй `*` (= имя
модуля). Эти captured-значения доступны как
`{{from.captured.app}}` и `{{from.captured.module}}` в
target-селекторах правил:

```javascript
const sameModule = (type) => ({
  to: {
    type,
    captured: {
      app: '{{from.captured.app}}',
      module: '{{from.captured.module}}',
    },
  },
});
```

> [`eslint.config.mjs` L82-L97](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/eslint.config.mjs#L82-L97)

Это значит: «домен файла в
`apps/inventory-microservice/src/modules/stock/domain/`
может импортировать из `domain`, но **только** в том же
самом `(app, module)`. Inventory'шный stock-domain не может
тянуть retail'овский orders-domain».

Без `capture` пришлось бы перечислить все пары вручную:
inventory/stock ↔ retail/orders, inventory/stock ↔
notification/notifications, gateway/auth ↔ gateway/retail
— это N×N комбинаций, exploding с каждым новым модулем.
Templates делают правило **полиморфным**: одна строка
покрывает все будущие модули, при условии, что они
соответствуют шаблону `apps/*/src/modules/*/`.

### Унифицированный `boundaries/dependencies` v6

В v6 API плагина (мы — `^6.0.2`) — один rule
`boundaries/dependencies` вместо двух старых
(`boundaries/element-types` для internal-edges +
`boundaries/external` для npm-disallowlist'а). Конфиг:

```javascript
'boundaries/dependencies': [
  'error',
  {
    default: 'disallow',
    checkAllOrigins: true,
    rules: dependencyRules,
  },
],
```

> [`eslint.config.mjs` L523-L532](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/eslint.config.mjs#L523-L532)

Три ключевых решения здесь:

1. **`default: 'disallow'`** — полярность по умолчанию
   запрещающая. Любой dependency-edge, не покрытый явным
   allow-rule, **запрещён**. Это «fail-closed» в
   терминологии безопасности: лучше получить случайный
   false-positive (легко исправить добавлением правила),
   чем silent permitting забытой комбинации.
2. **`checkAllOrigins: true`** — правила работают и для
   internal-импортов (через TS-paths), и для npm-пакетов
   (`@nestjs/common` и т.д.) одним и тем же механизмом.
3. **`rules: [...]`** — массив правил. `last match wins` —
   правила в конце массива переопределяют ранние.

### Catch-all для npm — index 0

Поскольку `default: 'disallow'`, без явного allow'а **ни
один npm-пакет** не разрешён. Это раздражающе и не нужно:
наш интерес — только в архитектурных правилах. Решение —
catch-all rule самым первым:

```javascript
{ from: { type: '*' }, allow: { to: { origin: ['external', 'core'] } } },
```

> [`eslint.config.mjs` L106-L111](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/eslint.config.mjs#L106-L111)

Это говорит: «любой source-type → любой target-origin
`'external'` (npm-пакет) или `'core'` (Node.js standard
library, например `crypto` или `path`) — разрешено».

Дальше в массиве — конкретные denylists, каждый из которых
**отменяет** часть этого blanket'а (last-match-wins).
Например, у `domain` есть запрет на `@nestjs/*`, который
последует **после** catch-all'а и поэтому перевешивает его
для domain-source'а.

ADR-017 §1 называет эту структуру «load-bearing»: убери
catch-all — и lint начнёт ошибочно ругаться на каждый
импорт `crypto` или `lodash`. Поэтому fixture-spec
(`tests/lint/architecture-lint.spec.ts`) проверяет и
catch-all (положительные кейсы: «разрешённое ребро не
flag'ает»), и denylists.

## Применение в проекте

### Internal-edges: domain → ddd, contracts, common

Самый строгий source — `domain`:

```javascript
{
  from: { type: 'domain' },
  allow: [sameModule('domain'), lib('lib-ddd'), lib('lib-common'), lib('lib-contracts')],
},
```

> [`eslint.config.mjs` L113-L117](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/eslint.config.mjs#L113-L117)

Domain может импортировать:

- Other files **в том же domain'е** (через
  `sameModule('domain')` — capture matched).
- `@retail-inventory-system/ddd` — базовые building-blocks
  (`AggregateRoot`, `Entity`, `ValueObject` — см.
  [[hexagonal-architecture]]).
- `@retail-inventory-system/common` — framework-free
  utilities (`Result`, `Maybe`, `DomainException`).
- `@retail-inventory-system/contracts` — типы (enum'ы).

Всё остальное — **запрещено**. Domain никогда не видит
`@nestjs/*`, `typeorm`, `nestjs-pino`. Это и есть «framework-
free domain», которая фиксируется ADR-004 §4.

### Internal-edges: use-case → ports, domain, lib-auth

Use-case (`application/use-cases/`) — слой, который чаще
всего ругают за «толстый сервис» (см.
[[use-cases-vs-fat-services]]). Allowed-list:

```javascript
{
  from: { type: 'application-use-case' },
  allow: [
    sameModule('domain'),
    sameModule('application-port'),
    sameModule('application-dto'),
    sameModule('application-use-case'),
    sameApp('app-shared'),
    lib('lib-ddd'),
    lib('lib-common'),
    lib('lib-contracts'),
    lib('lib-auth'),
  ],
},
```

> [`eslint.config.mjs` L120-L133](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/eslint.config.mjs#L120-L133)

Заметные точки:

- **`sameModule('application-port')`**, не `sameApp(...)`.
  Use-case из inventory'шного stock не может инжектить
  port'ы из retail'овского orders — это была бы cross-
  module-зависимость через DI, что нарушает изоляцию
  bounded context'ов.
- **`lib-auth` разрешён**, потому что use-case'ы
  notification-service'а и retail/orders инжектят
  `IAuthUserValidator`-port из `libs/auth`. Это исключение
  фиксировано здесь — других public-port'ов в lib'ах нет.
- **`@nestjs/typeorm`, `cache-manager`, `amqplib` —
  disallow.** Это в external-deny-блоке ниже (см. §5
  ADR-017): use-case ждёт port'ы, не adapter'ы.

### Internal-edges: cross-app isolation

Самое полиморфное правило — `sameModule(...)`. Из-за
template'ов оно **автоматически** запрещает кросс-app
импорты:

```typescript
// inventory'шный use-case пытается импортировать retail'овский domain:
// apps/inventory-microservice/src/modules/stock/application/use-cases/x.use-case.ts
import { Order } from '../../../../../retail-microservice/src/modules/orders/domain/order.model';
```

`{{from.captured.app}}` = `inventory-microservice`,
`{{to.captured.app}}` = `retail-microservice` — не совпадают,
match не происходит, fallback на `default: 'disallow'`,
**lint падает**.

Это правило настолько важно, что в `tests/lint/`-spec'е
оно отдельно протестировано:

```typescript
it('use case may not reach another app', () => {
  // 6 levels up: use-cases → application → stock → modules → src →
  // inventory-microservice → apps.
  const code = `import { Order } from '../../../../../../retail-microservice/src/modules/orders/domain/order.model';\nexport type Y = Order;\n`;
  const messages = lint(
    code,
    'apps/inventory-microservice/src/modules/stock/application/use-cases/__fixture__.ts',
  );
  expect(ruleIds(messages)).toContain('boundaries/dependencies');
});
```

> [`tests/lint/architecture-lint.spec.ts` L291-L300](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/tests/lint/architecture-lint.spec.ts#L291-L300)

Spec — это «бумпер»: если кто-то ослабит
`{{from.captured.app}}`-template до `*`, regression-spec
**упадёт** и PR не пройдёт. Это второй уровень защиты,
после самих rule'ов.

### External-denylists: per-source

Каждый source-type, у которого есть документированный
денилист в `recommendation.md` §3, получает свой
`disallow`-блок. Например, `application-port`:

```javascript
{
  from: { type: 'application-port' },
  disallow: {
    dependency: {
      module: [
        '@nestjs/common',
        '@nestjs/core',
        '@nestjs/microservices',
        '@nestjs/typeorm',
        '@nestjs/cache-manager',
        '@keyv/redis',
        'cacheable',
        'cache-manager',
        'redis',
        'amqplib',
        'amqp-connection-manager',
        'typeorm',
        'axios',
        'nestjs-pino',
      ],
    },
  },
},
```

> [`eslint.config.mjs` L320-L342](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/eslint.config.mjs#L320-L342)

Port'ы — это **интерфейсы**, не реализации. Они не должны
тянуть Nest-decorator'ы или ORM-классы. Note: `typeorm` в
этом списке — но **со звёздочкой**, см. §«Документированные
exception'ы» ниже.

### `lib-contracts` — документированное исключение

Recommendation table говорит «plain TypeScript only» для
`lib-contracts`. Это нарушено намеренно: contracts —
**wire-format-DTO**, и они несут `class-validator` +
`class-transformer` + `@nestjs/swagger`-декораторы для
Scalar-OpenAPI-viewer'а на gateway. Если убрать их — нужно
поддерживать **два параллельных дерева DTO** (один в
`libs/contracts` без декораторов для wire-format, второй в
`apps/.../presentation/dto/` с декораторами для Swagger).
Два дерева — двойная поверхность для рассинхрона.

Поэтому `lib-contracts`-disallow выглядит так:

```javascript
{
  from: { type: 'lib-contracts' },
  disallow: {
    dependency: {
      module: [
        '@nestjs/common',
        '@nestjs/core',
        '@nestjs/microservices',
        '@nestjs/typeorm',
        '@nestjs/jwt',
        '@nestjs/passport',
        '@nestjs/cache-manager',
        'typeorm',
        '@keyv/redis',
        'cacheable',
        'redis',
        'amqplib',
      ],
    },
  },
},
```

> [`eslint.config.mjs` L373-L393](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/eslint.config.mjs#L373-L393)

— `@nestjs/swagger`, `class-validator`, `class-transformer`
**не** в denylist'е. ADR-017 §4 фиксирует это как
«документированное исключение».

### Документированные exception'ы: ARCH-LINT-EX-01

Один production-файл импортирует `EntityManager` из
`typeorm` — нарушение
`application-port`-denylist'а. Это шов для unit-of-work
транзакции; closing'а требует `ITransactionPort`, который
ещё не построен. Пока — inline `eslint-disable`:

```typescript
// TODO(task-14): introduce an `ITransactionPort` so callers can pass an
// opaque unit-of-work token instead of TypeORM's EntityManager. Tracked in
// _carryover-12.md as ARCH-LINT-EX-01.
import { EntityManager } from 'typeorm'; // eslint-disable-line boundaries/dependencies
```

> [`apps/inventory-microservice/.../stock.repository.port.ts` L1-L4](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts#L1-L4)

И второй файл — use-case, который инжектит
`InjectEntityManager`:

```typescript
// TODO(task-14): replace the raw `@nestjs/typeorm` + `EntityManager` seam
// with an `ITransactionPort` so this use case no longer reaches into the
// ORM directly. Tracked in _carryover-12.md as ARCH-LINT-EX-01.
import { InjectEntityManager } from '@nestjs/typeorm'; // eslint-disable-line boundaries/dependencies
```

> [`apps/inventory-microservice/.../reserve-stock-for-order.use-case.ts` L1-L5](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts#L1-L5)

Оба `eslint-disable-line`-комментария содержат:

- **Tracking code** `ARCH-LINT-EX-01` — для grep'а через
  все exception'ы в кодовой базе.
- **TODO с задачей закрытия** `task-14`. Когда
  `ITransactionPort` появится, оба disable-line снимаются;
  если ничего не сломалось — exception закрыт.

Реверсиров — это контрольная точка: если кто-то добавит
ещё одно `eslint-disable boundaries/dependencies` без
tracking-code'а, audit'ом ловится `grep -rn 'eslint-disable
.* boundaries' apps libs` и сверяется со списком известных
exception'ов в ADR-017 §6.

### Regression-spec: бумпер для слабления правил

`tests/lint/architecture-lint.spec.ts` — отдельный spec,
который **дублирует** часть правил из `eslint.config.mjs` и
гоняет их через programmatic `Linter` от ESLint. Один
позитивный кейс:

```typescript
it('domain importing lib-ddd is allowed', () => {
  const code = `import { AggregateRoot } from '@retail-inventory-system/ddd';\nexport const x = AggregateRoot;\n`;
  const messages = lint(
    code,
    'apps/inventory-microservice/src/modules/stock/domain/__fixture__.ts',
  );
  const boundariesMessages = messages.filter((m) => (m.ruleId ?? '').startsWith('boundaries/'));
  expect(boundariesMessages).toEqual([]);
});
```

> [`tests/lint/architecture-lint.spec.ts` L322-L330](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/tests/lint/architecture-lint.spec.ts#L322-L330)

И один негативный — для cross-element-denial:

```typescript
it('presentation may not import infrastructure', () => {
  const code = `import { StockCache } from '../infrastructure/cache/stock.cache';\nexport const y = StockCache;\n`;
  const messages = lint(
    code,
    'apps/inventory-microservice/src/modules/stock/presentation/__fixture__.ts',
  );
  expect(ruleIds(messages)).toContain('boundaries/dependencies');
});
```

> [`tests/lint/architecture-lint.spec.ts` L302-L309](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/tests/lint/architecture-lint.spec.ts#L302-L309)

**Важная деталь:** spec **инлайнит** subset правил
вручную, а не импортирует из `eslint.config.mjs`. Цена —
если правило в production меняется, нужно синхронизировать
inline-копию. Польза — spec **самодостаточен**: если
будущий PR разнесёт config на несколько файлов, spec
продолжит работать. ADR-017 §7 явно записывает это
как trade-off.

Spec — это **бумпер**, не contract-test: он не проверяет,
что spec-копия равна production-копии. Он проверяет, что
для **inlined-набора** правил каждое правило fire'ит
ожиданно `boundaries/dependencies`-ruleId. Если кто-то
ослабит правило в production и забудет в spec'е —
production станет менее строгим, а spec продолжит
зелёным. Это не идеально, но закрывает 80% реальной
угрозы: silent loosening **обеих сторон** требует двух
согласованных PR-edits, что редко бывает случайным.

### CI-интеграция

`yarn lint --max-warnings 0` — единственный шаг. Конфиг
плагина живёт в том же `eslint.config.mjs`, что и общие
правила (no-explicit-any, prettier, naming-convention), и
запускается в одном вызове.

ADR-017 §5 явно отвергает альтернативу «отдельный
`yarn lint:architecture` + отдельный CI job»: разделение
поверхностей увеличивает шанс «я запустил один, забыл
другой», и duplicate-install/checkout-cost не приобретает
ничего ценного. CI-workflow
`.github/workflows/ci-cd.yml` уже гонит `yarn lint` как
gating-step — boundaries-rules исполняются в нём же.

### Что плагин НЕ делает

Список ограничений важен — он сужает, на что плагин не
может опереться:

1. **Не enforce'ит import-order.** Правило
   «`@retail-inventory-system/observability/tracer` —
   **первый** импорт в каждом `main.ts`» (ADR-014, см.
   [[opentelemetry-overview]]) — это `import/order`-rule,
   не `boundaries`-rule. Сегодня этот шаг enforce'ится
   код-ревью; будущий task может добавить custom-rule.
2. **Не enforce'ит API-shape ports.** Плагин видит, что
   `application-port` импортирует `typeorm` — это плохо. Но
   он не видит, что метод `findById` возвращает
   `Promise<Order | null>` — это hint для применительной
   логики, который остаётся в TypeScript-compiler'е.
3. **Не enforce'ит naming-conventions** (`*.use-case.ts`,
   `*.port.ts`, `Module` suffix). Имена файлов — это либо
   `eslint-plugin-filename-rules`, либо
   `@typescript-eslint/naming-convention` (последнее уже
   включено для interface-`I*`-prefix'а и
   enum-`*Enum`-suffix'а).
4. **Не подменяет код-ревью.** Lint ловит «не туда
   импортировал»; ревью ловит «не туда положил всю
   логику». ADR-017 §«Negative» прямо это говорит: «the
   element-type taxonomy doubles as a vocabulary for code
   review».
5. **Не работает на ослабленных `eslint-disable-line`.**
   Любая строка с `eslint-disable-line boundaries/dependencies`
   проходит — поэтому документированные exception'ы — это
   политический коммитмент, а не code-enforcement.

## Связанные решения

- [[test-strategy]] — `tests/lint/architecture-lint.spec.ts`
  как бумпер; вписана в общую тест-стратегию.
- [[module-boundaries]] — концепт «что куда может
  импортировать»; этот плагин — его исполняющий механизм.
- [[hexagonal-architecture]] — layer-shape, который lint
  кодирует.
- [[clean-architecture-layers]] — четырёхслойный split
  `domain → application → infrastructure / presentation`,
  отображённый в element-type-таксономии.
- [[shared-libs-philosophy]] — карта lib'ов
  (`lib-contracts`, `lib-ddd`, …) и их allowed-edges.
- [[use-cases-vs-fat-services]] — `application-use-case`
  как element-type; почему его external-denylist именно
  такой.
- [[dto-by-direction]] — `application-dto` — отдельный
  element-type; почему request/response/command/query/view
  суффиксы попадают в один и тот же бакет.
- [[mappers-and-repositories]] — `infrastructure` —
  единственное место, где живут TypeORM-репозитории.
- [[architecture-decision-records]] — ADR-017 как пример
  decision-record'а enforcement'а.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| Element type | Логический тип файла в плагине; назначается через glob. |
| Pattern | Glob, который матчит файлы для element-type'а (`apps/*/src/modules/*/domain/**`). |
| `capture` | Список именованных wildcard'ов в pattern'е; `[app, module]` запоминает первые два `*`. |
| `{{from.captured.x}}` | Template-syntax: подставляет captured-значение source-файла в target-селектор. |
| `boundaries/dependencies` | Единственный rule в v6 API плагина; объединяет internal + external checks. |
| `default: 'disallow'` | Полярность по умолчанию: всё, что не разрешено явно — запрещено. |
| `checkAllOrigins: true` | Опция: проверять и npm, и internal-imports. |
| `last match wins` | Семантика массива правил: позднейшее переопределяет ранее. |
| Catch-all | Самое первое правило: blanket-allow всех external + core пакетов. |
| Origin (`external`/`core`) | Тип target'а: `external` — npm, `core` — Node-stdlib (`crypto`, `path`). |
| Internal edge | Зависимость между двумя app/lib-файлами в репо. |
| External edge | Зависимость на npm-пакет или Node-core. |
| `sameModule(type)` | Helper: target-селектор для of-same-`{app, module}` files. |
| `sameApp(type)` | Helper: target-селектор для of-same-`{app}` files. |
| `lib(type)` | Helper: target-селектор без capture'а — для `lib-*`-typed files. |
| Source-source rule | Правило с `from: {type: 'X'}` — определяет, **из** какого слоя. |
| Target-selector | `to: {...}` блок — определяет, **во что** разрешено/запрещено. |
| `disallow.dependency.module` | Список npm-пакетов в denylist'е для данного source-type'а. |
| `eslint-disable-line` | Inline-комментарий, отключающий правило на одной строке. |
| Tracking code | Стандартизированный идентификатор exception'а (например, `ARCH-LINT-EX-01`). |
| ADR-017 | Decision-record, фиксирующий выбор плагина и правил. |
| `boundariesElements` | Массив element-type'ов в `eslint.config.mjs`. |
| `dependencyRules` | Массив rule-объектов; первая запись — catch-all, дальше per-source. |
| Regression spec | `tests/lint/architecture-lint.spec.ts`; бумпер от silent loosening. |
| Fixture | Hand-crafted source-string в spec'е; имитирует production-файл. |
| `Linter.verify(code, config, { filename })` | Программный API ESLint'а; даёт synthetic filename для матчинга element-pattern'а. |
| Bumper (vs contract test) | Spec, ловящий ослабление правила, не drift между spec'ом и prod'ом. |
| `boundaries/no-unknown` | Правило плагина, off-by-default в проекте: «файл без element-type'а — error». |

> [!faq]- Проверь себя
> 1. `eslint.config.mjs` начинается с `default: 'disallow'`,
>    а первым в `dependencyRules` идёт catch-all
>    `from: { type: '*' }, allow: { to: { origin:
>    ['external', 'core'] } }`. Что произойдёт, если убрать
>    этот catch-all?
> 2. Что такое `capture: ['app', 'module']`, и какую
>    проблему оно решает по сравнению с явным
>    перечислением (X, Y)-пар allowed-targets?
> 3. `application-port`-denylist включает `typeorm`. Но
>    `stock.repository.port.ts` импортирует `EntityManager`
>    из `typeorm` — и lint не падает. Почему? Какой
>    механизм это позволяет, и какое его trade-off?
> 4. `tests/lint/architecture-lint.spec.ts` инлайнит копию
>    rule'ов вместо импорта из `eslint.config.mjs`. Назовите
>    одну выгоду и одну опасность этого выбора.
> 5. Один из паттернов плагин **НЕ** ловит — это нарушение
>    «`@retail-inventory-system/observability/tracer` —
>    первый импорт в `main.ts`». Какой плагин/механизм мог
>    бы его enforce'ить, и почему сегодня он этого не делает?

## Что почитать дальше

- [ADR-017 в репозитории](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/017-architecture-lint-via-eslint-boundaries.md)
  — оригинальное решение с rejected-alternatives.
- [`eslint-plugin-boundaries` README](https://github.com/javierbrea/eslint-plugin-boundaries)
  — официальная документация плагина (v6 API).
- [`recommendation.md` §3](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/parts/recommendation.md#L221-L240)
  — boundary-rules таблица, которую lint исполняет.
- [Mark Erikson, «The (Almost) Complete History of ESLint»](https://blog.isquaredsoftware.com/2021/07/the-history-of-eslint/)
  — для понимания, откуда у ESLint flat-config и
  programmatic Linter — оба нужны для regression-spec'а.
- [`eslint-import-resolver-typescript`](https://github.com/import-js/eslint-import-resolver-typescript)
  — резолвер, который позволяет плагину понимать
  `@retail-inventory-system/*`-aliases.
