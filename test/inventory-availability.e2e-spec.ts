import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

// The inventory read path end-to-end: HTTP through the gateway's inventory module
// (`/api/inventory/*`) → RabbitMQ (`inventory.stock-level.get` /
// `inventory.location.list`) → the inventory microservice → MySQL, with Redis
// cache-aside on the variant-stock read. The seed (scripts/seeds/stock-level.sql)
// gives every catalog variant (ids 1..4) 100 on hand at `default-warehouse`, so
// the public read returns a real figure without any consumer having run.

// `admin@example.com` (seeded) carries every permission, including
// `inventory:read`, so it is the positive fixture for the protected locations
// route. The default warehouse id is provisioned by the migration.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const DEFAULT_WAREHOUSE = 'default-warehouse';

interface ITokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface IStockLevelBody {
  stockLocationId: string;
  quantityOnHand: number;
  quantityAllocated: number;
  quantityReserved: number;
  available: number;
  version: number;
  updatedAt: string | null;
}

interface IVariantStockBody {
  variantId: number;
  totalOnHand: number;
  totalAvailable: number;
  locations: IStockLevelBody[];
}

interface IStockLocationBody {
  id: string;
  name: string;
  code: string;
  type: string;
  gln: string | null;
  active: boolean;
}

describe('Inventory availability read path (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let inventoryMicroservice: INestMicroservice;

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/staff/login')
      .send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

    inventoryMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      InventoryMicroserviceAppModule,
      {
        logger: false,
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          queue: MicroserviceQueueEnum.INVENTORY_QUEUE,
          queueOptions: { durable: true },
        },
      },
    );

    await inventoryMicroservice.listen();

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await inventoryMicroservice?.close();
  });

  describe('GET /api/inventory/variants/:variantId/stock (public)', () => {
    it('returns the seeded availability without an Authorization header (proves @Public())', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(
        '/api/inventory/variants/1/stock',
      );

      expect(status).toBe(HttpStatus.OK);
      const stock = body as IVariantStockBody;
      expect(stock.variantId).toBe(1);
      expect(stock.totalOnHand).toBe(100);
      expect(stock.totalAvailable).toBe(100);
      expect(stock.locations).toHaveLength(1);

      const [level] = stock.locations;
      expect(level.stockLocationId).toBe(DEFAULT_WAREHOUSE);
      expect(level.quantityOnHand).toBe(100);
      expect(level.available).toBe(100);
    });

    it('serves the second identical read from the cache (miss then hit)', async () => {
      // Cache-aside (ADR-002): the first read is a miss that loads from MySQL and
      // writes the `VariantStockView` back under `ris:inventory:stock:v3:1:__all__`;
      // the second is a hit served from Redis. The cached value is deterministic
      // (the read use case sorts locations), so the two HTTP bodies are byte-equal.
      const first = await supertest(apiGatewayApp.getHttpServer()).get(
        '/api/inventory/variants/1/stock',
      );
      const second = await supertest(apiGatewayApp.getHttpServer()).get(
        '/api/inventory/variants/1/stock',
      );

      expect(first.status).toBe(HttpStatus.OK);
      expect(second.status).toBe(HttpStatus.OK);
      expect(second.body).toEqual(first.body);
    });

    it('returns a 200 zero-availability answer for a variant with no stock rows', async () => {
      // An empty `locations` array is a valid availability answer — "zero
      // available everywhere", not a 404.
      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(
        '/api/inventory/variants/999/stock',
      );

      expect(status).toBe(HttpStatus.OK);
      const stock = body as IVariantStockBody;
      expect(stock.variantId).toBe(999);
      expect(stock.totalOnHand).toBe(0);
      expect(stock.totalAvailable).toBe(0);
      expect(stock.locations).toEqual([]);
    });

    it('scopes the answer to a single location via the comma-separated ?locationIds', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(
        `/api/inventory/variants/1/stock?locationIds=${DEFAULT_WAREHOUSE}`,
      );

      expect(status).toBe(HttpStatus.OK);
      const stock = body as IVariantStockBody;
      expect(stock.totalOnHand).toBe(100);
      expect(stock.locations.map((l) => l.stockLocationId)).toEqual([DEFAULT_WAREHOUSE]);
    });
  });

  describe('GET /api/inventory/locations (staff, inventory:read)', () => {
    it('returns 401 without a token', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer()).get(
        '/api/inventory/locations',
      );

      expect(status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('returns 200 with a staff token and includes the default warehouse', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/inventory/locations')
        .set('Authorization', auth);

      expect(status).toBe(HttpStatus.OK);
      const locations = body as IStockLocationBody[];
      const warehouse = locations.find((l) => l.id === DEFAULT_WAREHOUSE);
      expect(warehouse).toBeDefined();
      expect(warehouse?.active).toBe(true);
    });
  });
});
