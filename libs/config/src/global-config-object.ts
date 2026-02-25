export const globalConfigObject = {
  ['database-logging']: process.env.DATABASE_LOGGING
    ? process.env.DATABASE_LOGGING === 'true'
    : process.env.NODE_ENV !== 'production',
};
