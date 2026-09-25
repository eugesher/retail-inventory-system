export const CURRENCY_CODE_PATTERN = '^[A-Z]{3}$';
export const CURRENCY_CODE_REGEX = new RegExp(CURRENCY_CODE_PATTERN);

export const TAX_CATEGORY_CODE_PATTERN = '^[A-Z][A-Z0-9_]*$';
export const TAX_CATEGORY_CODE_REGEX = new RegExp(TAX_CATEGORY_CODE_PATTERN);

export const SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
export const SLUG_REGEX = new RegExp(SLUG_PATTERN);

export function parseBooleanQuery(value: unknown): boolean | string | undefined {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : undefined;
}
