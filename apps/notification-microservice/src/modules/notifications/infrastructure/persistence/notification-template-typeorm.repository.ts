import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

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

@Injectable()
export class NotificationTemplateTypeormRepository implements INotificationTemplateRepositoryPort {
  constructor(
    @InjectRepository(NotificationTemplateEntity)
    private readonly templateRepository: Repository<NotificationTemplateEntity>,
  ) {}

  public async save(template: NotificationTemplate): Promise<NotificationTemplate> {
    let saved: NotificationTemplateEntity;
    try {
      saved = await this.templateRepository.save(NotificationTemplateMapper.toEntity(template));
    } catch (error) {
      if (isDuplicateEntryError(error)) {
        throw new NotificationDomainException(
          NotificationErrorCodeEnum.TEMPLATE_DUPLICATE_VERSION,
          `A notification template for (${template.eventType}, ${template.channel}, ${template.locale}) at version ${template.version} already exists`,
        );
      }
      throw error;
    }
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
