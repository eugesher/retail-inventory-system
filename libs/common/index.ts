// Framework-free utilities — slimmed in task-03.
export * from './exceptions';
export * from './pagination';
export * from './result';
export * from './types';

// Deferred to task-04 (libs/cache, libs/messaging, libs/observability).
export * from './cache';
export * from './correlation';
export * from './modules';

// One-release shim: re-export symbols that were moved to libs/contracts in
// task-03 so existing import sites of `@retail-inventory-system/common`
// keep compiling. Removed in task-14.
export {
  AppNameEnum,
  IOrderProductConfirm,
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
  MicroserviceQueueEnum,
} from '@retail-inventory-system/contracts';
