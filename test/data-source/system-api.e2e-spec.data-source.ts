import { DataSource } from 'typeorm';

export class SystemApiE2ESpecDataSource extends DataSource {
  public async getOrderRowsByOrderId(orderId: number): Promise<any> {
    return await this.query(
      `
        SELECT status_id
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
}
