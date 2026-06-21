import { ReturnRequestEntity } from './return-request.entity';
import { ReturnLineEntity } from './return-line.entity';

// A concrete entity array (spreadable) so retail `app.module.ts` can merge it with
// `cartEntities` + `orderEntities` into the one `DatabaseModule.forRoot([...])`
// connection. Listing the `ReturnRequest{,Line}Entity` rows here is what registers the
// `return_request` / `return_line` tables at the root connection.
export const returnEntities = [ReturnRequestEntity, ReturnLineEntity];

export { ReturnRequestEntity, ReturnLineEntity };
export * from './return-request.mapper';
export * from './return-line.mapper';
export * from './return-request-typeorm.repository';
export * from './return-order-reader-typeorm.adapter';
export * from './customer-contact-reader.typeorm.adapter';
export * from './typeorm-transaction.adapter';
