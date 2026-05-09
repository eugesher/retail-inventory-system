// Framework-free utilities — slimmed in task-03.
export * from './exceptions';
export * from './pagination';
export * from './result';
export * from './types';

// One-release shims — moved to libs/{cache,messaging,observability} in task-04.
// Removed in task-14.
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
