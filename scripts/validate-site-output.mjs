import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(projectRoot, 'site', 'dist');
const origin = 'https://gamepricemap.com';
const indexedAliasExclusions = new Set(['/new-releases/']);

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

const files = await walk(distDir);
const htmlFiles = files.filter((file) => file.endsWith(`${sep}index.html`) || file === join(distDir, 'index.html'));
const builtRoutes = new Map(htmlFiles.map((file) => [routeForHtml(file), file]));

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

const home = await readFile(join(distDir, 'index.html'), 'utf8');
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

console.log(`Site output valid: ${indexedUrls.length} canonical URLs, ${builtRoutes.size} built pages, logo assets verified.`);
