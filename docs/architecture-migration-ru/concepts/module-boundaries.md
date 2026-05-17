---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, concepts, boundaries, eslint]
status: final
related:
  - "[[clean-architecture-layers]]"
  - "[[hexagonal-architecture]]"
  - "[[shared-libs-philosophy]]"
  - "[[lib-eslint-plugin-boundaries]]"
  - "[[architecture-decision-records]]"
---

# Границы модулей и библиотек

> [!abstract] Кратко
> В Retail Inventory System «границы» — это не общая риторика, а
> конкретный набор правил импортов: какой слой во что может смотреть,
> какой модуль до какого может дотянуться, какая `libs/<name>` имеет
> право зависеть от какой. Границы зафиксированы в ADR-005 (split
> shared libs) и ADR-017 (architecture lint), и **исполняются** через
> `eslint-plugin-boundaries` в `eslint.config.mjs` плюс fixture-based
> regression-спека `tests/lint/architecture-lint.spec.ts`. Любое
> нарушение валит `yarn lint`, а значит — CI.

## Проблема, которую решает

В fat-сервисном baseline'е до миграции импорты не ограничивались. У
файла из `app/api/order/` ничто не мешало импортировать
`Repository<ProductEntity>` напрямую (даже если `product` принадлежит
inventory-сервису, а не retail), или дёрнуть Pino-логгер из любого
домена. Со временем такие связи накапливаются, рефакторинг ловит «о, а
тут ещё одна неожиданная зависимость» и стоит втрое больше.

ADR-005 и ADR-017 ставят два разных, но взаимосвязанных вопроса:

- **Как разделить ответственность между библиотеками?** —
  это вопрос таксономии (`libs/contracts`, `libs/database`, `libs/ddd`,
  …). Решает ADR-005.
- **Как помешать кому угодно импортировать кого угодно?** — это
  вопрос enforcement'а. Решает ADR-017: `eslint-plugin-boundaries`
  v6 c `default: 'disallow'` и `checkAllOrigins: true`.

В сумме это даёт **архитектуру, которая не разваливается одним PR'ом**.
Контрибьютор, попытавшись импортировать запрещённое, получает красную
ESLint-волнистую линию в редакторе и фейл в CI.

## Концепция

### Что такое граница

В терминологии этой статьи **граница** — это любая пара (источник,
цель), для которой существует правило «можно/нельзя импортировать».
Источник — категория файла («любой файл из `domain/` любого модуля
любого сервиса»). Цель — категория файла или npm-пакет. Граница
изображается ребром в графе зависимостей.

В нашем коде есть три уровня границ:

1. **Между слоями внутри одного модуля** — `domain` ↛ `infrastructure`,
   `presentation` ↛ `typeorm`, и т. п. Это и есть Clean Architecture
   dependency rule, см. [[clean-architecture-layers]].
2. **Между модулями одного сервиса** — `apps/retail-microservice/.../orders`
   ↛ `apps/retail-microservice/.../<other-module>/domain`. Сегодня в
   retail-микросервисе один модуль (`orders`), но правило настроено
   уже сейчас, и оно сработает в момент, когда появится второй.
3. **Между сервисами** — `apps/retail-microservice/...` ↛
   `apps/inventory-microservice/.../domain`. Никакой кросс-сервисный
   импорт исходного кода не разрешён; общаются сервисы только через
   `libs/contracts` (типы DTO/enum) и RabbitMQ (на runtime).

И отдельная категория — **между библиотеками**: `lib-ddd` ↛ ничему
кроме `lib-ddd`, `lib-contracts` ↛ ничему кроме `lib-contracts`, и т. д.
Полный список — в `eslint.config.mjs:218-264`.

### Element-type-таксономия

`eslint-plugin-boundaries` оперирует «элементами»: каждый файл
относится к ровно одному типу. У нас 8 типов для кода приложения и 9
типов для библиотек:

| Элемент                | Шаблон файлов                                       | Capture           |
| ---------------------- | --------------------------------------------------- | ----------------- |
| `domain`               | `apps/*/src/modules/*/domain/**`                    | `app`, `module`   |
| `application-use-case` | `apps/*/src/modules/*/application/use-cases/**`     | `app`, `module`   |
| `application-port`     | `apps/*/src/modules/*/application/ports/**`         | `app`, `module`   |
| `application-dto`      | `apps/*/src/modules/*/application/dto/**`           | `app`, `module`   |
| `infrastructure`       | `apps/*/src/modules/*/infrastructure/**`            | `app`, `module`   |
| `presentation`         | `apps/*/src/modules/*/presentation/**`              | `app`, `module`   |
| `app-bootstrap`        | `apps/*/src/main.ts`, `apps/*/src/app/**`           | `app`             |
| `app-shared`           | `apps/*/src/common/**`                              | `app`             |
| `lib-<name>`           | `libs/<name>/**` (одна запись на каждую `libs/<name>`) | —                 |

```typescript
// eslint.config.mjs
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
  // ...
  { type: 'lib-ddd', pattern: 'libs/ddd/**', mode: 'file' },
];
```

> [GitHub: eslint.config.mjs](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/eslint.config.mjs#L1-L71)

Поле `capture: ['app', 'module']` — главная фишка v6: оно извлекает
имя сервиса и модуля прямо из пути файла и делает их доступными в
правиле как `{{from.captured.app}}` / `{{from.captured.module}}`. Так
выглядит «тот же модуль» матчер:

```typescript
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

> [GitHub: eslint.config.mjs](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/eslint.config.mjs#L82-L95)

И всё: чтобы запретить use-case импортировать domain из другого
сервиса или из другого модуля своего же сервиса, не нужно перечислять
все пары вручную. Шаблон сам разворачивается.

### `default: 'disallow'` и почему так

Канонический способ настройки `boundaries/dependencies` — «по
умолчанию разрешено всё, перечисляем запрещённое». Это эргономично, но
плохо защищает: любой новый файл и любой новый npm-пакет начинают «с
зелёного света».

ADR-017 выбрал противоположную полярность: `default: 'disallow'` +
`checkAllOrigins: true`. Каждое ребро (внутреннее и внешнее) должно
быть **явно разрешено**. Чтобы это не превратилось в кошмар поддержки,
правило 0 разрешает все внешние пакеты:

```typescript
// eslint.config.mjs
const dependencyRules = [
  // 0. Blanket allow for any non-local target — npm packages and node-core modules.
  { from: { type: '*' }, allow: { to: { origin: ['external', 'core'] } } },

  // Domain — only ddd, common, contracts (enums/types), and own-module domain.
  {
    from: { type: 'domain' },
    allow: [sameModule('domain'), lib('lib-ddd'), lib('lib-common'), lib('lib-contracts')],
  },
  // ...
];
```

> [GitHub: eslint.config.mjs](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/eslint.config.mjs#L105-L117)

Дальше идут per-source `disallow`-правила для конкретных npm-пакетов
(их кладут **после** правила 0 — last match wins). Например, `domain`
запрещает `@nestjs/*`, `typeorm`, `nestjs-pino` и кучу других:

```typescript
{
  from: { type: 'domain' },
  disallow: {
    dependency: {
      module: [
        '@nestjs/*', 'typeorm', '@keyv/redis', 'cacheable', 'cache-manager',
        'redis', 'amqplib', 'amqp-connection-manager', 'axios',
        'nestjs-pino', 'pino', 'pino-http',
      ],
    },
  },
},
```

> [GitHub: eslint.config.mjs](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/eslint.config.mjs#L272-L292)

### Кросс-сервисная и кросс-модульная изоляция

Главная вещь, которую делает `capture: ['app', 'module']` — позволяет
запретить кросс-доступ без перечисления пар. Если файл из
`apps/retail-microservice/.../orders/application/use-cases/` попытается
импортировать `apps/inventory-microservice/.../stock/domain/`, линт
сравнит `from.captured.app` (= `retail-microservice`) и
`to.captured.app` (= `inventory-microservice`), увидит несовпадение —
и поскольку ни одно `allow`-правило этого ребра не покрывает,
сработает `default: 'disallow'`.

То же самое внутри сервиса: если завтра в `apps/retail-microservice/`
появится модуль `customers/`, его `domain/` будет защищён от
неавторизованных импортов из `orders/` тем же самым правилом, без
дополнительной строки в конфиге.

### Лимит «forbidden imports» в CLAUDE.md

Помимо линта, словесная формулировка ограничений есть в `CLAUDE.md`
проекта — раздел **«Forbidden imports»**. Это короткая шпаргалка
для людей и LLM-ассистентов; **источник истины** всё равно — ADR-017
и `eslint.config.mjs`. Если возникает противоречие между человеческим
описанием и линтом, прав линт.

### Когда границу нужно ослабить

Линт у нас один документированный исключение —
**`ARCH-LINT-EX-01`**: репозиторий `IStockRepositoryPort` и use-case
`ReserveStockForOrderUseCase` импортируют `EntityManager` из
`typeorm`. Это нужно, чтобы use-case мог открыть транзакцию и
прокинуть её внутрь репозитория. Чистый фикс — введение
`ITransactionPort`-абстракции; пока этого нет, исключение зафиксировано:

- в самих файлах — `// eslint-disable-line boundaries/dependencies`
  плюс TODO с кодом;
- в ADR-017 § 6 (таблица «Documented exceptions»);
- в `_carryover-12.md` и `_carryover-13.md`;
- в [[mappers-and-repositories]] — как открытый архитектурный долг.

Любое будущее исключение должно пройти через ADR. **Не молчаливое
ослабление правила** — это критично, иначе линт превратится в
пыльную декорацию.

### Regression-спек

Сам по себе `eslint-plugin-boundaries` сломать легко: один лишний
`allow:`, одна неаккуратная капчер-маска, — и правило перестаёт
срабатывать. Чтобы такое не прошло незамеченным, есть fixture-spec
`tests/lint/architecture-lint.spec.ts`, который **прогоняет ESLint
программно** против тщательно подобранных кусочков кода и проверяет:
«вот тут ruleId `boundaries/dependencies` должен сработать; а тут —
не должен».

Структура спека:

- per-layer external denials (domain ↛ typeorm, use-case ↛ cacheable,
  presentation ↛ @keyv/redis и т. д.);
- per-layer element-type denials (domain ↛ infrastructure, port ↛
  infrastructure, presentation ↛ lib-database);
- cross-service rule (use-case ↛ another app's domain);
- positive cases (domain → lib-ddd, infrastructure → lib-cache) —
  чтобы случайно слишком широкое правило не съело легитимное ребро.

См. ADR-017 § 7.

## Применение в проекте

### Конкретный пример: что произойдёт, если попробовать

Представим контрибьютора, который добавляет «удобную» утилиту: в
`apps/retail-microservice/src/modules/orders/application/use-cases/get-order.use-case.ts`
импортирует `@keyv/redis` напрямую, чтобы быстренько закэшировать
ответ.

1. Линт-правило источника `application-use-case` в массиве disallow
   содержит `@keyv/redis` (см. `eslint.config.mjs:298-316`).
2. `default: 'disallow'` + правило 0 (allow external) дают
   совокупный «по умолчанию external разрешён», но per-source disallow
   приходит **позже** и **переопределяет** (last match wins).
3. ESLint выдаёт ошибку `boundaries/dependencies`: `'@keyv/redis' is
   forbidden in element of type 'application-use-case'`.
4. `yarn lint --max-warnings 0` фейлится; PR краснеет; CI зелёным не
   становится.

Решение по правилам — обернуть кэш в порт (`I<…>CachePort`), реализовать
адаптер в `infrastructure/cache/` и инжектить порт в use-case. Это и
есть тот «правильный путь», к которому хочет привести
hexagonal-архитектура (см. [[hexagonal-architecture]]).

### Конкретный пример: кросс-сервис

Контрибьютор делает в retail-микросервисе такой импорт:

```typescript
// apps/retail-microservice/src/modules/orders/.../some.ts
import { Storage } from '../../../../inventory-microservice/src/modules/stock/domain/storage.model';
```

Источник: `application-use-case` с `captured.app = 'retail-microservice'`.
Цель: `domain` с `captured.app = 'inventory-microservice'`.
Правило `sameModule('domain')` требует `to.captured.app =
'{{from.captured.app}}'` = `retail-microservice`. Не сходится — нет
матча — `default: 'disallow'` срабатывает.

Чтобы передать `Storage`-семантику между сервисами легально, тип
должен жить в `libs/contracts` (`@retail-inventory-system/contracts`),
который имеет element-type `lib-contracts` и доступен всем слоям всех
сервисов.

### Конкретный пример: библиотека-к-библиотеке

`lib-ddd` намеренно «закрытая»: единственный разрешённый из неё
импорт — это `lib-ddd` (саму себя; нужно, чтобы `aggregate-root.base.ts`
импортировал `entity.base.ts`). Никаких `lib-contracts`, никаких
`lib-common`. Если бы `lib-ddd` зависел от `lib-contracts`, то
получился бы цикл (`lib-contracts` не зависит от `lib-ddd`, но
изменение в `lib-contracts` стало бы потенциальным break-change для
`lib-ddd`). См. `eslint.config.mjs:218`.

### CI-гейт

Архитектурный линт **не выделен** в отдельный yarn-script — он живёт
прямо в `yarn lint`. Соответственно — в существующем GitHub Actions
job'е `lint` (`.github/workflows/ci-cd.yml`). Никаких «двух
параллельных команд»; одна команда лента — она же и архитектурный
guard. ADR-017 § 5 объясняет, почему:

> A separate `yarn lint:architecture` script and a second workflow
> file… were rejected: the developer feedback loop stays shorter and
> avoids the "I ran one lint but not the other" foot-gun.

## Связанные решения

- [[clean-architecture-layers]] — те же per-layer правила, описанные с
  точки зрения архитектурного паттерна.
- [[hexagonal-architecture]] — port/adapter-метафора, которой служит
  enforcement.
- [[shared-libs-philosophy]] — за что отвечает каждая `libs/<name>` и
  почему таксономия именно такая.
- [[lib-eslint-plugin-boundaries]] — детальный разбор плагина:
  element-types, `dependencies` rule v6, regression-спек.
- [[architecture-decision-records]] — формат ADR, через который
  оформляются новые исключения и изменения правил.

## Глоссарий

| Термин (EN)                  | Перевод / пояснение (RU)                                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture lint            | Архитектурный линт — статическая проверка правил импорта на уровне ESLint. У нас — `eslint-plugin-boundaries` v6.                                                                                                       |
| Element type                 | Тип элемента — категория файла, к которой плагин относит конкретный путь (`domain`, `application-port`, `lib-contracts`). Каждый файл имеет ровно один тип.                                                            |
| Capture                      | Захват — переменные, извлекаемые из пути файла (`app`, `module`). Позволяет в правиле сравнить «тот же сервис» / «тот же модуль» без перечисления пар.                                                                  |
| `default: 'disallow'`        | Полярность правила — «по умолчанию запрещено». Каждое ребро в графе зависимостей должно быть явно разрешено `allow`-правилом. Альтернатива — `default: 'allow'` (мы её отвергли в ADR-017).                              |
| Forbidden imports            | «Запрещённые импорты» — раздел в `CLAUDE.md`, дублирующий ключевые границы для людей и LLM. Источник истины — `eslint.config.mjs`.                                                                                       |
| `ARCH-LINT-EX-01`            | Документированное исключение из линта: `IStockRepositoryPort` и `ReserveStockForOrderUseCase` импортируют `EntityManager` из `typeorm`. Закроется введением `ITransactionPort`.                                          |
| Regression spec              | `tests/lint/architecture-lint.spec.ts` — fixture-based тест, прогоняющий ESLint программно. Защищает сам конфиг от случайного ослабления.                                                                                |

## Что почитать дальше

- ADR-005 — [`docs/adr/005-split-shared-common-into-bounded-libs.md`](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/005-split-shared-common-into-bounded-libs.md)
  — таксономия библиотек и обоснование per-lib element-type.
- ADR-017 — [`docs/adr/017-architecture-lint-via-eslint-boundaries.md`](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/017-architecture-lint-via-eslint-boundaries.md)
  — формализация правил, выбор плагина, документированные исключения.
- `eslint-plugin-boundaries` v6 docs:
  <https://github.com/javierbrea/eslint-plugin-boundaries>.

> [!faq]- Проверь себя
>
> 1. Что произойдёт, если `domain/order.model.ts` импортирует
>    `nestjs-pino`?
> 2. Чем `lib-ddd` отличается от `lib-contracts` по части того, кто
>    из них кого может импортировать?
> 3. Зачем понадобилось `capture: ['app', 'module']`? Что бы сломалось,
>    если убрать эту настройку?
> 4. `default: 'disallow'` — почему это «безопаснее», но «дороже» в
>    поддержке? Какой компромисс мы выбрали (правило 0)?
> 5. Что такое `ARCH-LINT-EX-01` и где он зафиксирован?
