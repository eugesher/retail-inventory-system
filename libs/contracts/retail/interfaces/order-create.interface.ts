import { ICorrelationPayload } from '@retail-inventory-system/common';

import { OrderCreateDto } from '../dto';

export interface IOrderCreatePayload extends ICorrelationPayload, OrderCreateDto {}
