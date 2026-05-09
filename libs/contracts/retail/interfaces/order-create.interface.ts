import { ICorrelationPayload } from '../../microservices';
import { OrderCreateDto } from '../dto';

export interface IOrderCreatePayload extends ICorrelationPayload, OrderCreateDto {}
