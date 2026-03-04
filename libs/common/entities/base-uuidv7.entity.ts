import { PrimaryColumn, BeforeInsert, AfterLoad, Column } from 'typeorm';
import { uuidv7obj } from 'uuidv7';

export abstract class BaseUuidv7Entity {
  @PrimaryColumn({ type: 'binary', length: 16 })
  public id: Buffer;

  @Column()
  public createdAt: Date;

  @Column()
  public updatedAt: Date;

  public uuid: string;

  @BeforeInsert()
  protected beforeInsert(): void {
    if (this.id) {
      return;
    }

    const uuidObj = uuidv7obj();
    const uuidStr = uuidObj.toString();
    const hex = uuidStr.replace(/-/g, '');

    if (hex.length !== 32) {
      throw new Error('Invalid UUIDv7 length after normalization');
    }

    this.id = Buffer.from(hex, 'hex');
    this.uuid = uuidStr.toString();
  }

  @AfterLoad()
  protected afterLoad(): void {
    const hex = this.id.toString('hex');

    this.uuid = [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');
  }
}
