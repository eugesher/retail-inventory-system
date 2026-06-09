import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { StockLocation, StockLocationTypeEnum } from '../../../domain';
import { ListLocationsUseCase } from '../list-locations.use-case';
import { InMemoryStockRepository } from './test-doubles';

const correlationId = 'corr-1';

const location = (props: {
  id: string;
  name?: string;
  code: string;
  type?: StockLocationTypeEnum;
  gln?: string | null;
  active?: boolean;
}): StockLocation =>
  new StockLocation({
    id: props.id,
    name: props.name ?? props.id,
    code: props.code,
    type: props.type ?? StockLocationTypeEnum.WAREHOUSE,
    gln: props.gln ?? null,
    active: props.active ?? true,
  });

describe('ListLocationsUseCase', () => {
  let repository: InMemoryStockRepository;
  let logger: PinoLoggerMock;
  let useCase: ListLocationsUseCase;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    logger = makePinoLoggerMock();
    useCase = new ListLocationsUseCase(repository, logger as unknown as PinoLogger);
  });

  it('maps each StockLocation to a StockLocationView (omitting address)', async () => {
    repository.seedLocation(
      location({
        id: 'default-warehouse',
        name: 'Default Warehouse',
        code: 'DW',
        type: StockLocationTypeEnum.WAREHOUSE,
        gln: '1234567890123',
      }),
    );

    const result = await useCase.execute({ correlationId });

    expect(result).toEqual([
      {
        id: 'default-warehouse',
        name: 'Default Warehouse',
        code: 'DW',
        type: 'warehouse',
        gln: '1234567890123',
        active: true,
      },
    ]);
    // `address` is deliberately omitted from the view.
    expect(result[0]).not.toHaveProperty('address');
  });

  it('honours the activeOnly filter', async () => {
    repository.seedLocation(location({ id: 'active-loc', code: 'AL', active: true }));
    repository.seedLocation(location({ id: 'inactive-loc', code: 'IL', active: false }));

    const activeOnly = await useCase.execute({ activeOnly: true, correlationId });
    expect(activeOnly.map((l) => l.id)).toEqual(['active-loc']);

    const all = await useCase.execute({ activeOnly: false, correlationId });
    expect(all.map((l) => l.id).sort()).toEqual(['active-loc', 'inactive-loc']);
  });

  it('returns an empty array when no locations exist', async () => {
    const result = await useCase.execute({ correlationId });
    expect(result).toEqual([]);
  });
});
