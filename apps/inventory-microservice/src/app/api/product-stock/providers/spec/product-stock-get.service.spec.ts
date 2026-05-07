import { PinoLogger } from 'nestjs-pino';

import { ProductStockGetResponseDto } from '@retail-inventory-system/inventory';
import { ProductStockCommonService } from '../../../../common/modules';
import { ProductStockGetService } from '../product-stock-get.service';

const correlationId = 'corr-1';
const sampleDto: ProductStockGetResponseDto = {
  productId: 1,
  quantity: 5,
  updatedAt: null,
  items: [],
};

// LoggerMock factory duplication: this LoggerMock type + makeLogger factory
// is duplicated across all six inventory-microservice product-stock specs and
// should be hoisted into a shared spec-helper. See
// product-stock-common-cache.service.spec.ts header for the full convention
// rationale.
type LoggerMock = Record<'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace', jest.Mock>;

const makeLogger = (): LoggerMock => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
});

describe('ProductStockGetService', () => {
  let commonService: jest.Mocked<Pick<ProductStockCommonService, 'get'>>;
  let logger: LoggerMock;
  let service: ProductStockGetService;

  beforeEach(() => {
    jest.resetAllMocks();
    commonService = { get: jest.fn() } as never;
    logger = makeLogger();
    service = new ProductStockGetService(
      commonService as unknown as ProductStockCommonService,
      logger as unknown as PinoLogger,
    );
  });

  describe('execute', () => {
    it('info-logs the RPC entry and returns the result of the common service', async () => {
      commonService.get.mockResolvedValue(sampleDto);
      const payload = { productId: 1, correlationId };

      const result = await service.execute(payload);

      expect(result).toBe(sampleDto);
      expect(commonService.get).toHaveBeenCalledWith(payload);
      expect(logger.info).toHaveBeenCalledWith(payload, 'Received RPC: get product stock');
    });

    it('error-logs with the err field and rethrows when the common service rejects', async () => {
      const err = new Error('downstream-fail');
      commonService.get.mockRejectedValue(err);
      const payload = { productId: 1, correlationId };

      await expect(service.execute(payload)).rejects.toBe(err);
      expect(logger.error).toHaveBeenCalledWith(
        { err, ...payload },
        'Error retrieving product stock',
      );
    });
  });
});
