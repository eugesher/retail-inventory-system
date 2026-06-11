import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

import { SLUG_PATTERN, SLUG_REGEX } from './validation.constants';

// Request body for `PATCH /api/catalog/categories/:slug/parent`. The category to
// move is named by the `:slug` path param; this body carries only the
// destination. `newParentSlug` is the destination parent's slug — a non-null
// value reparents the category (and its whole subtree) under that parent, while
// an **absent or `null`** value demotes the category to a root (`path = /<slug>`).
//
// `@IsOptional()` treats both `undefined` and `null` as "skip validation", so the
// kebab-case `@Matches` runs only on a supplied non-null slug — exactly the
// absent/null-demotes-to-root contract (ADR-029 §2). The catalog domain enforces
// the cycle guard (you cannot move a category under itself or a descendant).
export class ReparentCategoryRequestDto {
  @ApiPropertyOptional({
    example: 'apparel',
    nullable: true,
    description: 'Slug of the new parent; omit or send null to demote to a root category',
    pattern: SLUG_PATTERN,
  })
  @IsOptional()
  @IsString()
  @Matches(SLUG_REGEX, { message: 'newParentSlug must be kebab-case (^[a-z0-9]+(?:-[a-z0-9]+)*$)' })
  public newParentSlug?: string | null;
}
