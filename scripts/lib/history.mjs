/**
 * Price history evolution — pure functions, no I/O.
 *
 * History files are event-sourced: one event per observed price CHANGE on
 * the canonical region (US) per channel. Daily reruns with an unchanged
 * price append nothing, so git growth stays proportional to real changes.
 *
 * ATL keys: 'pc' (Steam US), 'eshop-us' (Phase 2). Seeds record provenance
 * so the UI can phrase honesty ("lowest since we started tracking" vs
 * externally seeded all-time low).
 */

export function emptyHistory(slug) {
  return { slug, cheapsharkGameId: null, atl: {}, events: [] };
}

/**
 * Apply one channel snapshot to a history object (pure — returns new object).
 * @param history existing history (or null)
 * @param snapshot §4.2 snapshot with regions[]
 * @param channel 'steam' | 'eshop'
 * @param atlKey  'pc' | 'eshop-us'
 * @param today   'YYYY-MM-DD'
 */
export function applySnapshot(history, snapshot, { channel, atlKey, today }) {
  const h = structuredClone(history ?? emptyHistory(snapshot.slug));
  const us = snapshot.regions.find((r) => r.cc === 'US');
  if (!us) return { history: h, changed: false };

  const last = [...h.events].reverse().find((e) => e.ch === channel && e.cc === 'US');
  const priceChanged = !last || last.usd !== us.usd || (last.pct ?? null) !== (us.discountPct ?? null);
  let changed = false;

  if (priceChanged && !(last && last.d === today && last.usd === us.usd)) {
    h.events.push({ d: today, ch: channel, cc: 'US', usd: us.usd, pct: us.discountPct ?? null });
    changed = true;
  }

  const atl = h.atl[atlKey];
  if (!atl || us.usd < atl.usd) {
    h.atl[atlKey] = { usd: us.usd, date: today, seed: 'self' };
    changed = true;
  }
  return { history: h, changed };
}

/** Merge an external ATL seed, keeping whichever price is lower. */
export function seedAtl(history, atlKey, { price, date, seed }) {
  const h = structuredClone(history);
  const cur = h.atl[atlKey];
  if (!cur || price < cur.usd) {
    h.atl[atlKey] = { usd: price, date, seed };
    return { history: h, changed: true };
  }
  return { history: h, changed: false };
}
