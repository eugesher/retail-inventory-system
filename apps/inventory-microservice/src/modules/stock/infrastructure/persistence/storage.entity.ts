import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('storage')
export class Storage {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  public id: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  public name: string | null;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
