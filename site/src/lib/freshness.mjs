/**
 * Pure freshness helpers shared by the status page's server render and its
 * client-side truth refresh. Keeping one calculation prevents the static HTML
 * and browser-enhanced state from drifting apart.
 */

export function freshnessState(stamp, budgetHours, nowMs = Date.now()) {
  const stampMs = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
  const budget = Number(budgetHours);
  if (!Number.isFinite(stampMs) || !(budget > 0) || !Number.isFinite(nowMs)) return 'down';

  const ageHours = Math.max(0, nowMs - stampMs) / 3600e3;
  if (ageHours <= budget) return 'fresh';
  if (ageHours <= budget * 2) return 'stale';
  return 'down';
}

const SOURCE_BUDGET_HOURS = {
  rates: 26,
  'steam-regional': 26,
  'eshop-regional': 26,
  'steam-offers': 8 * 24,
  'xbox-us': 8 * 24,
  'deals-steam': 26,
  'deals-eshop': 26,
  'deals-stores': 26,
  'free-games': 26,
  calendar: 8 * 24,
  // Fleet freshness is the oldest of 14 daily shards, so its healthy age is 15 days.
  meta: 15 * 24,
};

export function sourceBudgetHours(key) {
  if (/^[a-z-]+:extended-\d+$/.test(key)) return 8 * 24;
  if (/^meta:shard-\d+$/.test(key)) return 15 * 24;
  return SOURCE_BUDGET_HOURS[key] ?? 26;
}

export function formatUtcStamp(stamp) {
  const date = typeof stamp === 'string' ? new Date(stamp) : null;
  if (!date || !Number.isFinite(date.getTime())) return 'never';
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
