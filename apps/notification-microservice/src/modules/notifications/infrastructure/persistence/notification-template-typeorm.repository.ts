import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, FindOptionsWhere, Repository } from 'typeorm';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';
import { BaseTypeormRepository } from '@retail-inventory-system/database';

import {
  INotificationTemplateListFilter,
  INotificationTemplateRepositoryPort,
} from '../../application/ports';
import {
  NotificationDomainException,
  NotificationErrorCodeEnum,
  NotificationTemplate,
} from '../../domain';
import { isDuplicateEntryError } from './mysql-error.util';
import { NotificationTemplateEntity } from './notification-template.entity';
import { NotificationTemplateMapper } from './notification-template.mapper';

// The single `@InjectRepository(NotificationTemplateEntity)` site for the
// `NotificationTemplate` aggregate. A single-row upsert (no owned children, no
// `@VersionColumn`), re-reading by id so the returned aggregate carries the generated
// BIGINT id + committed timestamps (the "re-read the saved graph" idiom the
// payment/refund repos follow). Returns domain types only — no TypeORM leak (ADR-017).
@Injectable()
export class NotificationTemplateTypeormRepository
  extends BaseTypeormRepository<NotificationTemplateEntity, NotificationTemplate>
  implements INotificationTemplateRepositoryPort
{
  constructor(
    @InjectRepository(NotificationTemplateEntity)
    private readonly templateRepository: Repository<NotificationTemplateEntity>,
  ) {
    super(templateRepository);
  }

  protected toDomain(entity: NotificationTemplateEntity): NotificationTemplate {
    return NotificationTemplateMapper.toDomain(entity);
  }

  protected toEntity(domain: NotificationTemplate): DeepPartial<NotificationTemplateEntity> {
    return NotificationTemplateMapper.toEntity(domain);
  }

  public async save(template: NotificationTemplate): Promise<NotificationTemplate> {
    let saved: NotificationTemplateEntity;
    try {
      saved = await this.templateRepository.save(NotificationTemplateMapper.toEntity(template));
    } catch (error) {
      // A concurrent author that raced past the use case's `maxVersion` pre-check writes
      // the same `(event_type, channel, locale, version)` and collides on the natural-key
      // UNIQUE. The pre-check cannot close that TOCTOU race — the UNIQUE is the real
      // backstop — so translate the `ER_DUP_ENTRY` into the typed duplicate-version code
      // (→ 409) here rather than leaking a raw driver error as a 500 (the delivery-repo
      // ER_DUP translation precedent).
      if (isDuplicateEntryError(error)) {
        throw new NotificationDomainException(
          NotificationErrorCodeEnum.TEMPLATE_DUPLICATE_VERSION,
          `A notification template for (${template.eventType}, ${template.channel}, ${template.locale}) at version ${template.version} already exists`,
        );
      }
      throw error;
    }
    // Re-read so the returned aggregate carries the concrete generated id + committed DB
    // timestamps. The row was just written, so a miss is an invariant breach.
    const reloaded = await this.templateRepository.findOne({ where: { id: Number(saved.id) } });
    if (!reloaded) {
      throw new Error(
        `NotificationTemplateTypeormRepository.save: template ${saved.id} vanished after commit`,
      );
    }
    return NotificationTemplateMapper.toDomain(reloaded);
  }

  public async findById(id: number): Promise<NotificationTemplate | null> {
    const entity = await this.templateRepository.findOne({ where: { id } });
    return entity ? NotificationTemplateMapper.toDomain(entity) : null;
  }

  // The hot path: the highest-`version` `active` row for the registry key. `version
  // DESC` + `LIMIT 1` returns the live template; a null means no active template (the
  // caller falls back). Served by the `(event_type, channel, locale, active)` index.
  public async findLatestActive(
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
  ): Promise<NotificationTemplate | null> {
    const entity = await this.templateRepository.findOne({
      where: { eventType, channel, locale, active: true },
      order: { version: 'DESC' },
    });
    return entity ? NotificationTemplateMapper.toDomain(entity) : null;
  }

  // The exact `(eventType, channel, locale, version)` row — the duplicate-version
  // pre-check / a version-specific rollback. Backed by the UNIQUE index.
  public async findByNaturalKey(
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
    version: number,
  ): Promise<NotificationTemplate | null> {
    const entity = await this.templateRepository.findOne({
      where: { eventType, channel, locale, version },
    });
    return entity ? NotificationTemplateMapper.toDomain(entity) : null;
  }

  // The highest `version` across ALL rows for the key (active or not), or null when the
  // key has no rows. The Author use case derives the next version from it
  // (`(maxVersion ?? 0) + 1`). `maximum` compiles to `SELECT MAX(version) … WHERE …`.
  public async maxVersion(
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
  ): Promise<number | null> {
    const max = await this.templateRepository.maximum('version', {
      eventType,
      channel,
      locale,
    });
    return max ?? null;
  }

  // The registry browse — filtered, unpaginated (the registry is small), newest-first
  // by `(event_type, channel, locale, version DESC)` so each key's versions group with
  // the live one on top.
  public async list(filter: INotificationTemplateListFilter): Promise<NotificationTemplate[]> {
    const where: FindOptionsWhere<NotificationTemplateEntity> = {};
    if (filter.eventType !== undefined) {
      where.eventType = filter.eventType;
    }
    if (filter.channel !== undefined) {
      where.channel = filter.channel;
    }
    if (filter.locale !== undefined) {
      where.locale = filter.locale;
    }
    if (filter.activeOnly === true) {
      where.active = true;
    }

    const entities = await this.templateRepository.find({
      where,
      order: { eventType: 'ASC', channel: 'ASC', locale: 'ASC', version: 'DESC' },
    });
    return entities.map((entity) => NotificationTemplateMapper.toDomain(entity));
  }
}
