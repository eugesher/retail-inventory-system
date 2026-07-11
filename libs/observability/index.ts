export * from './correlation';
export * from './logger.module';

// `tracer.ts` is a side-effect import only; it is not re-exported here.
// Apps wire it as `import '@retail-inventory-system/observability/tracer';`
// (deep import) at the very top of `main.ts`.
