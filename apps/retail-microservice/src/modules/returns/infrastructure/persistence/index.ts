import { ReturnRequestEntity } from './return-request.entity';
import { ReturnLineEntity } from './return-line.entity';

export const returnEntities = [ReturnRequestEntity, ReturnLineEntity];

export { ReturnRequestEntity, ReturnLineEntity };
export * from './return-request.mapper';
export * from './return-line.mapper';
export * from './return-request-typeorm.repository';
export * from './return-request-write-typeorm.repository';
export * from './returns-unit-of-work.adapter';
export * from './return-order-reader-typeorm.adapter';
export * from './customer-contact-reader.typeorm.adapter';
