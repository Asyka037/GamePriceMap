import { MIN_STEAM_IMPORT_REGION_COUNT } from './import-limits.mjs';

/** Nintendo catalog/snapshot invariants shared by the production validator. */
export function isNintendoBaseGameNsuid(value) {
  return /^7001\d{10}$/.test(String(value ?? ''));
}

export function hasNativeUsObservation(snapshot) {
  return Array.isArray(snapshot?.regions)
    && snapshot.regions.some((row) => row?.cc === 'US' && row?.currency === 'USD');
}

/**
 * Minimum first-observation coverage.
 * Steam uses the user-approved absolute 10-region floor; Nintendo retains the
 * existing 80% rule over only the regional groups mapped by that game.
 */
export function minimumApplicableRegionCount(channel, game, { steamRegions = [], eshopRegions = [] } = {}, ratio = 0.8) {
  const applicable = channel === 'steam'
    ? steamRegions.length
    : channel === 'eshop'
      ? eshopRegions.filter(({ group }) => Boolean(game?.nsuids?.[group])).length
      : 0;
  if (applicable === 0) return 0;
  if (channel === 'steam') return Math.min(MIN_STEAM_IMPORT_REGION_COUNT, applicable);
  return Math.ceil(applicable * ratio);
}
