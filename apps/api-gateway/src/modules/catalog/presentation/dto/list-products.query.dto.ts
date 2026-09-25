import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ListProductsQueryDto {
  @ApiPropertyOptional({ enum: ['active', 'draft', 'archived'], example: 'active' })
  @IsOptional()
  @IsIn(['active', 'draft', 'archived'])
  public status?: 'active' | 'draft' | 'archived';

  @ApiPropertyOptional({ example: 1, minimum: 1, description: '1-based page index' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({ example: 20, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public pageSize?: number;

  @ApiPropertyOptional({ example: 'chair', description: 'Free-text name/slug filter' })
  @IsOptional()
  @IsString()
  public search?: string;
}
