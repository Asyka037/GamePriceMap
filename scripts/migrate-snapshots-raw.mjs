/**
 * One-off migration (data-v2.1, 2026-07-11): strip derived fields
 * (usd/listUsd/rank/updatedAt) from persisted snapshots, sort regions by cc.
 * lastPriceChangeAt initialised from the old updatedAt. Idempotent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let migrated = 0;
for (const dir of ['data/snapshots/steam', 'data/snapshots/eshop']) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.json'))) {
    const p = path.join(abs, f);
    const old = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!('updatedAt' in old) && !old.regions?.some((r) => 'usd' in r)) continue; // already raw
    const regions = (old.regions ?? []).map((r) => ({
      cc: r.cc,
      currency: r.currency,
      amount: r.amount,
      list: r.list ?? null,
      discountPct: r.discountPct ?? null,
      saleEndsAt: r.saleEndsAt ?? null,
    })).sort((a, b) => a.cc.localeCompare(b.cc));
    const raw = { slug: old.slug, lastPriceChangeAt: (old.updatedAt ?? '').slice(0, 10) || null, regions };
    fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} snapshots to raw schema`);
