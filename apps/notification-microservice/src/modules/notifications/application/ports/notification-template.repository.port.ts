import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

import { NotificationTemplate } from '../../domain';

export const NOTIFICATION_TEMPLATE_REPOSITORY = Symbol('NOTIFICATION_TEMPLATE_REPOSITORY');

// Filter for the registry list read. Every field is optional — an absent field widens
// the scan (no filter ⇒ every template, every version). `activeOnly` narrows to the
// soft-delete-live rows.
export interface INotificationTemplateListFilter {
  eventType?: string;
  channel?: NotificationChannelEnum;
  locale?: string;
  activeOnly?: boolean;
}

// The repository seam for the `NotificationTemplate` versioned registry. Returns domain
// types only — no TypeORM entity, `Repository`, or `EntityManager` leaks here (ADR-017
// forbids `typeorm` in `application/ports`); the TypeORM details live entirely in
// `NotificationTemplateTypeormRepository`.
//
// The contract the Author / Activate / List / (render-time) resolve operations depend
// on:
// - `save` upserts one template row and re-reads it so the generated BIGINT id + the
//   committed timestamps come back concrete (the "re-read the saved graph" idiom). An
//   **edit** is a `save` of a fresh `withNextVersion(...)` row, not an in-place update —
//   the prior version stays.
// - `findById` is the by-id load path (the Activate/Deactivate operations resolve a
//   template by id).
// - `findLatestActive` is the **hot path**: the highest-`version` `active` row for the
//   `(eventType, channel, locale)` key — what the render & dispatch use case resolves on
//   every outgoing notification. A null means no live template (the caller falls back).
// - `findByNaturalKey` resolves the exact `(eventType, channel, locale, version)` row —
//   the duplicate-version pre-check / a rollback that re-activates a specific version.
// - `maxVersion` returns the highest `version` across ALL rows for the key (active or
//   not), or null when the key has no rows — the Author use case derives the next
//   version from it (`(maxVersion ?? 0) + 1`).
// - `list` is the registry browse, filtered + unpaginated (the registry is small).
export interface INotificationTemplateRepositoryPort {
  save(template: NotificationTemplate): Promise<NotificationTemplate>;
  findById(id: number): Promise<NotificationTemplate | null>;
  findLatestActive(
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
  ): Promise<NotificationTemplate | null>;
  findByNaturalKey(
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
    version: number,
  ): Promise<NotificationTemplate | null>;
  maxVersion(
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
  ): Promise<number | null>;
  list(filter: INotificationTemplateListFilter): Promise<NotificationTemplate[]>;
}
