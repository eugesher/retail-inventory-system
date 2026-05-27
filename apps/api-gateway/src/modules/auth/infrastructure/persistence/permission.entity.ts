import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('permission')
export class PermissionEntity {
  @PrimaryColumn('char', { length: 36 })
  public id: string;

  @Column('varchar', { length: 64, unique: true })
  public code: string;

  @Column('varchar', { length: 255, nullable: true })
  public description: string | null;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
