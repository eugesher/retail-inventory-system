export class ProductStockGetDto {
  public productId: string;
  public storeIds?: string[];
}

export class ProductStockResponseDto {
  public productId: string;
  public stock: {
    storeId: string;
    quantity: number;
    updatedAt: Date;
  }[];
  public updatedAt: Date;
}
