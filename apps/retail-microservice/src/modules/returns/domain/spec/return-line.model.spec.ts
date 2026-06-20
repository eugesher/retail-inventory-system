import { ReturnDispositionEnum, ReturnLineConditionEnum } from '@retail-inventory-system/contracts';

import { IReturnLineProps, ReturnDomainException, ReturnErrorCodeEnum, ReturnLine } from '..';

const lineProps = (overrides: Partial<IReturnLineProps> = {}): IReturnLineProps => ({
  id: null,
  returnRequestId: null,
  orderLineId: 10,
  quantity: 2,
  condition: null,
  disposition: null,
  lineRefundAmountMinor: null,
  ...overrides,
});

describe('ReturnLine', () => {
  describe('quantity invariant', () => {
    it('builds a line with null inspection fields', () => {
      const line = new ReturnLine(lineProps());

      expect(line.orderLineId).toBe(10);
      expect(line.quantity).toBe(2);
      expect(line.condition).toBeNull();
      expect(line.disposition).toBeNull();
      expect(line.lineRefundAmountMinor).toBeNull();
    });

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['fractional', 1.5],
    ])('rejects a %s quantity with RETURN_LINE_QUANTITY_INVALID', (_label, quantity) => {
      try {
        new ReturnLine(lineProps({ quantity }));
        fail('expected the ReturnLine constructor to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ReturnDomainException);
        expect((err as ReturnDomainException).code).toBe(
          ReturnErrorCodeEnum.RETURN_LINE_QUANTITY_INVALID,
        );
      }
    });
  });

  describe('inspect', () => {
    it('records condition, disposition, and the refund amount', () => {
      const line = new ReturnLine(lineProps());

      line.inspect({
        condition: ReturnLineConditionEnum.NEW,
        disposition: ReturnDispositionEnum.RESTOCK,
        lineRefundAmountMinor: 1299,
      });

      expect(line.condition).toBe(ReturnLineConditionEnum.NEW);
      expect(line.disposition).toBe(ReturnDispositionEnum.RESTOCK);
      expect(line.lineRefundAmountMinor).toBe(1299);
    });

    it('accepts a zero refund amount (a non-refundable disposition)', () => {
      const line = new ReturnLine(lineProps());

      line.inspect({
        condition: ReturnLineConditionEnum.DAMAGED,
        disposition: ReturnDispositionEnum.SCRAP,
        lineRefundAmountMinor: 0,
      });

      expect(line.lineRefundAmountMinor).toBe(0);
    });

    it.each([
      ['negative', -1],
      ['fractional', 10.5],
    ])(
      'rejects a %s refund amount with RETURN_INSPECTION_INVALID',
      (_label, lineRefundAmountMinor) => {
        const line = new ReturnLine(lineProps());

        try {
          line.inspect({
            condition: ReturnLineConditionEnum.NEW,
            disposition: ReturnDispositionEnum.RESTOCK,
            lineRefundAmountMinor,
          });
          fail('expected inspect to throw');
        } catch (err) {
          expect((err as ReturnDomainException).code).toBe(
            ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID,
          );
        }
        // A rejected inspection leaves the line's fields null.
        expect(line.lineRefundAmountMinor).toBeNull();
      },
    );

    it('rejects an unknown condition enum with RETURN_INSPECTION_INVALID', () => {
      const line = new ReturnLine(lineProps());

      try {
        line.inspect({
          condition: 'pristine' as ReturnLineConditionEnum,
          disposition: ReturnDispositionEnum.RESTOCK,
          lineRefundAmountMinor: 100,
        });
        fail('expected inspect to throw');
      } catch (err) {
        expect((err as ReturnDomainException).code).toBe(
          ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID,
        );
      }
    });

    it('rejects an unknown disposition enum with RETURN_INSPECTION_INVALID', () => {
      const line = new ReturnLine(lineProps());

      expect(() =>
        line.inspect({
          condition: ReturnLineConditionEnum.NEW,
          disposition: 'incinerate' as ReturnDispositionEnum,
          lineRefundAmountMinor: 100,
        }),
      ).toThrow(ReturnDomainException);
    });
  });
});
