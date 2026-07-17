/** Nintendo catalog/snapshot invariants shared by the production validator. */
export function isNintendoBaseGameNsuid(value) {
  return /^7001\d{10}$/.test(String(value ?? ''));
}

export function hasNativeUsObservation(snapshot) {
  return Array.isArray(snapshot?.regions)
    && snapshot.regions.some((row) => row?.cc === 'US' && row?.currency === 'USD');
}

/** Minimum first-observation coverage: 80% of regions applicable to this mapping. */
export function minimumApplicableRegionCount(channel, game, { steamRegions = [], eshopRegions = [] } = {}, ratio = 0.8) {
  const applicable = channel === 'steam'
    ? steamRegions.length
    : channel === 'eshop'
      ? eshopRegions.filter(({ group }) => Boolean(game?.nsuids?.[group])).length
      : 0;
  return applicable > 0 ? Math.ceil(applicable * ratio) : 0;
}
