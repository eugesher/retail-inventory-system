import { DataSource } from 'typeorm';

export class SystemApiE2ESpecDataSource extends DataSource {
  public async getOrderRowsByOrderId(orderId: number): Promise<any> {
    return await this.query(
      `
        SELECT customer_id, status_id
        FROM \`order\`
        WHERE id = ?;
      `,
      [orderId],
    );
  }

  public async getOrderProductRowsByOrderId(orderId: number): Promise<any> {
    return await this.query(
      `
        SELECT id, product_id, status_id
        FROM order_product
        WHERE order_id = ?
        ORDER BY id;
      `,
      [orderId],
    );
  }

  public async getProductStockRowsByOrderId(orderId: number): Promise<any> {
    return await this.query(
      `
        SELECT ps.id               AS id,
               ps.product_id       AS product_id,
               ps.storage_id       AS storage_id,
               ps.action_id        AS action_id,
               ps.quantity         AS quantity,
               ps.order_product_id AS order_product_id
        FROM product_stock ps
               JOIN order_product op ON ps.order_product_id = op.id
        WHERE op.order_id = ?
        ORDER BY ps.id;
      `,
      [orderId],
    );
  }
}
