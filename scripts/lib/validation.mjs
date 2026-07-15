/** Nintendo catalog/snapshot invariants shared by the production validator. */
export function isNintendoBaseGameNsuid(value) {
  return /^7001\d{10}$/.test(String(value ?? ''));
}

export function hasNativeUsObservation(snapshot) {
  return Array.isArray(snapshot?.regions)
    && snapshot.regions.some((row) => row?.cc === 'US' && row?.currency === 'USD');
}
