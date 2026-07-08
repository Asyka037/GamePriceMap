/**
 * Scrape Nintendo eShop regional prices for configured Switch games.
 *
 * Uses Nintendo's public storefront price endpoint. NSUIDs differ by store
 * region group, so each region selects the matching plan.nsuids entry before
 * requesting prices.
 *
 * Usage: node scripts/scrape-eshop-prices.mjs
 *        node scripts/scrape-eshop-prices.mjs zelda-tears-of-the-kingdom
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchRates } from '../lib/fetch-rates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.ESHOP_PRICING_DATA_DIR || path.join(ROOT, 'data', 'eshop-pricing');
const ESHOP_PRICE_API = 'https://api.ec.nintendo.com/v1/price';
const REQUEST_DELAY_MS = 1000;

const HEADERS = {
  'User-Agent': 'OpenTheRankBot/1.0 (+https://opentherank.com)',
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return await res.json();
    } catch (err) {
      const finalAttempt = attempt === 3;
      console.warn(`  ${label}: ${err.message}${finalAttempt ? '' : ', retrying...'}`);
      if (finalAttempt) throw err;
      await sleep(2000 * attempt);
    }
  }
}

function parseUsd(price) {
  if (!price) return Number.POSITIVE_INFINITY;
  const amount = Number.parseFloat(String(price).replace(/[^0-9.]/g, ''));
  return Number.isFinite(amount) ? amount : Number.POSITIVE_INFINITY;
}

function formatUsd(amount) {
  return `$${amount.toFixed(2)}`;
}

function usdFromCurrency(rawValue, currency, rates) {
  const amount = Number.parseFloat(rawValue);
  if (!Number.isFinite(amount)) return null;
  if (currency === 'USD') return amount;
  const rate = rates[currency];
  if (!rate) return null;
  return amount / rate;
}

async function fetchCountryPrices(countryCode, nsuids) {
  const url = new URL(ESHOP_PRICE_API);
  url.searchParams.set('country', countryCode);
  url.searchParams.set('ids', nsuids.join(','));
  url.searchParams.set('lang', 'en');
  return fetchJson(url, `eshop price ${countryCode}`);
}

function buildPrice(entry, rates) {
  if (entry?.sales_status !== 'onsale' || !entry.regular_price) {
    return null;
  }

  const regular = entry.regular_price;
  const discount = entry.discount_price || null;
  const effective = discount || regular;
  const currency = regular.currency;
  const usdAmount = usdFromCurrency(effective.raw_value, currency, rates);
  if (usdAmount === null) {
    console.warn(`  ⚠ no USD exchange rate for ${currency}`);
    return null;
  }

  const price = {
    local: effective.amount,
    usd: formatUsd(usdAmount),
  };

  if (discount) {
    const listUsdAmount = usdFromCurrency(regular.raw_value, currency, rates);
    const regularRaw = Number.parseFloat(regular.raw_value);
    const discountRaw = Number.parseFloat(discount.raw_value);
    price.listLocal = regular.amount;
    if (listUsdAmount !== null) price.listUsd = formatUsd(listUsdAmount);
    if (Number.isFinite(regularRaw) && regularRaw > 0 && Number.isFinite(discountRaw)) {
      price.discountPct = Math.round((1 - discountRaw / regularRaw) * 100);
    }
    if (discount.end_datetime) price.saleEndsAt = discount.end_datetime;
  }

  return { currency, price };
}

function updateRegionPrices(region, plans, priceResponse, rates) {
  const entriesByNsuid = new Map(
    (priceResponse?.prices || []).map((entry) => [String(entry.title_id), entry])
  );
  const nextPrices = { ...(region.prices || {}) };
  const nextCurrency = { ...(region.currency || {}) };

  for (const plan of plans) {
    const nsuid = plan.nsuids?.[region.regionGroup];
    if (!nsuid) {
      console.warn(`  ⚠ ${region.countryCode} ${plan.id}: missing NSUID for ${region.regionGroup}`);
      continue;
    }

    const entry = entriesByNsuid.get(String(nsuid));
    const built = buildPrice(entry, rates);
    if (!built) {
      console.warn(`  ⚠ ${region.countryCode} ${plan.id}: ${entry?.sales_status || 'missing price'}`);
      continue;
    }

    nextPrices[plan.id] = built.price;
    nextCurrency[plan.id] = built.currency;
  }

  region.prices = nextPrices;
  region.currency = nextCurrency;
}

async function updateEshopGame(file, rates) {
  const filePath = path.join(DATA_DIR, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  console.log(`\nUpdating ${data.app.name}`);

  for (const region of data.regions) {
    const nsuids = data.plans
      .map((plan) => plan.nsuids?.[region.regionGroup])
      .filter(Boolean);
    const uniqueNsuids = [...new Set(nsuids)];

    if (uniqueNsuids.length === 0) {
      console.warn(`  ⚠ ${region.countryCode}: no NSUIDs for ${region.regionGroup}`);
      continue;
    }

    const prices = await fetchCountryPrices(region.countryCode, uniqueNsuids);
    updateRegionPrices(region, data.plans, prices, rates);
    const repPrice = region.prices?.[data.app.representativePlan]?.usd || 'n/a';
    console.log(`  ✓ ${region.countryCode} ${repPrice}`);
    await sleep(REQUEST_DELAY_MS);
  }

  const usRegion = data.regions.find((region) => region.countryCode === 'US');
  for (const plan of data.plans) {
    const usPrice = usRegion?.prices?.[plan.id]?.usd;
    if (usPrice) plan.usBenchmark = usPrice;
  }

  data.regions.sort((a, b) => {
    const repPlan = data.app.representativePlan;
    return parseUsd(a.prices?.[repPlan]?.usd) - parseUsd(b.prices?.[repPlan]?.usd);
  });
  data.regions.forEach((region, index) => {
    region.rank = index + 1;
  });

  data.app.lastUpdated = new Date().toISOString();
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);

  const first = data.regions[0];
  const last = data.regions[data.regions.length - 1];
  console.log(`  Ranked ${data.regions.length} regions: ${first.countryCode} → ${last.countryCode}`);
}

async function main() {
  const rates = await fetchRates();
  const requestedFiles = process.argv
    .slice(2)
    .map((file) => (file.endsWith('.json') ? file : `${file}.json`));
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((file) => file.endsWith('.json'))
    .filter((file) => requestedFiles.length === 0 || requestedFiles.includes(file));

  if (requestedFiles.length > 0) {
    const missingFiles = requestedFiles.filter((file) => !files.includes(file));
    if (missingFiles.length > 0) {
      throw new Error(`Unknown eShop pricing file(s): ${missingFiles.join(', ')}`);
    }
  }

  for (const file of files) {
    await updateEshopGame(file, rates);
  }

  console.log(`\nDone: ${files.length} eShop pricing file(s) updated.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
