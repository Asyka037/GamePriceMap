/**
 * Scrape Steam regional prices for configured Steam games.
 *
 * Uses the public Steam Storefront API. Prices are returned as integer minor
 * units scaled by 100 across currencies, including zero-decimal currencies.
 *
 * Usage: node scripts/scrape-steam-prices.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchRates } from '../lib/fetch-rates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.STEAM_PRICING_DATA_DIR || path.join(ROOT, 'data', 'steam-pricing');
const STEAM_STORE_API = 'https://store.steampowered.com/api/appdetails';
const STEAM_REVIEWS_API = 'https://store.steampowered.com/appreviews';
const STEAM_PLAYERS_API = 'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/';
const REQUEST_DELAY_MS = 1200;

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

function toAmount(minorUnits) {
  return typeof minorUnits === 'number' ? minorUnits / 100 : null;
}

function formatUsd(amount) {
  return `$${amount.toFixed(2)}`;
}

function formatLocal(currency, amount) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function sanitizeFormattedPrice(formatted, currency, amount) {
  const fallback = formatLocal(currency, amount);
  if (!formatted || typeof formatted !== 'string') return fallback;
  return formatted.replace(/\s+USD$/i, '').trim();
}

async function imageExists(url) {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    return res.ok && (res.headers.get('content-type') || '').startsWith('image/');
  } catch {
    return false;
  }
}

async function selectCoverImage(primaryAppId, primaryDetails, existingCoverImage) {
  const inferredLibraryImage = `https://cdn.cloudflare.steamstatic.com/steam/apps/${primaryAppId}/library_600x900.jpg`;
  const candidates = [
    existingCoverImage,
    inferredLibraryImage,
    primaryDetails?.header_image,
    primaryDetails?.capsule_image,
    primaryDetails?.capsule_imagev5,
  ].filter(Boolean);
  const uniqueCandidates = [...new Set(candidates)];

  for (const url of uniqueCandidates) {
    if (await imageExists(url)) return url;
  }

  return primaryDetails?.header_image
    || primaryDetails?.capsule_image
    || primaryDetails?.capsule_imagev5
    || inferredLibraryImage;
}

function parseUsd(price) {
  if (!price) return Number.POSITIVE_INFINITY;
  const amount = Number.parseFloat(String(price).replace(/[^0-9.]/g, ''));
  return Number.isFinite(amount) ? amount : Number.POSITIVE_INFINITY;
}

function usdFromCurrency(amount, currency, rates) {
  if (currency === 'USD') return amount;
  const rate = rates[currency];
  if (!rate) {
    throw new Error(`No USD exchange rate for ${currency}`);
  }
  return amount / rate;
}

async function fetchAppDetails(appIds, countryCode) {
  const url = new URL(STEAM_STORE_API);
  url.searchParams.set('appids', appIds.join(','));
  url.searchParams.set('cc', countryCode.toLowerCase());
  url.searchParams.set('l', 'english');
  url.searchParams.set('filters', 'price_overview');
  return fetchJson(url, `appdetails ${countryCode}`);
}

async function fetchGameMetadata(appId) {
  const url = new URL(STEAM_STORE_API);
  url.searchParams.set('appids', String(appId));
  url.searchParams.set('cc', 'us');
  url.searchParams.set('l', 'english');
  const data = await fetchJson(url, `metadata ${appId}`);
  return data?.[String(appId)]?.data || null;
}

async function fetchReviewSummary(appId) {
  const url = new URL(`${STEAM_REVIEWS_API}/${appId}`);
  url.searchParams.set('json', '1');
  url.searchParams.set('language', 'all');
  url.searchParams.set('purchase_type', 'all');
  url.searchParams.set('num_per_page', '0');
  const data = await fetchJson(url, `reviews ${appId}`);
  return data?.query_summary || null;
}

async function fetchPlayerCount(appId) {
  const url = new URL(STEAM_PLAYERS_API);
  url.searchParams.set('appid', String(appId));
  const data = await fetchJson(url, `players ${appId}`);
  return data?.response?.player_count ?? null;
}

function buildPrice(priceOverview, rates) {
  if (!priceOverview?.currency || typeof priceOverview.final !== 'number') {
    return null;
  }

  const currency = priceOverview.currency;
  const localAmount = toAmount(priceOverview.final);
  const listLocalAmount = toAmount(priceOverview.initial);
  const usdAmount = usdFromCurrency(localAmount, currency, rates);

  const price = {
    local: sanitizeFormattedPrice(priceOverview.final_formatted, currency, localAmount),
    usd: formatUsd(usdAmount),
  };

  if (
    typeof priceOverview.discount_percent === 'number' &&
    priceOverview.discount_percent > 0 &&
    typeof priceOverview.initial === 'number' &&
    priceOverview.initial !== priceOverview.final
  ) {
    price.listLocal = sanitizeFormattedPrice(priceOverview.initial_formatted, currency, listLocalAmount);
    price.listUsd = formatUsd(usdFromCurrency(listLocalAmount, currency, rates));
    price.discountPct = priceOverview.discount_percent;
  }

  return { currency, price };
}

function updateRegionPrices(region, plans, appDetails, rates) {
  const nextPrices = { ...(region.prices || {}) };
  const nextCurrency = { ...(region.currency || {}) };

  for (const plan of plans) {
    const detail = appDetails?.[String(plan.steamAppId)];
    if (!detail?.success) {
      console.warn(`  ⚠ ${region.countryCode} ${plan.id}: appdetails success=false`);
      continue;
    }

    const built = buildPrice(detail.data?.price_overview, rates);
    if (!built) {
      console.warn(`  ⚠ ${region.countryCode} ${plan.id}: missing price_overview`);
      continue;
    }

    nextPrices[plan.id] = built.price;
    nextCurrency[plan.id] = built.currency;
  }

  region.prices = nextPrices;
  region.currency = nextCurrency;
}

async function updateSteamGame(file, rates) {
  const filePath = path.join(DATA_DIR, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const appIds = data.plans.map((plan) => plan.steamAppId);
  const primaryAppId = data.app.steamAppId;

  console.log(`\nUpdating ${data.app.name} (${appIds.join(', ')})`);

  for (const region of data.regions) {
    const details = await fetchAppDetails(appIds, region.countryCode);
    updateRegionPrices(region, data.plans, details, rates);
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

  const [primaryDetails, reviews, playerCount] = await Promise.all([
    fetchGameMetadata(primaryAppId),
    fetchReviewSummary(primaryAppId),
    fetchPlayerCount(primaryAppId),
  ]);

  const totalReviews = reviews?.total_reviews ?? null;
  const reviewPercent = totalReviews
    ? Number(((reviews.total_positive / totalReviews) * 100).toFixed(1))
    : null;
  const inferredLibraryImage = `https://cdn.cloudflare.steamstatic.com/steam/apps/${primaryAppId}/library_600x900.jpg`;
  const coverImage = await selectCoverImage(primaryAppId, primaryDetails, data.app.metadata?.coverImage);

  data.app.metadata = {
    ...(data.app.metadata || {}),
    reviewSummary: reviews?.review_score_desc ?? null,
    reviewPercent,
    reviewCount: totalReviews,
    playerCount,
    metacritic: primaryDetails?.metacritic?.score ?? null,
    headerImage: primaryDetails?.header_image ?? null,
    capsuleImage: primaryDetails?.capsule_image ?? null,
    capsuleImageV5: primaryDetails?.capsule_imagev5 ?? null,
    coverImage,
    libraryImage: inferredLibraryImage,
    recommendations: primaryDetails?.recommendations?.total ?? null,
  };
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
      throw new Error(`Unknown Steam pricing file(s): ${missingFiles.join(', ')}`);
    }
  }

  for (const file of files) {
    await updateSteamGame(file, rates);
  }

  console.log(`\nDone: ${files.length} Steam pricing file(s) updated.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
