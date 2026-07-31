/**
 * User-approved bulk admission limits (2026-07-31).
 *
 * These are operational safeguards, not storefront or static-site limits.
 * Keep them centralized so the CLI, immutable plan validator, private state
 * projection and admission ledger cannot drift apart.
 */
export const MAX_IMPORT_BATCH_ITEMS = 1_000;
export const MAX_DAILY_ADMISSION_ITEMS = 1_000;
export const MIN_STEAM_IMPORT_REGION_COUNT = 10;
