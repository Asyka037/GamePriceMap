/**
 * PlayStation Store US product-page helpers for the PSN POC.
 *
 * The storefront renders a normalized GraphQL cache inside the page's
 * __NEXT_DATA__. A product can expose several CTAs at once: a public purchase,
 * a cheaper PlayStation Plus upsell, a subscription trial, or a free license.
 * The primary row below is deliberately accepted only from an unrestricted,
 * positive-price ADD_TO_CART offer. Membership offers are returned separately
 * as annotations and must never feed current-price ranking or ATL history.
 */
import { normTitle } from './match.mjs';
import { round2 } from './snapshot.mjs';

const STORE_ORIGIN = 'https://store.playstation.com';
const PRODUCT_ID_RE = /^[A-Z]{2}\d{4}-[A-Z0-9_]{12}-[A-Z0-9_]{16}$/;

export function validPsnProductId(value) {
  return PRODUCT_ID_RE.test(String(value ?? ''));
}

export function psnProductUrl(productId, locale = 'en-us') {
  const id = String(productId ?? '').toUpperCase();
  if (!validPsnProductId(id)) throw new Error(`Malformed PSN product id: ${productId}`);
  if (locale !== 'en-us') throw new Error('PSN POC supports the en-us market only');
  return `${STORE_ORIGIN}/${locale}/product/${encodeURIComponent(id)}`;
}

function jsonScript(text, idPattern) {
  const match = String(text ?? '').match(
    new RegExp(`<script\\b(?=[^>]*\\bid=["']${idPattern}["'])(?=[^>]*\\btype=["']application/json["'])[^>]*>([\\s\\S]*?)<\\/script>`, 'i'),
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function extractPsnNextData(html) {
  return jsonScript(html, '__NEXT_DATA__');
}

function envDocuments(nextData) {
  const documents = [];
  for (const batarang of Object.values(nextData?.props?.pageProps?.batarangs ?? {})) {
    const doc = jsonScript(batarang?.text, 'env:[^"\']+');
    if (doc?.cache && typeof doc.cache === 'object') documents.push(doc);
  }
  return documents;
}

function refId(ref) {
  return typeof ref?.__ref === 'string' ? ref.__ref : null;
}

function actionParam(cta, name) {
  const values = (cta?.action?.param ?? []).filter((p) => p?.name === name).map((p) => p?.value);
  return values.length > 0 ? values[0] : null;
}

function hasActionParam(cta, name) {
  return (cta?.action?.param ?? []).some((param) => param?.name === name);
}

function offerEnd(value, now) {
  if (value == null || value === '') return { valid: true, iso: null };
  const epoch = Number(value);
  if (!Number.isFinite(epoch)) return { valid: false, iso: null };
  const date = new Date(epoch);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() >= 2100 || date.getTime() <= now) {
    return { valid: false, iso: null };
  }
  return { valid: true, iso: date.toISOString() };
}

function priceObservation(price, now, { publicOffer }) {
  const amountCents = Number(price?.discountedValue);
  const listCents = Number(price?.basePriceValue);
  if (!Number.isInteger(amountCents) || !Number.isInteger(listCents)) return null;
  if (amountCents <= 0 || listCents <= 0 || amountCents > listCents) return null;
  if (price?.currencyCode !== 'USD' || price?.isFree === true) return null;

  const branding = Array.isArray(price?.serviceBranding) ? price.serviceBranding : [];
  const qualifications = Array.isArray(price?.qualifications) ? price.qualifications : [];
  if (publicOffer) {
    if (price?.applicability !== 'APPLICABLE') return null;
    if (branding.length !== 1 || branding[0] !== 'NONE') return null;
    if (qualifications.length !== 0 || price?.isExclusive !== false || price?.isTiedToSubscription !== false) return null;
  } else {
    const plusSignal = branding.includes('PS_PLUS')
      || qualifications.length > 0
      || price?.applicability === 'UPSELL'
      || price?.isExclusive === true
      || price?.isTiedToSubscription === true;
    if (!plusSignal) return null;
  }

  const discounted = amountCents < listCents;
  const end = offerEnd(price?.endTime, now);
  if (!end.valid) return null;
  return {
    currency: 'USD',
    amount: round2(amountCents / 100),
    list: discounted ? round2(listCents / 100) : null,
    discountPct: discounted ? Math.round((1 - amountCents / listCents) * 100) : null,
    saleEndsAt: discounted ? end.iso : null,
  };
}

function exactFinalProductUrl(finalUrl, productId) {
  // Identity is not proven until the HTTP client reports the terminal URL.
  // PlayStation may redirect a stale/region-blocked product to a storefront
  // landing page that still contains unrelated product fragments.
  if (!finalUrl) return false;
  try {
    const url = new URL(finalUrl);
    const wantedPath = `/en-us/product/${productId}`;
    return url.origin === STORE_ORIGIN
      && decodeURIComponent(url.pathname).replace(/\/$/, '') === wantedPath;
  } catch {
    return false;
  }
}

function classificationIsStandardGame(productViews) {
  const explicitConflict = productViews.some((product) => {
    if (product?.topCategory != null && product.topCategory !== 'GAME') return true;
    if (product?.storeDisplayClassification != null
      && product.storeDisplayClassification !== 'FULL_GAME') return true;
    if (product?.type != null && product.type !== 'GAME') return true;
    if (product?.edition != null
      && product.edition.type !== 'STANDARD'
      && !(product.edition.type == null && product.edition.name === '')) return true;
    return false;
  });
  if (explicitConflict) return false;
  const fullGame = productViews.some((p) => p?.topCategory === 'GAME'
    && p?.storeDisplayClassification === 'FULL_GAME'
    // Some single-edition official pages (for example Balatro and ANIMAL
    // WELL) expose an empty edition name but omit edition.type entirely.
    // Accept only that bounded blank marker; named/unknown editions still
    // require the explicit STANDARD classification.
    && (p?.edition?.type === 'STANDARD'
      || (p?.edition && p.edition.type == null && p.edition.name === '')));
  const gameType = productViews.some((p) => p?.type === 'GAME');
  return fullGame && gameType;
}

function offerIdentity(offer) {
  return JSON.stringify([
    offer.skuId,
    offer.currency,
    offer.amount,
    offer.list,
    offer.discountPct,
    offer.saleEndsAt,
  ]);
}

function offersFromCtaDocument(document, productId, now) {
  const product = document.cache[`Product:${productId}`];
  const skuIds = new Set((product.skus ?? []).map(refId).filter(Boolean).map((ref) => ref.replace(/^Sku:/, '')));
  const ctas = (product.webctas ?? [])
    .map(refId)
    .filter(Boolean)
    .map((ref) => document.cache[ref])
    .filter((cta) => cta?.__typename === 'GameCTA');
  const publicOffers = [];
  const plusOffers = [];
  const excludedTrialIds = new Set();
  for (const cta of ctas) {
    const skuId = actionParam(cta, 'skuId');
    const sku = document.cache[`Sku:${skuId}`];
    if (!skuId || !skuIds.has(skuId) || sku?.__typename !== 'Sku' || sku?.name !== 'Game') continue;
    const isPublicCta = cta.type === 'ADD_TO_CART'
      && cta.action?.type === 'ADD_TO_CART'
      && cta.local?.ctaType === 'purchase'
      && cta.meta?.upSellService === 'NONE'
      && cta.meta?.exclusive === false
      && hasActionParam(cta, 'rewardId')
      && [null, 'OUTRIGHT'].includes(actionParam(cta, 'rewardId'));
    const publicPrice = isPublicCta ? priceObservation(cta.price, now, { publicOffer: true }) : null;
    if (publicPrice) publicOffers.push({ ...publicPrice, skuId });

    // Membership identity comes from the price itself. A storefront experiment
    // may retain a cash-like CTA shell while branding/qualifying its price for
    // PS Plus; that offer stays excluded from the public row but must remain in
    // the audit annotation.
    const plusPrice = priceObservation(cta.price, now, { publicOffer: false });
    if (plusPrice) plusOffers.push({ ...plusPrice, skuId });
    if (/TRIAL/u.test(cta.type ?? '') || cta.price?.isFree === true || Number(cta.price?.discountedValue) === 0) {
      excludedTrialIds.add(String(cta.id ?? `${cta.type}:${skuId}`));
    }
  }
  publicOffers.sort((a, b) => a.amount - b.amount || a.skuId.localeCompare(b.skuId));
  return { product, publicOffers, plusOffers, excludedTrialIds };
}

function psnPlatforms(productViews) {
  return [...new Set(productViews
    .flatMap((product) => Array.isArray(product?.platforms) ? product.platforms : [])
    .filter((platform) => platform === 'PS4' || platform === 'PS5'))]
    .sort()
    .map((platform) => platform.toLowerCase());
}

function exactPsnTitle(candidate, wanted) {
  // Product display names may carry a bounded platform suffix even when the
  // invariant catalog title does not (for example, "Persona 3 Reload PS4 &
  // PS5"). Strip only that terminal storefront decoration; editions and other
  // suffixes remain exact-match failures.
  const c = normTitle(candidate).replace(/(?:ps4(?:and)?ps5|ps5(?:and)?ps4|ps4|ps5)$/u, '');
  const w = normTitle(wanted);
  return Boolean(c && w && c === w);
}

/**
 * Parse one verified standard-edition product mapping from __NEXT_DATA__.
 * Returns null on any identity, classification, structure, or offer drift.
 */
export function parsePsnNextData(nextData, {
  productId,
  expectedTitle,
  edition = 'standard',
  finalUrl = null,
}, now = Date.now()) {
  const id = String(productId ?? '').toUpperCase();
  const pageProps = nextData?.props?.pageProps;
  if (!validPsnProductId(id) || edition !== 'standard') return null;
  if (pageProps?.locale !== 'en-us' || pageProps?.productId !== id) return null;
  if (!exactFinalProductUrl(finalUrl, id)) return null;

  const documents = envDocuments(nextData);
  const productViews = documents
    .flatMap((doc) => Object.values(doc.cache))
    .filter((entity) => entity?.__typename === 'Product' && entity?.id === id);
  const platforms = psnPlatforms(productViews);
  if (productViews.length === 0 || !classificationIsStandardGame(productViews) || platforms.length === 0) return null;

  const names = productViews.flatMap((p) => [p?.name, p?.invariantName]).filter(Boolean);
  if (names.length === 0 || names.some((name) => !exactPsnTitle(name, expectedTitle))) return null;
  if (/\b(bundle|collection|anthology)\b/iu.test(String(expectedTitle))) return null;

  // Several page fragments repeat Product.webctas, but the title fragment does
  // not carry the referenced Sku entities. Bind offers only from a self-contained
  // cache fragment with both CTA and SKU relationships (currently `cta`).
  const ctaDocuments = documents.filter((doc) => {
    const candidate = doc.cache[`Product:${id}`];
    return candidate?.webctas?.length > 0 && candidate?.skus?.length > 0;
  });
  if (ctaDocuments.length === 0) return null;
  const parsedCtaDocuments = ctaDocuments.map((document) => offersFromCtaDocument(document, id, now));
  if (parsedCtaDocuments.some((entry) => entry.publicOffers.length === 0)) return null;
  const selectedOffers = parsedCtaDocuments.map((entry) => entry.publicOffers[0]);
  if (new Set(selectedOffers.map(offerIdentity)).size !== 1) return null;
  const product = parsedCtaDocuments[0].product;
  const plusOffers = [...new Map(parsedCtaDocuments
    .flatMap((entry) => entry.plusOffers)
    .map((offer) => [offerIdentity(offer), offer])).values()];
  plusOffers.sort((a, b) => a.amount - b.amount || a.skuId.localeCompare(b.skuId));
  const selected = selectedOffers[0];
  const conceptRefs = [...new Set(parsedCtaDocuments
    .map((entry) => entry.product.concept?.__ref)
    .filter(Boolean))];
  if (conceptRefs.length > 1) return null;
  const conceptRef = conceptRefs[0] ?? null;
  const excludedTrials = new Set(parsedCtaDocuments
    .flatMap((entry) => [...entry.excludedTrialIds])).size;

  return {
    productId: id,
    // Store fragments occasionally surface short/non-canonical concept refs.
    // Catalog accepts only the stable eight-digit identity; everything else is
    // optional metadata and must be discarded rather than generalized.
    conceptId: /^Concept:\d{8}$/.test(conceptRef ?? '') ? conceptRef.slice('Concept:'.length) : null,
    matchedTitle: product.invariantName ?? product.name,
    edition: 'standard',
    platforms,
    skuId: selected.skuId,
    row: {
      cc: 'US',
      currency: selected.currency,
      amount: selected.amount,
      list: selected.list,
      discountPct: selected.discountPct,
      saleEndsAt: selected.saleEndsAt,
    },
    annotations: {
      psPlus: plusOffers[0] ?? null,
      excludedTrials,
    },
  };
}

export function parsePsnProductPage(html, mapping, now = Date.now()) {
  const nextData = extractPsnNextData(html);
  return nextData ? parsePsnNextData(nextData, mapping, now) : null;
}
