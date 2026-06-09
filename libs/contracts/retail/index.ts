// The legacy order DTOs / events / interfaces / enums have been removed with the
// old retail order model. This package is intentionally empty until the rebuilt
// cart / order / payment / address contracts repopulate it. The placeholder
// keeps the module importable (a bare re-export barrel with no exports trips a
// TypeScript "module has no exports" error) and is dropped when real exports
// return.
export {};
