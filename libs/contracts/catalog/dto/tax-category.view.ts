import { ApiResponseProperty } from '@nestjs/swagger';

// A tax category is a **classification label and nothing more** — a stable UPPER_SNAKE_CASE
// `code`, a human name, an optional description. It carries no rate and no jurisdiction, and the
// system computes no tax anywhere (ADR-026). Attaching one to a variant classifies it; it does
// not price it.
export class TaxCategoryView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public code: string;

  @ApiResponseProperty()
  public name: string;

  @ApiResponseProperty()
  public description: string | null;
}
