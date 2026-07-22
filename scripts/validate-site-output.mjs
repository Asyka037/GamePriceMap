import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(projectRoot, 'site', 'dist');
const origin = 'https://gamepricemap.com';
const indexedAliasExclusions = new Set(['/new-releases/']);
const xboxDetailUrlPattern = /^https:\/\/www\.microsoft\.com\/store\/productId\/([A-Z0-9]{12})$/u;
const xboxCalendarUrlPattern = /^https:\/\/www\.microsoft\.com\/en-us\/p\/_\/([a-z0-9]{12})$/u;
const psnProductIdPattern = '[A-Z]{2}\\d{4}-[A-Z0-9_]{12}-[A-Z0-9_]{16}';
const psnProductUrlPattern = new RegExp(`^https://store\\.playstation\\.com/en-us/product/(${psnProductIdPattern})$`, 'u');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return nested.flat();
}

function routeForHtml(file) {
  const rel = relative(distDir, dirname(file)).split(sep).join('/');
  return rel ? `/${rel}/` : '/';
}

function locsFromXml(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
}

function canonicalFromHtml(html, route) {
  const match = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/);
  assert(match, `${route} is missing one canonical link`);
  assert((html.match(/rel="canonical"/g) ?? []).length === 1, `${route} must contain exactly one canonical link`);
  return match[1];
}

function attributeFromTag(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = tag.match(new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(["'])(.*?)\\1`, 'iu'));
  return match?.[2] ?? null;
}

function openingAnchors(html) {
  return [...html.matchAll(/<a\b[^>]*>/giu)].map((match) => ({
    index: match.index,
    tag: match[0],
    href: attributeFromTag(match[0], 'href'),
  }));
}

function elementBlocks(html, tagName) {
  const escapedName = tagName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`<${escapedName}\\b[^>]*>[\\s\\S]*?<\\/${escapedName}>`, 'giu');
  return [...html.matchAll(pattern)].map((match) => ({
    index: match.index,
    end: match.index + match[0].length,
    html: match[0],
    openingTag: match[0].match(new RegExp(`^<${escapedName}\\b[^>]*>`, 'iu'))?.[0] ?? '',
  }));
}

function hasClass(tag, expected) {
  return (attributeFromTag(tag, 'class') ?? '').split(/\s+/u).includes(expected);
}

function releaseCalendarRanges(html) {
  return elementBlocks(html, 'article')
    .filter((block) => hasClass(block.openingTag, 'release-card')
      || hasClass(block.openingTag, 'release-calendar-row'));
}

function isReleaseCalendarRoute(route) {
  return route === '/' || /^\/new-releases\/(?:\d{4}-\d{2}\/)?$/u.test(route);
}

function assertSafeExternalAnchor(anchor, route, store) {
  assert(attributeFromTag(anchor.tag, 'target') === '_blank', `${store} link must open in a new tab: ${route}`);
  const rel = new Set((attributeFromTag(anchor.tag, 'rel') ?? '').trim().split(/\s+/u).filter(Boolean));
  assert(rel.has('noopener'), `${store} link is missing noopener: ${route}`);
  assert(rel.has('nofollow'), `${store} link is missing nofollow: ${route}`);
}

function storeRows(html, channel) {
  return elementBlocks(html, 'tr')
    .filter((block) => attributeFromTag(block.openingTag, 'data-store-channel') === channel);
}

const files = await walk(distDir);
const htmlFiles = files.filter((file) => file.endsWith(`${sep}index.html`) || file === join(distDir, 'index.html'));
const builtRoutes = new Map(htmlFiles.map((file) => [routeForHtml(file), file]));

for (const route of builtRoutes.keys()) {
  assert(!/^\/(?:xbox|psn)(?:\/|$)/.test(route), `platform pilot must not create a standalone list route: ${route}`);
}

const robots = await readFile(join(distDir, 'robots.txt'), 'utf8');
assert(/^User-agent:\s*\*$/m.test(robots), 'robots.txt must address all crawlers');
assert(/^Allow:\s*\/$/m.test(robots), 'robots.txt must allow the public site');
assert(/^Sitemap:\s*https:\/\/gamepricemap\.com\/sitemap-index\.xml$/m.test(robots), 'robots.txt must point to the canonical sitemap index');

const sitemapIndex = await readFile(join(distDir, 'sitemap-index.xml'), 'utf8');
const sitemapUrls = locsFromXml(sitemapIndex);
assert(sitemapUrls.length > 0, 'sitemap-index.xml contains no sitemap files');
assert(new Set(sitemapUrls).size === sitemapUrls.length, 'sitemap-index.xml contains duplicate sitemap files');

const indexedUrls = [];
for (const sitemapUrl of sitemapUrls) {
  const parsed = new URL(sitemapUrl);
  assert(parsed.origin === origin, `sitemap index contains a URL on the wrong origin: ${sitemapUrl}`);
  const xml = await readFile(join(distDir, parsed.pathname.slice(1)), 'utf8');
  indexedUrls.push(...locsFromXml(xml));
}

assert(indexedUrls.length > 0, 'the sitemap contains no page URLs');
assert(new Set(indexedUrls).size === indexedUrls.length, 'the sitemap contains duplicate page URLs');

const indexedRoutes = new Set();
for (const url of indexedUrls) {
  const parsed = new URL(url);
  assert(parsed.origin === origin, `sitemap contains a URL on the wrong origin: ${url}`);
  assert(parsed.protocol === 'https:', `sitemap URL is not HTTPS: ${url}`);
  assert(!parsed.search && !parsed.hash, `sitemap URL contains query or hash data: ${url}`);
  indexedRoutes.add(parsed.pathname);
}

for (const [route, file] of builtRoutes) {
  const html = await readFile(file, 'utf8');
  const canonical = canonicalFromHtml(html, route);
  if (indexedAliasExclusions.has(route)) {
    assert(!indexedRoutes.has(route), `${route} is a canonical alias and must not be indexed`);
    assert(canonical !== `${origin}${route}`, `${route} must canonicalize to its dated release page`);
    assert(indexedUrls.includes(canonical), `${route} canonical target is missing from the sitemap: ${canonical}`);
    continue;
  }
  assert(indexedRoutes.has(route), `built page is missing from the sitemap: ${route}`);
  assert(canonical === `${origin}${route}`, `${route} canonical does not match its sitemap URL: ${canonical}`);
}

for (const route of indexedRoutes) {
  assert(builtRoutes.has(route), `sitemap URL has no built index.html: ${route}`);
}

let xboxDetailLinks = 0;
let xboxCalendarLinks = 0;
let xboxComparisonRowsTotal = 0;
let psnDetailLinks = 0;
let psnCalendarLinks = 0;
let psnComparisonRowsTotal = 0;
let xboxHistoryPages = 0;
let psnHistoryPages = 0;
for (const [route, file] of builtRoutes) {
  const html = await readFile(file, 'utf8');

  if (/^\/game\/[^/]+\/price-history\/$/u.test(route)) {
    const hasXboxSeries = /\bdata-channel=(["'])xbox\1/u.test(html);
    const hasXboxAtl = html.includes('Xbox Store US');
    const hasPsnSeries = /\bdata-channel=(["'])psn\1/u.test(html);
    const hasPsnAtl = html.includes('PlayStation Store US');
    const cadenceNotes = elementBlocks(html, 'p')
      .filter((block) => hasClass(block.openingTag, 'trend-note'));
    assert(cadenceNotes.length === 1, `price-history page must contain one cadence note: ${route}`);
    const cadenceChannels = new Set((attributeFromTag(cadenceNotes[0].openingTag, 'data-trend-cadence') ?? '')
      .split(',').filter(Boolean));
    assert(cadenceChannels.has('xbox') === hasXboxSeries,
      `Xbox cadence claim must match its price-history series: ${route}`);
    assert(cadenceChannels.has('psn') === hasPsnSeries,
      `PlayStation cadence claim must match its price-history series: ${route}`);
    assert(cadenceNotes[0].html.includes('Xbox') === hasXboxSeries,
      `Xbox cadence copy must only appear for tracked Xbox games: ${route}`);
    assert(cadenceNotes[0].html.includes('PlayStation') === hasPsnSeries,
      `PlayStation cadence copy must only appear for tracked PlayStation games: ${route}`);
    assert(hasXboxSeries === hasXboxAtl, `Xbox price-history series and ATL label must appear together: ${route}`);
    assert(hasPsnSeries === hasPsnAtl, `PlayStation price-history series and ATL label must appear together: ${route}`);
    xboxHistoryPages += Number(hasXboxSeries);
    psnHistoryPages += Number(hasPsnSeries);
  }

  const xboxRows = storeRows(html, 'xbox');
  const psnRows = storeRows(html, 'psn');
  if (xboxRows.length || psnRows.length) {
    assert(/^\/game\/[^/]+\/$/u.test(route), `store comparison row escaped a game detail page: ${route}`);
  }
  for (const row of xboxRows) {
    const links = openingAnchors(row.html).filter((anchor) => xboxDetailUrlPattern.test(anchor.href ?? ''));
    assert(links.length === 1, `Xbox comparison row must contain exactly one canonical product link: ${route}`);
    xboxComparisonRowsTotal += 1;
  }
  for (const row of psnRows) {
    const links = openingAnchors(row.html).filter((anchor) => psnProductUrlPattern.test(anchor.href ?? ''));
    assert(links.length === 1, `PlayStation comparison row must contain exactly one canonical product link: ${route}`);
    psnComparisonRowsTotal += 1;
  }

  const calendarRanges = releaseCalendarRanges(html);
  for (const anchor of openingAnchors(html)) {
    let parsed;
    try {
      parsed = new URL(anchor.href ?? '', origin);
    } catch {
      continue;
    }
    const isMicrosoft = parsed.origin === 'https://www.microsoft.com';
    const isPlayStation = parsed.origin === 'https://store.playstation.com';
    if (!isMicrosoft && !isPlayStation) continue;
    assertSafeExternalAnchor(anchor, route, isMicrosoft ? 'Microsoft Store' : 'PlayStation Store');

    const xboxDetailMatch = (anchor.href ?? '').match(xboxDetailUrlPattern);
    if (xboxDetailMatch) {
      assert(/^\/game\/[^/]+\/$/u.test(route), `Xbox price link escaped a game detail page: ${route}`);
      const row = xboxRows.find((candidate) => anchor.index >= candidate.index && anchor.index < candidate.end);
      assert(row, `Xbox price link escaped its comparison row: ${route}`);
      xboxDetailLinks += 1;
      continue;
    }

    const xboxCalendarMatch = (anchor.href ?? '').match(xboxCalendarUrlPattern);
    if (xboxCalendarMatch) {
      assert(isReleaseCalendarRoute(route), `Xbox release link escaped the public release calendar: ${route}`);
      assert(calendarRanges.some((range) => anchor.index >= range.index && anchor.index < range.end),
        `Xbox release link escaped a release calendar entry: ${route}`);
      xboxCalendarLinks += 1;
      continue;
    }

    const psnMatch = (anchor.href ?? '').match(psnProductUrlPattern);
    if (psnMatch) {
      if (/^\/game\/[^/]+\/$/u.test(route)) {
        const row = psnRows.find((candidate) => anchor.index >= candidate.index && anchor.index < candidate.end);
        assert(row, `PlayStation price link escaped its comparison row: ${route}`);
        psnDetailLinks += 1;
      } else {
        assert(isReleaseCalendarRoute(route), `PlayStation release link escaped the public release calendar: ${route}`);
        assert(calendarRanges.some((range) => anchor.index >= range.index && anchor.index < range.end),
          `PlayStation release link escaped a release calendar entry: ${route}`);
        psnCalendarLinks += 1;
      }
      continue;
    }

    throw new Error(`${isMicrosoft ? 'Microsoft Store' : 'PlayStation Store'} link has a non-canonical domain/path: ${route} — ${anchor.href}`);
  }
}
const catalogDocument = JSON.parse(await readFile(join(projectRoot, 'data', 'catalog.json'), 'utf8'));
const expectedXboxMappings = catalogDocument.games.filter((game) => game.xboxBigId).length;
const expectedPsnMappings = catalogDocument.games.filter((game) => game.psnProductId).length;
assert(expectedXboxMappings > 0, 'catalog contains no reviewed Xbox mappings');
for (const game of catalogDocument.games) {
  for (const channel of ['xbox', 'psn']) {
    const id = channel === 'xbox' ? game.xboxBigId : game.psnProductId;
    if (!id) continue;
    const store = channel === 'xbox' ? 'Xbox' : 'PlayStation';
    const detailRoute = `/game/${game.slug}/`;
    const detailFile = builtRoutes.get(detailRoute);
    assert(detailFile, `${store} mapping has no built game detail page: ${detailRoute}`);
    const detailHtml = await readFile(detailFile, 'utf8');
    const rows = storeRows(detailHtml, channel);
    assert(rows.length === 1, `${detailRoute} must contain exactly one ${store} comparison row`);
    const expectedHref = channel === 'xbox'
      ? `https://www.microsoft.com/store/productId/${id}`
      : `https://store.playstation.com/en-us/product/${id}`;
    const productLinks = openingAnchors(rows[0].html).filter((anchor) => anchor.href === expectedHref);
    assert(productLinks.length === 1, `${detailRoute} ${store} row does not match its reviewed catalog product ID`);

    const historyRoute = `/game/${game.slug}/price-history/`;
    const historyFile = builtRoutes.get(historyRoute);
    assert(historyFile, `${store} mapping has no built price-history page: ${historyRoute}`);
    const historyHtml = await readFile(historyFile, 'utf8');
    const channelMarker = new RegExp(`\\bdata-channel=(["'])${channel}\\1`, 'u');
    assert(channelMarker.test(historyHtml), `${historyRoute} is missing its ${store} price-history series`);
    const atlLabel = channel === 'xbox' ? 'Xbox Store US' : 'PlayStation Store US';
    assert(historyHtml.includes(atlLabel), `${historyRoute} is missing its ${store} channel ATL label`);
  }
}
assert(xboxDetailLinks === expectedXboxMappings, `expected ${expectedXboxMappings} Xbox detail links, built ${xboxDetailLinks}`);
assert(xboxComparisonRowsTotal === expectedXboxMappings, `expected ${expectedXboxMappings} Xbox comparison rows, built ${xboxComparisonRowsTotal}`);
assert(xboxHistoryPages === expectedXboxMappings, `expected ${expectedXboxMappings} Xbox price-history pages, built ${xboxHistoryPages}`);
assert(psnDetailLinks === expectedPsnMappings, `expected ${expectedPsnMappings} PlayStation detail links, built ${psnDetailLinks}`);
assert(psnComparisonRowsTotal === expectedPsnMappings, `expected ${expectedPsnMappings} PlayStation comparison rows, built ${psnComparisonRowsTotal}`);
assert(psnHistoryPages === expectedPsnMappings, `expected ${expectedPsnMappings} PlayStation price-history pages, built ${psnHistoryPages}`);

const home = await readFile(join(distDir, 'index.html'), 'utf8');
assert(!/href="\/(?:xbox|psn)(?:\/|\")/.test(home), 'header/footer must not expose standalone Xbox or PSN navigation');
assert((home.match(/\/brand\/gamepricemap-logo-96\.png/g) ?? []).length >= 2, 'home header and footer must use the brand logo');
assert(home.includes('href="/favicon-32.png"'), 'home is missing the PNG favicon');
assert(home.includes('href="/apple-touch-icon.png"'), 'home is missing the Apple touch icon');
assert(!home.includes('data:image/svg+xml'), 'legacy inline favicon is still present');

for (const [asset, maxBytes] of [
  ['brand/gamepricemap-logo-96.png', 30_000],
  ['favicon-32.png', 10_000],
  ['apple-touch-icon.png', 80_000],
]) {
  const info = await stat(join(distDir, asset));
  assert(info.size > 0 && info.size <= maxBytes, `${asset} is empty or unexpectedly large (${info.size} bytes)`);
}

console.log(`Site output valid: ${indexedUrls.length} canonical URLs, ${builtRoutes.size} built pages, ${xboxDetailLinks} Xbox + ${psnDetailLinks} PlayStation detail links, ${xboxCalendarLinks} Xbox + ${psnCalendarLinks} PlayStation release links, logo assets verified.`);
