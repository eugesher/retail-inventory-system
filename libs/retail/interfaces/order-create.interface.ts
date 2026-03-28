import { OrderCreateDto } from '../dto';

export interface IOrderCreatePayload extends OrderCreateDto {
  correlationId: string;
}
