import { ICorrelationPayload } from '../../common';
import { OrderCreateDto } from '../dto';

export interface IOrderCreatePayload extends ICorrelationPayload, OrderCreateDto {}
