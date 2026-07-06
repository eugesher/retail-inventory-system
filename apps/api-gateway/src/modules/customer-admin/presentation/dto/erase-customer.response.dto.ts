import { ApiProperty } from '@nestjs/swagger';

// The `POST /api/admin/customers/:id/erase` response — the resulting tombstone
// state. No PII (the whole point of the erase); only the terminal status and the
// erase instant.
export class EraseCustomerResponseDto {
  @ApiProperty({ example: 'deleted', description: 'The terminal customer status after the erase' })
  public status: 'deleted';

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-07-05T12:00:00.000Z',
    description: 'ISO-8601 erase instant (mirrors customer.deleted_at)',
  })
  public erasedAt: string | null;
}
