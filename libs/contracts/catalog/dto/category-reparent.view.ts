import { ApiResponseProperty } from '@nestjs/swagger';

import { CategoryView } from './category.view';

export class CategoryReparentView {
  @ApiResponseProperty({ type: CategoryView })
  public category: CategoryView;

  @ApiResponseProperty()
  public rewrittenDescendantCount: number;
}
