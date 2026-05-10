import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('user')
export class UserEntity {
  @PrimaryColumn('char', { length: 36 })
  public id: string;

  @Column('varchar', { length: 255 })
  public email: string;

  @Column('varchar', { length: 255 })
  public passwordHash: string;

  @Column('simple-array')
  public roles: string[];

  @Column('varchar', { length: 255, nullable: true })
  public refreshTokenHash: string | null;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;

  @DeleteDateColumn({ nullable: true })
  public deletedAt: Date | null;
}
