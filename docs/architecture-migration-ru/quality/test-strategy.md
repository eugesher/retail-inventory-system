---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, quality, tests, jest, e2e]
status: review
related:
  - "[[lib-eslint-plugin-boundaries]]"
  - "[[hexagonal-architecture]]"
  - "[[use-cases-vs-fat-services]]"
  - "[[notifier-port-and-adapters]]"
  - "[[entity-vs-domain-model]]"
  - "[[mappers-and-repositories]]"
  - "[[rabbitmq-as-bus]]"
  - "[[cache-aside-pattern]]"
  - "[[jwt-and-rbac]]"
---

# Стратегия тестирования

> [!abstract] Кратко
> Проект использует **трёхуровневый** тест-каркас: (1)
> Jest-unit-tests (29 suites на HEAD) — гоняются через
> `yarn test:unit` без поднятия инфраструктуры, инжектят
> in-memory port-doubles из `test-doubles.ts`; (2) Jest-e2e
> (`yarn test:e2e`) поднимает MySQL + Redis + RabbitMQ через
> Docker Compose, делает migration:run + seed, и
> `test/system-api.e2e-spec.ts` + `test/auth.e2e-spec.ts` +
> `test/notification.e2e-spec.ts` гоняют реальные
> HTTP-запросы и RMQ-event'ы end-to-end; (3)
> `tests/lint/architecture-lint.spec.ts` — бумпер для
> boundaries-rules (см. [[lib-eslint-plugin-boundaries]]).
> CI порядок гейтов:
> [`yarn lint --max-warnings 0`](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/.github/workflows/ci-cd.yml) →
> `yarn build` → `yarn test:unit` → `yarn test:e2e`. Падение
> любого — PR не merge'ится.

## Проблема, которую решает

Без тестов миграция — это **слепой полёт**. Без unit-test'ов
рефакторинг use-case'а ломает code-path, который никто не
прогонит до следующего ручного теста. Без e2e — изменение
`OrderConfirmResponseDto` ломает контракт между gateway и
retail-microservice'ом, и баг ловится не в репо, а в
production'е. Без lint-spec'а — boundaries-rules ослабевают
один PR за раз, и через год архитектура снова «толстая».

Каждый уровень закрывает свой класс ошибок. Не один тест
вместо ревью, и не ревью вместо тестов. Тесты —
**автоматическая** safety net, ревью — **семантическая**.
Они комплементарны, и в этом проекте оба обязательны.

## Концепция

### Пирамида тестов в этом проекте

Каноническая пирамида (Fowler / Cohn): много unit-тестов,
меньше integration, ещё меньше e2e. У нас:

- **29 unit suites** (`*.spec.ts` под `apps/` + `libs/`) —
  лёгкие, быстрые, гоняются без Docker'а.
- **3 e2e spec'а** в `test/`
  (`system-api.e2e-spec.ts` — 510 lines,
  `auth.e2e-spec.ts` — 199, `notification.e2e-spec.ts` — 109)
  — тяжёлые, гоняются с реальной инфрой.
- **1 architecture-lint spec** —
  `tests/lint/architecture-lint.spec.ts` (342 lines) — гоняет
  ESLint программно против hand-crafted fixture-строк.

29:3:1 — это пирамида, **сильно скошённая** в основание.
Лёгкие spec'ы дёшевы, поэтому у use-case'а и domain-модели
тестов больше; e2e — медленные и зарезервированы для
end-to-end-контрактов, не для каждого варианта.

### Unit: in-memory port-doubles вместо моков

Use-case в проекте инжектит **только порты** (см.
[[use-cases-vs-fat-services]]). Это значит, что spec
получает свободу: вместо `jest.mock(...)` и `mockResolvedValue`
он создаёт **полноценный класс**, реализующий port-
интерфейс, и держит state в `Map<>` / `Array<>`. Канонический
файл — `test-doubles.ts` рядом со spec'ами use-case'ов:

```typescript
// apps/inventory-microservice/src/modules/stock/application/use-cases/spec/test-doubles.ts
export class InMemoryStockRepository implements IStockRepositoryPort {
  public readonly items = new Map<string, StockItem>();
  public readonly deltas: IStockAppendDeltasPayload['items'] = [];

  private key(productId: number, storageId: string): string {
    return `${productId}:${storageId}`;
  }

  public seed(stockItem: StockItem): void {
    this.items.set(this.key(stockItem.productId, stockItem.storageId), stockItem);
  }
  // ... остальные методы реализуют port-shape ...
}
```

> [`apps/inventory-microservice/.../test-doubles.ts` L21-L103](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/application/use-cases/spec/test-doubles.ts#L21-L103)

Заметьте — это **plain TypeScript**, без jest-globals:

```typescript
// In-memory stock repository implementation. Stores StockItem aggregates by
// (productId, storageId). Pure TypeScript — no jest globals here so the file
// is safe to include in production builds when not excluded by tsconfig.app.
```

> [`apps/inventory-microservice/.../test-doubles.ts` L18-L20](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/application/use-cases/spec/test-doubles.ts#L18-L20)

Это намеренно: jest-API (`jest.fn`, `jest.spyOn`) недоступны
в production-сборке. Если `test-doubles.ts` несёт их, любой
не-jest-аккуратный pipeline сломается на компиляции
production. Plain-TS-implementation работает везде, и тесты
импортируют `InMemoryStockRepository` напрямую.

Преимущества над `jest.mock`-стилем:

1. **State sharing.** `repository.items` доступен во всех
   методах, и spec может читать состояние после `execute()`:
   `expect(repo.deltas).toHaveLength(2)`. С моками state
   рассыпан по mock-call-records.
2. **Type-safety при изменении port'а.** Если interface
   расширится новым методом, TypeScript-compiler пометит
   `InMemoryStockRepository` как `does not implement` — и
   spec падёт на компиляции, **до** запуска. С моками
   только runtime catch.
3. **Помещаются на одной странице.** Один файл с тремя
   классами (`InMemoryStockRepository`,
   `InMemoryStockCache`, `InMemoryStockEventsPublisher`)
   — это 147 строк; все use-case'ы stock-модуля
   используют его. Без дублирования.

ADR-013 §8 явно фиксирует эту конвенцию для retail/orders;
ADR-011 §6 — для notification. Все три микросервиса плюс
gateway/auth используют один и тот же шаблон:

```bash
$ find apps -name "test-doubles.ts"
apps/api-gateway/src/modules/auth/application/use-cases/spec/test-doubles.ts
apps/notification-microservice/src/modules/notifications/application/use-cases/spec/test-doubles.ts
apps/inventory-microservice/src/modules/stock/application/use-cases/spec/test-doubles.ts
apps/retail-microservice/src/modules/orders/application/use-cases/spec/test-doubles.ts
```

— четыре файла, четыре bounded context'а, одна конвенция.

### E2E: реальная инфраструктура через Docker Compose

E2E spec'ы поднимают **настоящие** MySQL, Redis, RabbitMQ —
не in-memory-fake'и. Это даёт два уровня уверенности:

- **Контракты wire-format'ов.** RMQ-payload, который retail-
  microservice кидает, — это тот же payload, который
  notification-microservice прочитает. Если интерфейс на
  одной стороне не совпадает — e2e падает.
- **TypeORM-mappings.** Mapping `Order` → `OrderEntity`,
  `OrderProduct` → `OrderProductEntity` гоняется на
  реальной MySQL'е с реальным `SnakeNamingStrategy`. Если
  миграция забыла колонку — `SELECT * FROM order` упадёт
  на boot'е e2e.

`yarn test:e2e` — два шага:

```bash
"test:infra:up": "docker compose up mysql redis rabbitmq --wait",
"test:infra:down": "docker compose down -v --remove-orphans",
"test:infra:reload": "yarn test:infra:down && yarn test:infra:up && yarn migration:run && yarn test:seed",
"test:unit": "jest --config jest.unit.config.js",
"test:e2e:run": "jest --config jest.e2e.config.js --runInBand --forceExit",
"test:e2e": "yarn test:infra:reload && yarn test:e2e:run"
```

> [`package.json` (extract)](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/package.json)

`test:infra:reload` — это «**hard reset**»: down с volume-
remove'ом, up с healthcheck-`--wait`, потом migration:run,
потом seed. Это даёт каждому e2e-прогону **детерминированное
начальное состояние**: один и тот же набор seed-данных, одна
и та же схема. Цена — медленнее (~30 секунд на reset),
польза — невозможен «у меня всё зелёное, а у тебя нет» из-за
leftover-rows в БД.

`--runInBand` — Jest-flag «гонять spec'ы последовательно,
не параллельно». E2E делит инфра-ресурсы (одна БД, один
broker); параллельный прогон создавал бы race'ы. ADR-011 §6
+ implicit-convention.

`--forceExit` — Jest не пытается «уйти красиво» после теста.
Это потому что nest-microservice-listener держит open
connection к RMQ (`amqp-connection-manager`), и без
`forceExit` процесс висит на close. Не идеально, но работает.

### Test-database seeding: стабильные UUID'ы

`scripts/test-db-seed.ts` создаёт **два** seed-пользователя:

```typescript
const TEST_USERS: ITestUserSeed[] = [
  {
    id: '00000000-0000-4000-a000-000000000001',
    email: 'admin@example.com',
    password: 'admin1234',
    roles: ['admin', 'customer'],
  },
  {
    id: '00000000-0000-4000-a000-000000000002',
    email: 'customer@example.com',
    password: 'customer1234',
    roles: ['customer'],
  },
];
```

> [`scripts/test-db-seed.ts` L20-L34](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/scripts/test-db-seed.ts#L20-L34)

**Стабильные UUID'ы** — это инвариант, на который опираются
assert'ы в e2e. Если seed выдавал бы `crypto.randomUUID()`
каждый раз, `auth.e2e-spec.ts` не смог бы написать
`expect(body.sub).toBe('00000000-...-000000000001')` — а
с фиксированными ID'ами этот assert работает.

Пароли — `admin1234` и `customer1234`. Они хэшируются
argon2id'ом с параметрами из env (см. [[jwt-and-rbac]]):

```typescript
const argonOptions: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: Number(process.env.AUTH_ARGON2_MEMORY_COST ?? 19_456),
  timeCost: Number(process.env.AUTH_ARGON2_TIME_COST ?? 2),
  parallelism: Number(process.env.AUTH_ARGON2_PARALLELISM ?? 1),
};
```

> [`scripts/test-db-seed.ts` L36-L41](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/scripts/test-db-seed.ts#L36-L41)

OWASP-2024-defaults используются и для seed-юзеров, и для
production-юзеров — нет «лёгкого» mode'а для тестов. Это
сознательно: если завтра кто-то понизит cost-параметры
«для скорости тестов», production-логика начнёт хешировать
по-другому, и `argon2.verify`-checks могут расходиться.
Один путь — один параметр.

### `system-api.e2e-spec.ts` — headline-suite

```typescript
// test/system-api.e2e-spec.ts
beforeAll(async () => {
  const rmqUrl = process.env.RABBITMQ_URL!;

  retailMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
    RetailMicroserviceAppModule,
    {
      logger: false,
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: MicroserviceQueueEnum.RETAIL_QUEUE,
        queueOptions: { durable: true },
      },
    },
  );

  inventoryMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
    InventoryMicroserviceAppModule, /* ... */
  );

  await Promise.all([retailMicroservice.listen(), inventoryMicroservice.listen()]);

  apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
  apiGatewayApp.setGlobalPrefix('api');
  apiGatewayApp.useGlobalPipes(/* ValidationPipe */);
  await apiGatewayApp.init();
}, timeout);
```

> [`test/system-api.e2e-spec.ts` L46-L97](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/test/system-api.e2e-spec.ts#L46-L97)

Этот `beforeAll` поднимает **три** Nest-приложения в одном
test-процессе: retail microservice, inventory microservice,
gateway. Каждое — через `NestFactory.createMicroservice` или
`NestFactory.create`, через тот же `AppModule`, через
которые они стартуют в production. RabbitMQ-транспорт
реальный, MySQL реальная (на этапе `test:infra:reload`).

Supertest даёт HTTP-клиента к gateway, который под капотом
кидает RMQ-RPC'и в retail и inventory:

```typescript
// 30:  Routes are guarded with @Roles(CUSTOMER, ADMIN) globally now.
const httpClient = () => {
  const agent = supertest.agent(apiGatewayApp.getHttpServer());
  agent.set('Authorization', `Bearer ${customerAccessToken}`);
  return agent;
};
```

> [`test/system-api.e2e-spec.ts` L32-L36](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/test/system-api.e2e-spec.ts#L32-L36)

Один e2e-test делает create-order через
`POST /api/order`, потом confirm-order через
`PUT /api/order/:id/confirm`, потом `GET /api/order/:id` —
и assert'ит, что:

- gateway возвращает правильные status/body;
- inventory'шный `product_stock` ledger обновился;
- Redis-cache невалидирован (через `getCachedStock`);
- correlation-id пробежал через все четыре сервиса (через
  Pino-logs).

Это самая полная safety-net. И именно поэтому она работает
~30+ секунд: альтернативой было бы 10 unit-тестов, каждый
из которых имитирует один кусок цепочки — но ни один не
ловит drift между ними.

### `auth.e2e-spec.ts` — rotation reuse-detection

E2E для refresh-token-rotation:

```typescript
const login = async (email: string, password: string): Promise<ITokenResponse> => {
  const { body } = await supertest(apiGatewayApp.getHttpServer())
    .post('/api/auth/login')
    .send({ email, password });
  return body as ITokenResponse;
};
```

> [`test/auth.e2e-spec.ts` L29-L34](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/test/auth.e2e-spec.ts#L29-L34)

Spec проверяет: customer-login → получает refresh → делает
refresh #1 (получает новую пару, старый refresh
invalidated) → пытается refresh #2 со **старым** refresh →
401, и **новый** refresh тоже invalidated (это и есть
rotation reuse-detection, см. [[jwt-and-rbac]]). Без e2e
этого было бы не выловить — unit-тесты `LoginUseCase` и
`RefreshTokenUseCase` отдельно проверяют каждый этап, но
flow-test «attacker steals → victim returns → both lose»
требует **двух** последовательных HTTP-запросов с
определённым ordering'ом.

### `notification.e2e-spec.ts` — синтетический publish-and-observe

Self-contained spec, не требует retail / inventory; поднимает
**только** notification-microservice, потом публикует
синтетический `retail.order.created` event прямо в очередь
и assert'ит, что `LogNotifierAdapter.send()` вызвался с
правильным `Notification`-объектом:

```typescript
sendSpy = jest.spyOn(LogNotifierAdapter.prototype, 'send');
// ...
await firstValueFrom(publisher.emit(ROUTING_KEYS.RETAIL_ORDER_CREATED, event));
await waitForCall(() => sendSpy.mock.calls.length > 0);

const sent = sendSpy.mock.calls[0][0];
expect(sent.metadata).toMatchObject({ orderId: 4242, customerId: 7 });
expect(sent.subject).toContain('4242');
expect(sent.body).toContain('4242');
```

> [`test/notification.e2e-spec.ts` L37-L107](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/test/notification.e2e-spec.ts#L37-L107)

Этот spec был **первым** e2e-test'ом для notification —
он появился в task-07 (см. ADR-011 «Consequences»), когда
producer'ы `retail.order.created` ещё не были написаны.
Synthetic-publish позволил проверить consumer + use-case +
adapter в изоляции. После task-09 (когда retail начал
emit'ить настоящие event'ы), `system-api.e2e-spec.ts` ловит
end-to-end-flow; `notification.e2e-spec.ts` остался как
focused-spec для notification-side-логики.

`waitForCall` — это poll-loop с deadline:

```typescript
const waitForCall = async (predicate: () => boolean, deadlineMs = 5_000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > deadlineMs) {
      throw new Error('Timed out waiting for notifier.send()');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
```

> [`test/notification.e2e-spec.ts` L77-L85](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/test/notification.e2e-spec.ts#L77-L85)

Это типовая е2е-eventing-проблема: publish — синхронный с
точки зрения publisher'а (broker-ack), но consumer работает
**асинхронно** в другом контексте. Без poll'а тест assert'ил
бы **сразу после** publish'а и видел бы пустой `sendSpy`.
5-секундный deadline — это запас на старт consumer'а + RMQ-
доставку.

### Architecture-lint regression spec

`tests/lint/architecture-lint.spec.ts` — четвёртый,
особый класс теста. Не unit, не e2e. Гоняет ESLint
**программно** против hand-crafted source-string'ов:

```typescript
function lint(code: string, relPath: string): Linter.LintMessage[] {
  const { linter, config } = buildLinter();
  return linter.verify(code, config, { filename: path.join(ROOT, relPath) });
}
```

> [`tests/lint/architecture-lint.spec.ts` L197-L200](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/tests/lint/architecture-lint.spec.ts#L197-L200)

Spec проверяет каждое правило из ADR-017:

- 7 «external denylist» тестов
  (`domain ↛ @nestjs/common`, `domain ↛ typeorm`,
  `use-case ↛ @keyv/redis`, etc.);
- 5 «element-type denial» тестов
  (`domain ↛ infrastructure`,
  `presentation ↛ infrastructure`,
  `use-case ↛ another app`, etc.);
- 2 «positive case» теста
  (`domain → lib-ddd` allowed,
  `infrastructure → lib-cache` allowed).

См. [[lib-eslint-plugin-boundaries]] для детального
разбора. Здесь важно: spec гоняется через
`yarn test:unit` (как и другие unit-spec'ы), не требует
инфры, и падает за ~2 секунды если правило слабнет.

### Что Jest **не** ловит

Список ограничений важен:

1. **Coverage статусы не assert'ятся.** Coverage-thresholds
   не выставлены в `jest.unit.config.js`. Это сознательно
   — coverage-цель ставится в репо-уровневых guidelines, не
   в test-gate'е. Если coverage упадёт с 80% до 30%, jest
   зелёный, но code-review должно заметить.
2. **Race-условия cache-aside не проверены.** Audit-item
   `CACHE-001` (race window между cache-miss и cache-set)
   — единственный путь — concurrency-тест с двумя
   одновременными запросами, что Jest in-band не имитирует.
   См. [[cache-aside-pattern]] для статуса этого audit'а.
3. **Performance regressions не отлавливаются.** Если
   `ConfirmOrderUseCase` начнёт делать N+1 SELECT'ы,
   `system-api.e2e-spec.ts` всё равно пройдёт — он
   assert'ит correctness, не latency.
4. **Cross-service contract'ы пройдут, если оба сервиса
   импортируют один тип из `libs/contracts`.** ADR-013 §7
   фиксирует: «cross-service contract test is the TypeScript
   compile». Не runtime check, но static check на этапе
   `yarn build`.
5. **Не покрывают Docker-compose-config.** Если кто-то
   изменит порт MySQL в `docker-compose.yml`, test'ы
   падают через таймаут — это **диагностика снизу**, не
   валидация конфига сверху.

### CI gate-цепочка

GitHub Actions workflow `.github/workflows/ci-cd.yml` гонит
четыре последовательных шага:

```
1. yarn install         (resolve + fetch + link)
2. yarn lint            (--max-warnings 0; включает boundaries-rules)
3. yarn build           (nest build --all → 4 webpack-bundle'а)
4. yarn test:unit       (29 spec suites)
5. yarn test:e2e        (test:infra:reload + 3 e2e spec'а)
```

Падение **любого** — PR не merge'ится. ADR-017 §5 явно
фиксирует, что architecture-lint исполняется внутри
`yarn lint`-шага, не отдельным job'ом.

Время до merge'а: ~3-5 минут (без e2e-fail-fast) — это
ниже, чем ручной QA-cycle, и даёт reviewer-у уверенность,
что technical-correctness уже проверена.

## Связанные решения

- [[lib-eslint-plugin-boundaries]] — `tests/lint/`-spec
  кодирует regression-rules для архитектурных границ.
- [[hexagonal-architecture]] — почему port-driven design
  делает unit-тесты возможными без mock'ов.
- [[use-cases-vs-fat-services]] — use-case с in-memory-
  port'ом — это пять строк теста, без `jest.mock`.
- [[notifier-port-and-adapters]] — `LogNotifierAdapter` —
  единственный, который реально работает в `notification.e2e-spec.ts`.
- [[entity-vs-domain-model]] — `OrderMapper.spec.ts`
  проверяет entity↔domain round-trip.
- [[mappers-and-repositories]] — repository spec'и
  ассерт'ят правильное mapping'-поведение.
- [[rabbitmq-as-bus]] — `test:infra:up`-step поднимает
  RabbitMQ-контейнер; e2e гоняют **реальный** broker.
- [[cache-aside-pattern]] — open audit-items, которые
  unit-тестами не покрыты.
- [[jwt-and-rbac]] — `auth.e2e-spec.ts` проверяет
  rotation reuse-detection — flow-test, который unit'ом
  не воспроизводится.
- ADR-011, ADR-012, ADR-013 — каждая фиксирует
  in-memory-test-double convention для своего bounded
  context'а.
- ADR-017 §7 — fixture-spec как бумпер.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| Unit test | Тест одной единицы кода (класса, функции); без I/O. |
| E2E test | End-to-end — проверка через все слои, с реальной инфрой. |
| Test pyramid | Соотношение «много unit / меньше integration / ещё меньше e2e». |
| In-memory port double | Plain-TS-класс, реализующий port-interface; держит state в Map/Array. |
| `test-doubles.ts` | Файл-конвенция; рядом со spec'ами use-case'ов. |
| Jest | Test-runner; 29 suites в проекте на HEAD. |
| ts-jest | Transformer для запуска TS-тестов под Jest. |
| Supertest | HTTP-клиент для тестов; обёртка над Express-server'ом. |
| `--runInBand` | Jest-flag: последовательное выполнение spec'ов. |
| `--forceExit` | Jest-flag: жёстко выйти после теста (для висящих connection'ов). |
| `beforeAll` / `afterAll` | Jest-hook: один раз на suite. |
| `beforeEach` | Jest-hook: перед каждым `it`. |
| `jest.spyOn` | Spy на метод object'а; не подменяет реализацию. |
| `jest.mock` | Полная подмена модуля (мы избегаем в use-case-spec'ах). |
| `test:infra:reload` | npm-скрипт: down + up + migration:run + seed. |
| Hard reset | Удаление Docker-volume'ов перед запуском теста. |
| Healthcheck (`--wait`) | Docker-compose-flag: ждать «healthy» status перед началом тестов. |
| Seed | Скрипт `scripts/test-db-seed.ts`, создаёт стабильных юзеров и базу для assert'ов. |
| Stable UUID | Fixed-value UUID, на который assert'ятся `expect.toBe(...)`. |
| OWASP-2024 defaults | argon2id-параметры в seed; те же, что в production. |
| RPC | Request-response через RMQ; `@MessagePattern`. |
| Event | Fire-and-forget через RMQ; `@EventPattern`. |
| `waitForCall` | Poll-loop с deadline для async-event'ов в e2e. |
| Architecture-lint spec | `tests/lint/architecture-lint.spec.ts`; гоняет ESLint программно. |
| `Linter.verify(code, config, { filename })` | Programmatic ESLint-API; matches element-pattern против synthetic filename. |
| Bumper | Spec, ловящий regression / loosening; не contract test. |
| Fixture | Hand-crafted source-string или JSON-payload в test'е. |
| Race window (CACHE-001) | Открытый audit-item; concurrency-race-condition. |
| Coverage threshold | Минимальная %-coverage перед прохождением; **не выставлен** в проекте. |
| CI gate | Шаг workflow, который должен пройти для merge'а. |

> [!faq]- Проверь себя
> 1. `test-doubles.ts` явно помечен «pure TypeScript — no
>    jest globals here». Что бы произошло, если внутри
>    использовался бы `jest.fn()`, и почему это плохо
>    специально для production-build'а?
> 2. `yarn test:e2e` начинается с `test:infra:reload`,
>    который **сначала** `docker compose down -v`. Зачем
>    `-v`-flag? Что бы произошло, если бы он отсутствовал?
> 3. `notification.e2e-spec.ts` использует `waitForCall`-
>    poll-loop с 5-секундным deadline. Почему нельзя просто
>    добавить `await new Promise(resolve =>
>    setTimeout(resolve, 5000))` после publish'а?
> 4. Coverage-thresholds в `jest.unit.config.js` **не**
>    выставлены. Назовите две причины, почему это
>    сознательно, и одну — почему оно может быть проблемой.
> 5. `system-api.e2e-spec.ts` поднимает три Nest-app'а в
>    одном test-процессе. Почему именно три, а не четыре
>    (нет notification-microservice'а)? И почему все три
>    через `AppModule`, импортируемый через
>    `@retail-inventory-system/apps/<name>`?

## Что почитать дальше

- [Martin Fowler, «TestPyramid»](https://martinfowler.com/bliki/TestPyramid.html)
  — каноническое определение, на которое опирается наша
  29:3:1-структура.
- [Mike Cohn, «Succeeding with Agile», Chapter 16
  «Test-Driven Development»](https://www.mountaingoatsoftware.com/books/succeeding-with-agile-software-development-using-scrum)
  — оригинальная формулировка пирамиды.
- [Jest Documentation](https://jestjs.io/docs/getting-started)
  — для понимания `--runInBand`, `--forceExit`, custom
  `config.moduleNameMapper`.
- [Supertest README](https://github.com/ladjs/supertest)
  — для понимания `agent`-pattern'а и chaining-API.
- [ADR-011](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/011-notifier-port-and-adapters.md),
  [ADR-012](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/012-stock-aggregate-and-port-adapter.md),
  [ADR-013](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/013-order-aggregate-and-cross-service-confirm.md)
  — каждый decision-record фиксирует test-doubles-convention
  для своего bounded context'а.
- [`docs/audits/audit-2026-05-08.md`](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/audits/audit-2026-05-08.md)
  — список open audit-items, ловящих race-condition'ы и
  другие проблемы, которые сегодняшние тесты не покрывают.
