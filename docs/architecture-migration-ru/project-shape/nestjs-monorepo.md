---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, project-shape, monorepo, nestjs]
status: final
related:
  - "[[microservices-split]]"
  - "[[api-gateway-pattern]]"
  - "[[shared-libs-philosophy]]"
  - "[[module-boundaries]]"
---

# NestJS-монорепозиторий

> [!abstract] Кратко
> Retail Inventory System живёт в одном Git-репозитории, который
> устроен как **NestJS-монорепозиторий**: четыре деплоимых сервиса
> в `apps/*`, десять общих библиотек в `libs/*`, один корневой
> `package.json`, одна сборка `nest build --all`. Связь между апами
> и библиотеками — через TypeScript path-алиасы вида
> `@retail-inventory-system/*`, а не через настоящие Yarn-воркспейсы
> с собственными `package.json`. Это шаблон, зафиксированный в
> ADR-018: один PR может одновременно поменять контракт сервиса и
> всех его потребителей, и компилятор поймает рассинхронизацию до CI.

## Проблема, которую решает

Когда несколько сервисов разделяют доменные контракты (DTO заказов,
ключи маршрутизации RabbitMQ, конфигурацию TypeORM, observability-
обвязку), у команды есть два структурных пути.

Первый — **полирепо**: каждый сервис в собственном репозитории, общий
код вынесен в опубликованные npm-пакеты с независимым версионированием.
Это масштабируется, но требует операционной дисциплины: каждое изменение
контракта — это релиз пакета плюс четыре отдельных PR, по одному на
сервис. На малом масштабе (4 сервиса × 10 общих библиотек) накладные
расходы съедают выгоды.

Второй — **монорепо**: всё в одном дереве, общий код подключается через
TS-пути, сборка идёт одним проходом. Изменение контракта — это
один PR, который сразу видит все консьюмеры; если retail переименовал
поле в DTO, gateway падает в `tsc` на той же ветке. Минус — невозможно
выпускать сервисы независимо: каждый деплой собирает весь репозиторий.

Migration-recommendation остановился на втором варианте (см. ADR-018):
сервисов мало, контрактов между ними много, релиз-каденс единый.
Полирепо оставлен как «когда-нибудь, если сервис захочет разъехаться»;
сегодня его минусы стоят дороже его плюсов.

NestJS из коробки умеет жить в таком режиме: CLI `nest build`,
`nest start` и schematics понимают флаг `monorepo: true` в
`nest-cli.json`. Шаблон, который выбрал Кокшаров для NestJS-проектов
этой формы, описан в его документации как «Monorepo mode» — у нас
он реализован буквально.

## Концепция

### Что такое NestJS-монорепо

NestJS-монорепо — это **один TypeScript-проект, в котором живёт
несколько Nest-приложений и набор общих библиотек**, объединённых:

- одним корневым `package.json` со всеми зависимостями;
- одним корневым `tsconfig.json` со списком path-алиасов;
- одним `nest-cli.json` с `monorepo: true` и записью `projects.<name>`
  на каждое приложение;
- одной командой сборки `nest build --all`, которая поочерёдно
  собирает каждое приложение в `dist/apps/<service>/`.

В нашем случае это даёт жёсткий, простой инвариант: **четыре сервиса
всегда собираются и тестируются вместе**. Если изменение в
`libs/contracts` ломает gateway, retail или inventory, это видно в
одном `yarn build`, а не в четырёх отдельных CI-прогонах.

### `apps/` против `libs/`

Дерево репозитория жёстко делится на две зоны:

- `apps/<service>/` — **деплоимый код**. Внутри живёт `main.ts`, корневой
  `AppModule`, модули домена, Dockerfile, `tsconfig.app.json`. Каждый
  `apps/<service>/` в итоге становится отдельным контейнерным образом
  и отдельным процессом.
- `libs/<name>/` — **переиспользуемый код**. Здесь нет `main.ts` и нет
  собственного Nest-приложения. Содержимое импортируется в `apps/*`
  через path-алиасы.

Это **разделение обязательно** для гексагональной архитектуры
(см. [[hexagonal-architecture]]) и архитектурного линта
(см. [[module-boundaries]]): element-types
`eslint-plugin-boundaries` различают `apps/` и `libs/` именно
по этим путям.

### TS path aliases — не Yarn workspaces

Корневой `tsconfig.json` объявляет десять алиасов:

```json
// tsconfig.json
"paths": {
  "@retail-inventory-system/auth": ["libs/auth"],
  "@retail-inventory-system/cache": ["libs/cache"],
  "@retail-inventory-system/common": ["libs/common"],
  "@retail-inventory-system/config": ["libs/config"],
  "@retail-inventory-system/contracts": ["libs/contracts"],
  "@retail-inventory-system/database": ["libs/database"],
  "@retail-inventory-system/ddd": ["libs/ddd"],
  "@retail-inventory-system/messaging": ["libs/messaging"],
  "@retail-inventory-system/observability": ["libs/observability"],
  "@retail-inventory-system/observability/tracer": ["libs/observability/tracer"]
}
```

> [GitHub: tsconfig.json](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/tsconfig.json#L19-L40)

С точки зрения `tsc` импорт `from '@retail-inventory-system/contracts'`
эквивалентен `from '../../../libs/contracts'`. Webpack использует тот
же `tsconfig.json` через `tsconfig-paths-webpack-plugin`, поэтому
бандл идёт без дополнительных настроек резолва.

Ключевая тонкость, зафиксированная в ADR-018: **библиотеки — это
TS-алиасы, а не настоящие Yarn-воркспейсы**. У них нет собственного
`package.json`, нет `tsconfig.lib.json`, и они не зарегистрированы
в `nest-cli.json` `projects`. Корневой `package.json` объявляет
`workspaces: ["apps/*", "libs/*"]` — это сделано для будущей миграции
на полноценные воркспейсы, но сегодня Yarn видит эти папки как
пустые воркспейсы (без `package.json` — без зависимостей).

```json
// package.json
"workspaces": [
  "apps/*",
  "libs/*"
],
```

> [GitHub: package.json](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/package.json#L1-L9)

Почему так, а не полноценные воркспейсы? Альтернативы рассмотрены в
ADR-018:

- **Yarn/npm workspaces с per-lib `package.json`** — нужны, когда
  библиотеки публикуются как npm-пакеты или их зависимости
  существенно расходятся. У нас все libs зависят от тех же
  `@nestjs/*` и `typeorm`, что и апы; per-lib `package.json` оказался
  бы почти пустым. **Отложено**.
- **Nx workspace** — даёт affected-targets и кэш сборки. На четырёх
  апах и десяти libs `yarn build` отрабатывает за ~10 секунд на
  приложение; механика Nx решает проблему, которой у нас нет.
  **Отложено**.
- **Bazel/Pants** — гетерогенные сборки в большом масштабе. Для
  чисто-TS проекта диспропорция. **Отказ**.

### `nest-cli.json` и сборка

Корневой `nest-cli.json` — точка сборки монорепо:

```json
// nest-cli.json
{
  "monorepo": true,
  "sourceRoot": "apps",
  "root": "apps",
  "compilerOptions": {
    "builder": "webpack",
    "webpackConfigPath": "webpack.config.js",
    "deleteOutDir": true
  },
  "projects": {
    "api-gateway":             { "type": "application", "root": "apps/api-gateway",            "entryFile": "main", "sourceRoot": "apps/api-gateway/src",            "compilerOptions": { "tsConfigPath": "apps/api-gateway/tsconfig.app.json" } },
    "inventory-microservice":  { "type": "application", "root": "apps/inventory-microservice", "entryFile": "main", "sourceRoot": "apps/inventory-microservice/src", "compilerOptions": { "tsConfigPath": "apps/inventory-microservice/tsconfig.app.json" } },
    "retail-microservice":     { "type": "application", "root": "apps/retail-microservice",    "entryFile": "main", "sourceRoot": "apps/retail-microservice/src",    "compilerOptions": { "tsConfigPath": "apps/retail-microservice/tsconfig.app.json" } },
    "notification-microservice": { "type": "application", "root": "apps/notification-microservice", "entryFile": "main", "sourceRoot": "apps/notification-microservice/src", "compilerOptions": { "tsConfigPath": "apps/notification-microservice/tsconfig.app.json" } }
  }
}
```

> [GitHub: nest-cli.json](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/nest-cli.json#L1-L55)

Каждый проект имеет **собственный `tsconfig.app.json`**, который
наследует корневой `tsconfig.json` и переопределяет только две вещи —
`outDir` и `include`:

```json
// apps/api-gateway/tsconfig.app.json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "types": ["node"],
    "declaration": false,
    "outDir": "../../dist/apps/api-gateway"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "test", "dist", "**/*.spec.ts"]
}
```

> [GitHub: apps/api-gateway/tsconfig.app.json](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/tsconfig.app.json#L1-L11)

Здесь важно, что `include` указывает только на `src/**/*` самого
приложения — но за счёт `paths` из корня каждое приложение видит и
свой код, и любую `libs/*`. Никаких отдельных `include`-секций под
конкретные libs прописывать не нужно: TS-резолвер находит их через
алиасы.

Результат `nest build --all` для четырёх апов:

```
dist/apps/api-gateway/main.js
dist/apps/inventory-microservice/main.js
dist/apps/retail-microservice/main.js
dist/apps/notification-microservice/main.js
```

Каждый `main.js` — самодостаточный webpack-бандл с включёнными
зависимостями из `libs/*` (они вкомпилированы) и исключёнными
`node_modules` (`webpack-node-externals`). Docker-образ
`api-gateway`-сервиса берёт ровно `dist/apps/api-gateway/main.js` плюс
корневой `node_modules` и запускает `node main.js`.

### Один `package.json` на репозиторий

Корневой `package.json` хранит **все** runtime- и dev-зависимости.
NestJS (`^11.1.19`), TypeORM (`^0.3.28`), `@nestjs/microservices`,
`@opentelemetry/*`, ESLint, Jest — всё там. Это даёт два свойства:

- **Единый `node_modules`** — Yarn ставит зависимости один раз;
  apps и libs импортируют одно и то же.
- **Невозможны конфликты версий** — нельзя оказаться в ситуации, где
  retail зависит от TypeORM 0.3, а inventory — от 0.4.

Минус — обновление условного `@nestjs/common` затрагивает все четыре
сервиса разом. На сегодняшнем масштабе это плюс, а не минус: общий
стек — это страховка от рассинхронизации; в продакшне работающие
вместе сервисы должны говорить на одной версии транспорта.

### Скрипты репозитория

Корневые скрипты `package.json` — отражение монорепо-устройства:

| Скрипт | Что делает |
| -- | -- |
| `yarn build` | `nest build --all` — собирает все четыре апа в `dist/apps/<service>/`. |
| `yarn build:<service>` | `nest build <service>` — собирает один. |
| `yarn start:dev` | Поднимает все четыре сервиса параллельно через `concurrently`. |
| `yarn start:dev:<service>` | `nest start <service> --watch`. |
| `yarn lint` | `eslint . --max-warnings 0` — один проход по всему дереву. |
| `yarn test:unit` | Jest по всем `*.spec.ts` в `apps/*` и `libs/*`. |
| `yarn test:e2e` | Поднимает test-infra и гоняет supertest по gateway. |

> [GitHub: package.json](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/package.json#L8-L40)

Линт, билд и юнит-тесты — это **один проход**. `eslint-plugin-boundaries`
(ADR-017) работает над объединённым деревом и видит и `apps/*`, и
`libs/*` как один граф элемент-типов. В полирепо такая проверка
требовала бы отдельной координирующей надстройки.

## Применение в проекте

### Карта дерева

На уровне корня после полной миграции:

```
retail-inventory-system/
├── apps/
│   ├── api-gateway/                  # HTTP edge + auth (port 3000)
│   ├── inventory-microservice/       # Stock BC; RMQ-only
│   ├── retail-microservice/          # Orders BC; RMQ-only
│   └── notification-microservice/    # Outbound delivery; RMQ-only
├── libs/
│   ├── auth/                         # JWT + RBAC framework glue
│   ├── cache/                        # ICachePort + Redis adapter
│   ├── common/                       # Result, DomainException, pagination
│   ├── config/                       # configModuleConfig (Joi schema)
│   ├── contracts/                    # cross-service DTOs and enums
│   ├── database/                     # BaseEntity, BaseRepository, SnakeNamingStrategy
│   ├── ddd/                          # Entity, AggregateRoot, ValueObject, DomainEvent
│   ├── messaging/                    # RMQ wiring, ROUTING_KEYS
│   └── observability/                # Pino + OTel + correlation middleware
├── migrations/                       # TypeORM migrations + data-source
├── tests/                            # lint-fixture spec + integration helpers
├── nest-cli.json
├── package.json
├── tsconfig.json
├── webpack.config.js
└── docker-compose*.yml
```

Десять libs, четыре апа, один `package.json`. Все четыре сервиса
импортируют из libs через одни и те же алиасы:

```typescript
// apps/api-gateway/src/main.ts
import '@retail-inventory-system/observability/tracer';

import { ValidationPipe } from '@nestjs/common';
// ...
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';
import { AppModule } from './app';
```

> [GitHub: apps/api-gateway/src/main.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/main.ts#L1-L13)

Тот же `AppNameEnum` импортируют все четыре `main.ts`. Если завтра
переименовать поле в `AppNameEnum`, четыре `tsc`-прохода (по одному
на ап) поймают изменение в одном CI.

### Output: `dist/apps/<service>/main.js`

Каждый сервис превращается в один `main.js` со всеми бандленными
зависимостями из `libs/*`:

```bash
dist/apps/api-gateway/main.js
dist/apps/inventory-microservice/main.js
dist/apps/retail-microservice/main.js
dist/apps/notification-microservice/main.js
```

Полировка артефакта в Dockerfile тривиальна: скопировать `dist/apps/<service>/`,
корневой `package.json` + `yarn.lock`, поставить только runtime-deps,
запустить `node main.js`. Никаких `lerna`, `nx`, `pnpm publish`.

### CI-gate: lint → build → unit → e2e

CI-пайплайн в `.github/workflows/ci-cd.yml` устроен как четыре
последовательных гейта над всем монорепо:

1. `yarn lint` — `eslint . --max-warnings 0`. Архитектурный линт
   (ADR-017) проверяет границы модулей и libs в этом же проходе.
2. `yarn build` — `nest build --all`. Если контракт в
   `libs/contracts` сломан, упадёт здесь.
3. `yarn test:unit` — Jest по `apps/*` и `libs/*`. Use-cases и порты
   тестируются без поднятия инфры.
4. `yarn test:e2e` — поднимает MySQL/RabbitMQ/Redis в Docker и
   гоняет supertest по gateway.

Все четыре гейта — один CI-проход. Это и есть основная окупаемость
монорепо-устройства: рассинхронизация контракта или нарушение границы
ловится один раз, в одном PR, без релизного цикла.

## Связанные решения

- [[microservices-split]] — почему *внутри* этого монорепо живёт
  четыре сервиса, а не один монолит.
- [[api-gateway-pattern]] — какую роль играет `apps/api-gateway/` и
  чем он отличается от трёх микросервисов.
- [[shared-libs-philosophy]] — какие именно десять `libs/<name>/` мы
  выделили и почему. Раскрывает таксономию из ADR-005.
- [[module-boundaries]] — как `eslint-plugin-boundaries` использует
  деление `apps/`/`libs/` для проверки правил импорта.

## Глоссарий

| Термин (EN)               | Перевод / пояснение (RU)                                                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo                  | Один Git-репозиторий, в котором живёт несколько деплоимых сервисов и общий код. Альтернатива — polyrepo (по репозиторию на сервис).                                                                                                       |
| NestJS monorepo mode      | Режим `nest-cli.json` с `monorepo: true`. Один `package.json`, несколько `projects.<name>` под `apps/<service>/`, общая сборка `nest build --all`.                                                                                       |
| TS path alias             | Алиас вида `@retail-inventory-system/<name>` в `compilerOptions.paths`. Импорт по алиасу эквивалентен относительному пути к директории lib.                                                                                              |
| Yarn workspace            | Сабпроект Yarn с собственным `package.json`. У нас `workspaces: ["apps/*", "libs/*"]` объявлен, но per-lib `package.json` нет — это будущее расширение.                                                                                  |
| `nest-cli.json` projects  | Запись `projects.<service>` под `monorepo: true`. Указывает `root`, `sourceRoot`, `entryFile`, `tsConfigPath` для каждого деплоимого сервиса.                                                                                            |
| `tsconfig.app.json`       | Per-app TS-конфиг, наследующий корневой `tsconfig.json`. Только переопределяет `outDir` и `include`; алиасы наследуются.                                                                                                                 |
| Webpack node externals    | Плагин `webpack-node-externals`, исключающий `node_modules` из бандла. В Docker-образ копируются `dist/apps/<service>/main.js` + корневой `node_modules`.                                                                                |
| Polyrepo                  | Структура «один репозиторий — один сервис». Требует публикации общих библиотек как npm-пакетов и независимого версионирования. У нас отвергнут в ADR-018.                                                                                |
| Nx workspace              | Альтернативный orchestrator (Nrwl Nx) поверх Nest-монорепо. Даёт affected-targets, кэш сборки. На сегодняшнем масштабе избыточен; задокументирован как future option.                                                                    |

## Что почитать дальше

- [ADR-018](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/018-nestjs-monorepo-apps-and-libs.md)
  — фиксация выбора монорепо-устройства и список рассмотренных альтернатив.
- NestJS docs — [Monorepo mode](https://docs.nestjs.com/cli/monorepo)
  — официальное описание `monorepo: true` в `nest-cli.json`.
- *The Monorepo vs Polyrepo Debate* — Dan Luu, разбор торговли
  одной структурой за другую на разных масштабах команды и кодовой
  базы.

> [!faq]- Проверь себя
>
> 1. Где живёт корневой `tsconfig.json` и почему все four `apps/*/tsconfig.app.json`
>    наследуют его без переопределения `paths`?
> 2. Что произойдёт, если в `libs/contracts` переименовать поле в DTO
>    и закоммитить только изменение в этой папке? В каком месте
>    локально/в CI это поймается?
> 3. Почему мы декларировали `workspaces: ["apps/*", "libs/*"]`, но
>    при этом не создаём per-lib `package.json`? Что мы выигрываем
>    и что теряем по сравнению с полноценными воркспейсами?
> 4. Где в `nest-cli.json` объявлены пути сборки конкретного сервиса?
>    Что попадёт в `dist/` после `nest build --all`?
> 5. Какой механизм заставляет webpack понимать
>    `@retail-inventory-system/contracts` без дополнительного
>    `resolve.alias`-конфига?
