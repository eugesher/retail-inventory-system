import { ApiResponseProperty } from '@nestjs/swagger';

import { CategoryView } from './category.view';

export class CategoryTreeNodeView extends CategoryView {
  @ApiResponseProperty({ type: () => [CategoryTreeNodeView] })
  public children: CategoryTreeNodeView[];
}
