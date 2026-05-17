---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, concepts, adr, documentation]
status: final
related:
  - "[[hexagonal-architecture]]"
  - "[[module-boundaries]]"
  - "[[shared-libs-philosophy]]"
---

# Architecture Decision Records (ADR)

> [!abstract] Кратко
> ADR — короткий документ, фиксирующий **одно** архитектурное решение
> вместе с его контекстом, рассмотренными альтернативами и
> последствиями. В Retail Inventory System используется
> Nygard-hybrid-формат (Status, Context, Decision, Alternatives
> Considered, Consequences), 3-значное zero-padding-нумерование, один
> файл на одно решение. Конвенция зафиксирована в ADR-003; на текущий
> момент в проекте 20 ADR, все `Accepted`. Каталог — `docs/adr/`,
> индекс — `docs/adr/index.md`.

## Проблема, которую решает

Архитектурные решения принимаются на каждом существенном PR'е: «почему
не Mikro-ORM», «почему argon2id, а не bcrypt», «почему хранить
refresh-token как hash, а не как opaque-id». Если не записывать
обоснование, оно растворяется в трёх местах:

- в **описании PR** — оно поисковое, но неудобное (надо помнить, какой
  PR искать; ссылка в коде на PR-номер — тоже хрупкая);
- в **commit-сообщении** — обычно сжимается до одной фразы, теряя
  «почему»;
- в **памяти команды** — рассыпается с течением времени и при
  ротации.

Новый разработчик через полгода смотрит на код и не понимает: это
сознательный выбор или историческая инерция? ADR — это **долговечное
место**, где decision хранится рядом с кодовой базой, найдётся по
поиску в файлах и не зависит от внешних систем (Jira, Notion,
Confluence).

ADR-003 поднял этот вопрос на старте миграции, когда у проекта было
ровно два уже написанных ADR (ADR-001 и ADR-002) и впереди — 14 фаз
структурных изменений. Решение «давайте писать ADR» закрепило не сам
факт, а **формат** и **дисциплину**: что писать, как нумеровать, когда
не писать.

## Концепция

### Что такое ADR

ADR — это markdown-файл в `docs/adr/`, имеющий имя
`NNN-<short-kebab-case-slug>.md`. Например:

```
docs/adr/004-adopt-hexagonal-architecture-per-service.md
docs/adr/010-jwt-rbac-at-the-gateway.md
docs/adr/017-architecture-lint-via-eslint-boundaries.md
```

Слаг описывает **решение**, а не область. Сравним:

- ✅ `004-adopt-hexagonal-architecture-per-service.md` — «приняли
  гексагон в каждом сервисе»;
- ❌ `004-architecture.md` — про что? Какое решение?

ADR пишется в активном залоге: «We adopt …», «We split …», «We
record …». Это маркер того, что внутри — **выбор**, а не описание
существующего положения.

### Nygard-hybrid формат

ADR-003 кодифицирует формат, который уже был у ADR-001 и ADR-002:

```markdown
# ADR-NNN: <decision in active voice>

- **Date**: YYYY-MM-DD
- **Status**: Accepted | Proposed | Superseded by ADR-NNN | Deprecated | Rejected

---

## Context

What problem the decision answers and what forces shape it. State the
situation as it actually is in this codebase, not in the abstract.

## Decision

What was decided, in concrete enough detail that a future reader can
recognize the decision in code without needing the author present.

## Alternatives Considered

At least one rejected option, with a one-paragraph reason.

## Consequences

### Positive
What the decision buys.

### Negative / Trade-offs
What it costs. Be honest.
```

Это «hybrid» — потому что объединяет элементы из двух источников:

- **Nygard** (Michael Nygard, 2011) — оригинальная структура
  Context/Decision/Status/Consequences;
- **MADR** (Markdown Any Decision Records) — добавляет явный
  «Considered Options» / «Alternatives Considered».

«Consequences» в MADR изначально нет; «Alternatives Considered» в
Nygard'е тоже нет. Гибрид берёт лучшее из обоих и оставляет за бортом
тяжёлые MADR-поля (decision drivers, scoring matrix), которые
оправданы для крупных команд, но для нашего проекта дают больше
церемонии, чем пользы.

### Нумерация

- **3-значное zero-padded**: `001`, `002`, …, `099`, `100`. Сейчас мы
  на 020; следующий свободный — 021. ADR-003 явно объясняет, почему
  не 4 цифры: ADR-001 и ADR-002 уже существовали с 3-значным
  паддингом, переименовать их «ради красоты» — затронуть все
  существующие ссылки в README и аудитах.
- **Номер выдаётся в момент коммита**, не «бронируется». Это
  предотвращает скачки в нумерации, если два параллельных PR'а
  открывают ADR одновременно.
- **Лимит 999** не пугает — даже самые активные проекты редко
  переваливают за 100. Если когда-нибудь упрёмся, switch на 4-знака
  будет отдельным ADR'ом.

### Когда писать ADR

ADR-003 формулирует это коротко:

- **Выбор между двумя+ разумными альтернативами**, который будущие
  контрибьюторы могут захотеть пересмотреть.
- **Ограничение, накладываемое на кодовую базу** («domain-слою
  запрещено импортировать `@nestjs/*`»).
- **Отмена/замещение предыдущего ADR**.

И — что **не** ADR:

- Bug fix — это не ADR.
- Рефакторинг, не меняющий границ — не ADR.
- Добавление зависимости «для удобства» (`lodash.pick` вместо
  собственного хелпера) — не ADR.
- Добавление зависимости, **запирающей** проект в класс решений
  (Mikro-ORM вместо TypeORM, Kafka вместо RabbitMQ) — **ADR**.

### Статусы

Поле `Status` принимает одно из:

- **Proposed** — решение опубликовано, но команда ещё не
  согласовала. Используется редко: обычно ADR пишется уже после
  согласования.
- **Accepted** — решение в силе. Это статус по умолчанию для
  большинства наших ADR.
- **Superseded by ADR-NNN** — решение отменено более новым ADR'ом.
  Старый ADR при этом **не редактируется** (правка только статуса +
  однострочная ссылка); вся история сохраняется.
- **Deprecated** — больше не применяется, но без замены.
- **Rejected** — обсуждали и отвергли. Полезно, если решение
  периодически всплывает в обсуждениях.

В нашем каталоге сегодня **все 20 ADR имеют статус Accepted**. Ни
один не Superseded, ни один не Deprecated.

### ADR-001: интересное исключение

Любопытная деталь: у ADR-001 (`structured-logging-with-pino.md`)
**нет поля `Date`**. Он был написан до ADR-003, который ввёл
date-конвенцию. Менять его «постфактум» означало бы переписывать
исторический документ; вместо этого ADR-003 сам зафиксировал, что
«ADR-001 предшествует date-конвенции» — и оставил всё как есть.

Это иллюстрирует принцип: **ADR пишется один раз и стареет вместе с
кодом**. Не редактируется, не пересматривается, не «обновляется». Если
что-то изменилось — пишется новый ADR со ссылкой Supersedes.

## Применение в проекте

### Каталог `docs/adr/`

```
docs/adr/
├── index.md                                                    # каталог 20 ADR
├── 001-structured-logging-with-pino.md
├── 002-redis-cache-aside-product-stock.md
├── 003-record-architecture-decisions.md                        # это ADR про формат
├── 004-adopt-hexagonal-architecture-per-service.md
├── 005-split-shared-common-into-bounded-libs.md
├── 006-cache-aside-via-libs-cache.md
├── 007-pino-and-opentelemetry.md
├── 008-rabbitmq-via-libs-messaging.md
├── 009-port-adapter-at-the-gateway.md
├── 010-jwt-rbac-at-the-gateway.md
├── 011-notifier-port-and-adapters.md
├── 012-stock-aggregate-and-port-adapter.md
├── 013-order-aggregate-and-cross-service-confirm.md
├── 014-otel-exporter-otlp-http-and-jaeger.md
├── 015-pino-trace-correlation.md
├── 016-cache-aside-generalized.md
├── 017-architecture-lint-via-eslint-boundaries.md
├── 018-nestjs-monorepo-apps-and-libs.md                        # back-fill
├── 019-typeorm-and-mysql-for-persistence.md                    # back-fill
└── 020-rabbitmq-as-inter-service-bus.md                        # back-fill
```

ADR-018, ADR-019, ADR-020 — **back-filled**: это решения, существующие
с момента создания проекта, но зафиксированные ADR'ами только в фазе
13. Они отвечают на вопрос «почему вообще NestJS-монорепо? почему
TypeORM? почему RabbitMQ?» — то, что было «по умолчанию», и поэтому
выпадало из поля зрения, пока существование самого ADR-каталога это не
подсветило.

### Цитата формата

```markdown
# ADR-003: Record Architecture Decisions

- **Date**: 2026-05-08
- **Status**: Accepted

---

## Context

The retail-inventory-system has grown enough architectural decisions —
Pino + correlation IDs (ADR-001), Redis cache-aside for product stock
(ADR-002), and now a full hexagonal-architecture migration starting on
branch `RIS-25-Architecture-migration` — that the *why* behind each
choice has started leaking into PR descriptions, commit messages, and
maintainer memory…
```

> [GitHub: docs/adr/003-record-architecture-decisions.md](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/003-record-architecture-decisions.md#L1-L25)

Полный текст — в источнике; форма выше реплицирует структуру.

### Каталог-индекс

`docs/adr/index.md` — это таблица: номер, заголовок-ссылка, статус,
дата, одно-строчное summary. Индекс пересоздаётся вручную, когда
появляется новый ADR (это часть работы PR'а, добавляющего ADR).
Альтернатива — генерировать индекс через `adr-tools` или похожий
скрипт — была обсуждена и отклонена: 20 строк руками поддерживать
дешевле, чем дополнительную зависимость.

```markdown
| 003 | [Record architecture decisions](003-record-architecture-decisions.md) | Accepted | 2026-05-08 | Codifies the Nygard hybrid format, 3-digit padding, and slug rules… |
| 004 | [Adopt hexagonal architecture per service](004-adopt-hexagonal-architecture-per-service.md) | Accepted | 2026-05-09 | Per-module `domain/application/infrastructure/presentation` split for every service in `apps/`. |
```

> [GitHub: docs/adr/index.md](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/index.md#L1-L27)

### Как ADR связаны с кодом

ADR — это **не** репозиторий «всех знаний». Это репозиторий **решений**.
Связь с кодом двусторонняя:

- В ADR в секции `Decision` упоминаются конкретные файлы и слои
  (`apps/<service>/.../domain/`, `eslint.config.mjs`, и т. п.).
- В коде комментарии иногда ссылаются на ADR
  (`// see ADR-016 for cache-key convention`).
- В `CLAUDE.md` есть короткое описание ключевых ADR — для людей и
  LLM-ассистентов, которым нужен быстрый контекст.

При прочтении кода ADR — это «почему», код — это «как». Ни одна
сторона не пытается заменить другую.

## Связанные решения

- [[hexagonal-architecture]] — ADR-004 формализует выбор паттерна.
- [[module-boundaries]] — ADR-005 (taxonomy) + ADR-017 (enforcement).
- [[shared-libs-philosophy]] — ADR-005 определяет, какие libs
  существуют и за что отвечают.

## Глоссарий

| Термин (EN)                     | Перевод / пояснение (RU)                                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR                             | Architecture Decision Record — короткий markdown-документ, фиксирующий одно архитектурное решение. У нас живут в `docs/adr/`.                                                                                      |
| Nygard hybrid format            | Гибридный формат ADR на основе Michael Nygard (2011) + MADR. Поля: Date, Status, Context, Decision, Alternatives Considered, Consequences. Закреплён в ADR-003.                                                  |
| Slug                            | «Slug» — kebab-case-описание решения в имени файла (`adopt-hexagonal-architecture-per-service`). Описывает **что решили**, не «о чём это».                                                                       |
| Status: Accepted                | Решение в силе. Подавляющее большинство наших ADR имеют этот статус.                                                                                                                                              |
| Status: Superseded by ADR-NNN   | Решение отменено более новым ADR'ом. Старый ADR не редактируется по существу; меняется только Status и добавляется ссылка.                                                                                       |
| Back-fill                       | «Back-fill» — написание ADR постфактум для решения, которое существовало в коде с самого начала. У нас так оформлены ADR-018/019/020 (NestJS-монорепо, TypeORM+MySQL, RabbitMQ).                                  |
| Decision atom                   | «Атомарность решения» — одно решение на один ADR. Если в одном PR'е принято два решения, это два разных файла, а не один пакетный.                                                                              |

## Что почитать дальше

- Michael Nygard — *Documenting Architecture Decisions* (2011):
  <https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions>.
- MADR — *Markdown Any Decision Records*:
  <https://adr.github.io/madr/>.
- `adr-tools` — CLI для генерации skeleton'а ADR (не используется в
  этом проекте, но полезно знать): <https://github.com/npryce/adr-tools>.
- ADR-003 — формат и нумерация:
  [`docs/adr/003-record-architecture-decisions.md`](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/003-record-architecture-decisions.md).

> [!faq]- Проверь себя
>
> 1. В каком случае пишется ADR, а в каком нет? Приведи два примера
>    из этой кодовой базы.
> 2. Можно ли отредактировать ADR-004, если завтра решение
>    пересмотрено? Что нужно сделать вместо этого?
> 3. Почему у ADR-001 нет поля `Date`?
> 4. Что такое «back-filled» ADR и какие у нас такие?
> 5. Где живёт связь ADR ↔ код? Кто на кого ссылается?
