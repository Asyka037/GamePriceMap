/** Pure parser for one reviewed Nintendo US base-game product page. */
import { titleMatches } from './match.mjs';
import { isNintendoBaseGameNsuid } from './validation.mjs';

function nextData(html) {
  const match = String(html ?? '').match(
    /<script\s+id=["']__NEXT_DATA__["']\s+type=["']application\/json["']>([\s\S]*?)<\/script>/i,
  );
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function productFromState(pageProps, sku) {
  return pageProps?.initialApolloState?.[`Product:{"sku":"${sku}"}`] ?? null;
}

function platformMatches(product, platforms) {
  const expected = new Set((platforms ?? []).flatMap((platform) => {
    if (platform === 'switch') return ['NINTENDO_SWITCH'];
    if (platform === 'switch-2') return ['NINTENDO_SWITCH_2'];
    return [];
  }));
  const actual = new Set([
    product?.platform?.code,
    ...(product?.platforms ?? []).map((platform) => platform?.code),
  ].filter(Boolean));
  return expected.size > 0 && [...actual].some((code) => expected.has(code));
}

function safeGenres(product) {
  return [...new Set((product?.tags?.genres ?? [])
    .map((genre) => String(genre?.label ?? '').trim())
    .filter(Boolean))];
}

/**
 * Fail closed unless the current page, catalog title, reviewed URL key,
 * Nintendo generation and Americas base-game NSUID all describe one product.
 */
export function parseNintendoMeta(html, {
  slug,
  title,
  nsuid,
  platforms,
  productSlug,
  now = new Date(),
} = {}) {
  const data = nextData(html);
  const pageProps = data?.props?.pageProps;
  const analytics = pageProps?.analytics?.product;
  if (!pageProps || data?.query?.slug !== productSlug) return null;
  if (!titleMatches(analytics?.name, title)) return null;
  if (String(analytics?.nsuid ?? '') !== String(nsuid ?? '')) return null;
  if (!isNintendoBaseGameNsuid(String(nsuid ?? ''))) return null;

  const product = productFromState(pageProps, analytics?.sku);
  if (!product || product.urlKey !== productSlug) return null;
  if (!titleMatches(product.name, title) || String(product.nsuid) !== String(nsuid)) return null;
  if (product.isUpgrade === true || !platformMatches(product, platforms)) return null;
  if (product.edition && product.edition !== 'Standard Edition') return null;
  if (product.topLevelCategory?.code && product.topLevelCategory.code !== 'GAMES') return null;

  const storePath = product['url({"relative":true})'];
  if (storePath !== `/us/store/products/${productSlug}/`) return null;
  const headerImage = product.productImage?.url ?? pageProps.openGraph?.image ?? null;
  if (!/^https:\/\/assets\.nintendo\.com\//.test(headerImage ?? '')) return null;
  const releaseDate = product.releaseDate ?? null;
  const releaseMs = Date.parse(releaseDate);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  return {
    slug,
    updatedAt: new Date(nowMs).toISOString(),
    name: product.name ?? title,
    headerImage,
    genres: safeGenres(product),
    releaseDate,
    comingSoon: Number.isFinite(releaseMs) ? releaseMs > nowMs : false,
    metacritic: null,
    recommendations: null,
    reviewDesc: null,
    reviewCount: 0,
    reviewPercent: null,
    description: product.description ?? null,
    publisher: product.softwarePublisher ?? null,
    developer: product.softwareDeveloper ?? null,
    storeUrl: `https://www.nintendo.com${storePath}`,
    metaSource: 'nintendo-us',
  };
}

// --- EU Solr metadata (scheduled path since 2026-07-17) -----------------------
//
// Nintendo US Terms of Use prohibit automated access to US store pages, so the
// scheduled NS-only metadata refresh reads the public Nintendo-Europe Solr
// index instead (already the discovery/EU-seed source in this repo). US pages
// are only ever opened by a human during one-time candidate review.

export function euSolrMetaUrl(euNsuid) {
  const q = new URLSearchParams({
    q: '*',
    fq: `type:GAME AND nsuid_txt:${euNsuid}`,
    rows: '1',
    wt: 'json',
    fl: 'title,nsuid_txt,type,image_url,image_url_h2x1_s,pretty_game_categories_txt,dates_released_dts,publisher,excerpt,url,playable_on_txt',
  });
  return `https://searching.nintendo-europe.com/en/select?${q}`;
}

/**
 * Fail closed unless the single returned document carries our exact EU
 * base-game NSUID and the catalog title. Same output shape as parseNintendoMeta
 * so every downstream consumer is source-agnostic.
 */
export function parseEuSolrMeta(body, { slug, title, euNsuid, now = new Date() } = {}) {
  const doc = body?.response?.docs?.[0];
  if (!doc || doc.type !== 'GAME') return null;
  if (!(doc.nsuid_txt ?? []).map(String).includes(String(euNsuid))) return null;
  if (!isNintendoBaseGameNsuid(String(euNsuid ?? ''))) return null;
  if (!titleMatches(doc.title, title)) return null;

  const headerImage = doc.image_url_h2x1_s ?? doc.image_url ?? null;
  if (!/^https:\/\/(www\.)?nintendo\./.test(headerImage ?? '')) return null;
  const releaseDate = (doc.dates_released_dts ?? [])[0] ?? null;
  const releaseMs = Date.parse(releaseDate);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  return {
    slug,
    updatedAt: new Date(nowMs).toISOString(),
    name: doc.title,
    headerImage,
    genres: (doc.pretty_game_categories_txt ?? []).map((g) => String(g).trim()).filter(Boolean),
    releaseDate,
    comingSoon: Number.isFinite(releaseMs) ? releaseMs > nowMs : false,
    metacritic: null,
    recommendations: null,
    reviewDesc: null,
    reviewCount: 0,
    reviewPercent: null,
    description: doc.excerpt ?? null,
    publisher: doc.publisher ?? null,
    developer: null,
    storeUrl: doc.url ? `https://www.nintendo.com${doc.url}` : null,
    metaSource: 'nintendo-eu-solr',
  };
}
