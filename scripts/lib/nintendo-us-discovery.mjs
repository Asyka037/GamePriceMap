/**
 * Nintendo US product-page discovery guards.
 *
 * This module is deliberately pure: it parses only the requested page's
 * current-product evidence and advances an in-memory daily-budget ledger.
 * Network I/O, pacing and atomic persistence stay in discover-nsuid.mjs.
 */
import { normTitle } from './match.mjs';
import { switchGenerations } from './nsuid-discovery.mjs';

export const NINTENDO_US_PRODUCT_DAILY_LIMIT = 100;
export const NINTENDO_US_PRODUCT_MIN_INTERVAL_MS = 1500;
export const NINTENDO_US_BUDGET_SCHEMA_VERSION = 1;

// Explicitly authorized in docs/plans/2026-07-18-multiplatform-rollout.md.
// This browser UA exception is passed only to Nintendo US product pages.
export const NINTENDO_US_BROWSER_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
});

const BASE_GAME_NSUID_RE = /^7001\d{10}$/u;
const PRODUCT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function result(status, reason, extra = {}) {
  return { status, reason, ...extra };
}

function exactTitleMatches(candidate, wanted) {
  const normalizedCandidate = normTitle(candidate);
  const normalizedWanted = normTitle(wanted);
  return Boolean(normalizedCandidate && normalizedWanted && normalizedCandidate === normalizedWanted);
}

function scriptJson(html, predicate) {
  const documents = [];
  for (const match of String(html ?? '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
    const attrs = match[1];
    const attr = (name) => {
      const found = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'iu'));
      return found?.[1] ?? found?.[2] ?? null;
    };
    if (!predicate({ id: attr('id'), type: attr('type') })) continue;
    try {
      documents.push(JSON.parse(match[2]));
    } catch {
      return { documents: [], malformed: true };
    }
  }
  return { documents, malformed: false };
}

function productPath(url) {
  try {
    const parsed = new URL(url, 'https://www.nintendo.com');
    if (parsed.protocol !== 'https:' || !['nintendo.com', 'www.nintendo.com'].includes(parsed.hostname)) return null;
    return parsed.pathname.replace(/\/+$/u, '');
  } catch {
    return null;
  }
}

function requestedProductIdentity(requestedUrl) {
  try {
    const parsed = new URL(requestedUrl);
    if (parsed.protocol !== 'https:' || !['nintendo.com', 'www.nintendo.com'].includes(parsed.hostname)) return null;
    const path = parsed.pathname.replace(/\/+$/u, '');
    const matched = path.match(/^\/us\/store\/products\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u);
    return matched ? { productSlug: matched[1], path } : null;
  } catch {
    return null;
  }
}

function generationsFromPlatformValues(values) {
  const generations = new Set();
  for (const raw of values.flat(Infinity).filter(Boolean)) {
    const value = String(raw).toUpperCase();
    if (value.includes('NINTENDO_SWITCH_2') || value.includes('SWITCH 2') || value.includes('/SWITCH2/')) {
      generations.add('BEE');
    } else if (value.includes('NINTENDO_SWITCH') || value.includes('SWITCH') || value.includes('/SWITCH/')) {
      generations.add('HAC');
    }
  }
  return generations.size === 1 ? [...generations][0] : null;
}

function jsonLdProducts(value) {
  if (Array.isArray(value)) return value.flatMap(jsonLdProducts);
  if (!value || typeof value !== 'object') return [];
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  const own = types.some((type) => ['Product', 'VideoGame', 'SoftwareApplication'].includes(type)) ? [value] : [];
  return own.concat(jsonLdProducts(value['@graph']));
}

function baseNsuidsFrom(value) {
  const serialized = JSON.stringify(value);
  return [...new Set([...serialized.matchAll(/(?:switch2?|switch)\/(7001\d{10})(?:\/|["?])/giu)]
    .map((match) => match[1]))];
}

function nextDataEvidence(html, { productSlug, title }) {
  const parsed = scriptJson(html, ({ id }) => id === '__NEXT_DATA__');
  if (parsed.malformed) return result('exception', 'next_data_malformed');
  if (parsed.documents.length === 0) return result('absent', 'next_data_absent');
  if (parsed.documents.length !== 1) return result('exception', 'multiple_next_data_documents');

  const data = parsed.documents[0];
  if (data?.query?.slug !== productSlug) return result('exception', 'next_data_product_slug_mismatch');
  const pageProps = data?.props?.pageProps;
  const analytics = pageProps?.analytics?.product;
  if (!analytics || !exactTitleMatches(analytics.name, title)) {
    return result('exception', 'next_data_title_mismatch');
  }
  const nsuid = String(analytics.nsuid ?? '');
  if (!BASE_GAME_NSUID_RE.test(nsuid)) return result('exception', 'next_data_not_base_game');
  if (!(typeof analytics.sku === 'string' && analytics.sku)) return result('exception', 'next_data_sku_missing');

  const product = pageProps?.initialApolloState?.[`Product:{"sku":"${analytics.sku}"}`];
  if (!product) return result('exception', 'next_data_product_state_missing');
  if (product.urlKey !== productSlug
    || productPath(product['url({"relative":true})']) !== `/us/store/products/${productSlug}`) {
    return result('exception', 'next_data_product_url_mismatch');
  }
  if (!exactTitleMatches(product.name, title) || String(product.nsuid ?? '') !== nsuid) {
    return result('exception', 'next_data_product_identity_conflict');
  }
  if (product.isUpgrade === true) return result('exception', 'next_data_upgrade_product');
  if (product.edition != null && product.edition !== 'Standard Edition') {
    return result('exception', 'next_data_nonstandard_edition');
  }
  if (product.topLevelCategory?.code != null && product.topLevelCategory.code !== 'GAMES') {
    return result('exception', 'next_data_not_game_category');
  }
  const generation = generationsFromPlatformValues([
    product.platform?.code,
    product.platform?.label,
    ...(product.platforms ?? []).flatMap((platform) => [platform?.code, platform?.label]),
  ]);
  if (!generation) return result('exception', 'next_data_generation_missing_or_conflicting');

  return result('matched', null, {
    evidence: {
      source: 'next_data_analytics_product',
      nsuid,
      matchedTitle: analytics.name,
      generation,
      releaseDate: product.releaseDate ?? null,
    },
  });
}

function jsonLdEvidence(html, { expectedPath, title }) {
  const parsed = scriptJson(html, ({ type }) => type?.toLowerCase() === 'application/ld+json');
  if (parsed.malformed) return result('exception', 'json_ld_malformed');
  const currentProducts = parsed.documents
    .flatMap(jsonLdProducts)
    .filter((product) => productPath(product.offers?.url ?? product.url) === expectedPath);
  if (currentProducts.length === 0) return result('absent', 'json_ld_current_product_absent');
  if (currentProducts.some((product) => !exactTitleMatches(product.name, title))) {
    return result('exception', 'json_ld_current_product_title_mismatch');
  }

  const identities = new Map();
  for (const product of currentProducts) {
    const ids = baseNsuidsFrom(product);
    const generation = generationsFromPlatformValues([
      product.gamePlatform,
      product.operatingSystem,
      product.image,
      product.contentUrl,
      product.downloadUrl,
    ]);
    if (ids.length !== 1 || !generation) continue;
    identities.set(`${ids[0]}:${generation}`, {
      source: 'json_ld_title_and_url',
      nsuid: ids[0],
      matchedTitle: product.name,
      generation,
      releaseDate: product.datePublished ?? product.releaseDate ?? null,
    });
  }
  if (identities.size === 0) return result('exception', 'json_ld_identity_or_generation_missing');
  if (identities.size !== 1) return result('exception', 'json_ld_current_product_conflict');
  return result('matched', null, { evidence: [...identities.values()][0] });
}

/**
 * Bind one response to exactly the requested Nintendo US product page.
 * Any disagreement between two current-page evidence sources is terminal.
 */
export function evaluateNintendoUsProductPage({ text, requestedUrl, finalUrl }, {
  title,
  platforms,
  now = new Date(),
} = {}) {
  const requested = requestedProductIdentity(requestedUrl);
  if (!requested) return result('exception', 'requested_product_url_invalid');
  if (productPath(finalUrl) !== requested.path) return result('none', 'final_product_path_mismatch');
  const allowedGenerations = switchGenerations(platforms);
  if (allowedGenerations.size === 0) return result('exception', 'missing_switch_generation');

  const next = nextDataEvidence(text, { productSlug: requested.productSlug, title });
  const jsonLd = jsonLdEvidence(text, { expectedPath: requested.path, title });
  if (next.status === 'exception') return next;
  if (jsonLd.status === 'exception') return jsonLd;

  const evidence = [next, jsonLd].filter((entry) => entry.status === 'matched').map((entry) => entry.evidence);
  if (evidence.length === 0) return result('none', 'current_product_identity_missing');
  if (evidence.length === 2
    && (evidence[0].nsuid !== evidence[1].nsuid || evidence[0].generation !== evidence[1].generation)) {
    return result('exception', 'current_product_evidence_conflict');
  }
  const selected = evidence[0];
  if (!allowedGenerations.has(selected.generation)) return result('none', 'generation_mismatch');

  const releaseMs = Date.parse(selected.releaseDate ?? '');
  const nowMs = now instanceof Date ? now.valueOf() : Number(now);
  if (!Number.isFinite(releaseMs)) return result('exception', 'release_date_missing_or_invalid');
  if (!Number.isFinite(nowMs)) return result('exception', 'current_time_invalid');
  if (releaseMs > nowMs) return result('none', 'not_released');

  return result('matched', null, {
    candidate: {
      ...selected,
      productSlug: requested.productSlug,
      sourceUrl: requestedUrl,
      finalUrl,
      releasedAt: new Date(releaseMs).toISOString(),
    },
  });
}

/** Read only canonical Nintendo US product URLs from the official store sitemap. */
export function parseNintendoUsStoreSitemap(xml) {
  const urls = new Map();
  for (const match of String(xml ?? '').matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/giu)) {
    let url;
    try {
      url = new URL(match[1].replaceAll('&amp;', '&'));
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || !['nintendo.com', 'www.nintendo.com'].includes(url.hostname)) continue;
    const path = url.pathname.replace(/\/+$/u, '');
    const product = path.match(/^\/us\/store\/products\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u);
    if (!product) continue;
    urls.set(product[1], `https://www.nintendo.com${path}/`);
  }
  return urls;
}

/**
 * Locate product pages from Nintendo's official sitemap; never probe a guessed
 * URL. A retained/manual/map hint is accepted only when the sitemap contains
 * it. Otherwise the catalog slug must map exactly to a platform suffix.
 */
export function nintendoUsProductPageCandidates(candidate, sitemap) {
  if (!(sitemap instanceof Map)) throw new TypeError('Nintendo US sitemap index must be a Map');
  const explicit = candidate?.nintendoUsSlugHint ?? candidate?.manualUsEvidence?.productSlug ?? null;
  if (explicit != null) {
    if (!PRODUCT_SLUG_RE.test(explicit)) return [];
    const url = sitemap.get(explicit);
    return url ? [{ productSlug: explicit, url, locatedBy: 'audited_hint' }] : [];
  }

  const slug = String(candidate?.slug ?? '');
  if (!PRODUCT_SLUG_RE.test(slug)) return [];
  const platforms = new Set(candidate?.platforms ?? []);
  const slugs = [];
  if (platforms.has('switch-2')) slugs.push(`${slug}-switch-2`);
  if (platforms.has('switch')) slugs.push(`${slug}-switch`);
  // A small number of base products use no platform suffix; this remains an
  // exact sitemap key match, not a speculative product request.
  slugs.push(slug);
  return [...new Set(slugs)]
    .filter((productSlug) => sitemap.has(productSlug))
    .map((productSlug) => ({
      productSlug,
      url: sitemap.get(productSlug),
      locatedBy: 'official_sitemap_exact_slug',
    }));
}

function validateBudgetLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) throw new Error('Nintendo US budget ledger must be an object');
  if (ledger.schemaVersion !== NINTENDO_US_BUDGET_SCHEMA_VERSION) throw new Error('Nintendo US budget ledger schema is unsupported');
  if (!ledger.days || typeof ledger.days !== 'object' || Array.isArray(ledger.days)) throw new Error('Nintendo US budget ledger days are invalid');
  for (const [day, entry] of Object.entries(ledger.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)
      || !Number.isSafeInteger(entry?.productPageRequests)
      || entry.productPageRequests < 0
      || !Number.isFinite(Date.parse(entry?.lastRequestedAt ?? ''))) {
      throw new Error(`Nintendo US budget ledger entry is invalid: ${day}`);
    }
  }
  return ledger;
}

export function createNintendoUsBudgetLedger() {
  return { schemaVersion: NINTENDO_US_BUDGET_SCHEMA_VERSION, days: {} };
}

/**
 * Reserve before the network call, so crashes and failed responses still
 * consume the product-page allowance. Dates use UTC to remain deterministic.
 */
export function consumeNintendoUsProductPageBudget(ledger, {
  now = new Date(),
  dailyLimit = NINTENDO_US_PRODUCT_DAILY_LIMIT,
} = {}) {
  validateBudgetLedger(ledger);
  if (!(Number.isSafeInteger(dailyLimit) && dailyLimit > 0 && dailyLimit <= NINTENDO_US_PRODUCT_DAILY_LIMIT)) {
    throw new TypeError(`Nintendo US daily limit must be 1-${NINTENDO_US_PRODUCT_DAILY_LIMIT}`);
  }
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.valueOf())) throw new TypeError('Nintendo US budget time is invalid');
  const latestReservationMs = Math.max(
    Number.NEGATIVE_INFINITY,
    ...Object.values(ledger.days).map((entry) => Date.parse(entry.lastRequestedAt)),
  );
  const scheduledMs = Math.max(
    current.valueOf(),
    Number.isFinite(latestReservationMs)
      ? latestReservationMs + NINTENDO_US_PRODUCT_MIN_INTERVAL_MS
      : current.valueOf(),
  );
  const scheduledAt = new Date(scheduledMs).toISOString();
  const day = scheduledAt.slice(0, 10);
  const count = ledger.days[day]?.productPageRequests ?? 0;
  if (count >= dailyLimit) {
    const error = new Error(`Nintendo US product-page daily budget exhausted (${dailyLimit}) for ${day}`);
    error.code = 'nintendo_us_daily_budget_exhausted';
    error.budget = true;
    throw error;
  }
  const cutoff = current.valueOf() - 31 * 86_400_000;
  const days = Object.fromEntries(Object.entries(ledger.days)
    .filter(([key]) => Date.parse(`${key}T00:00:00.000Z`) >= cutoff));
  days[day] = {
    productPageRequests: count + 1,
    // This is the reserved request time. Reserving it under the ledger lock
    // serializes concurrent processes without holding the lock while sleeping.
    lastRequestedAt: scheduledAt,
  };
  return {
    ledger: { schemaVersion: NINTENDO_US_BUDGET_SCHEMA_VERSION, days },
    day,
    used: count + 1,
    remaining: dailyLimit - count - 1,
    scheduledAt,
    waitMs: scheduledMs - current.valueOf(),
  };
}
