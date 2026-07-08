import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

export const STORES = {
  steam: {
    label: 'Steam',
    dataDir: path.join(ROOT, 'data', 'steam-pricing'),
  },
  eshop: {
    label: 'Nintendo eShop',
    dataDir: path.join(ROOT, 'data', 'eshop-pricing'),
  },
};

function parseUsd(value) {
  const amount = Number.parseFloat(String(value || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(amount) ? amount : Number.POSITIVE_INFINITY;
}

function resolveStore(store) {
  const config = STORES[store];
  if (!config) {
    throw new Error(`Unknown store "${store}". Expected one of: ${Object.keys(STORES).join(', ')}`);
  }
  return config;
}

export function getStoreDataDir(store) {
  return resolveStore(store).dataDir;
}

export async function listPricingFiles(store) {
  const { dataDir } = resolveStore(store);
  const files = await fs.readdir(dataDir);
  return files.filter((file) => file.endsWith('.json')).sort();
}

export async function loadPricing(store, slug) {
  const { dataDir } = resolveStore(store);
  const filePath = path.join(dataDir, `${slug}.json`);
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function listCatalog(store) {
  const files = await listPricingFiles(store);
  const rows = [];

  for (const file of files) {
    const slug = file.replace(/\.json$/, '');
    const data = await loadPricing(store, slug);
    rows.push({
      store,
      slug,
      name: data.app?.name || slug,
      developer: data.app?.developer || null,
      representativePlan: data.app?.representativePlan || data.plans?.[0]?.id || null,
      planCount: data.plans?.length || 0,
      regionCount: data.regions?.length || 0,
      lastUpdated: data.app?.lastUpdated || null,
    });
  }

  return rows;
}

export function summarizePricing(data) {
  const representativePlan = data.app?.representativePlan || data.plans?.[0]?.id;
  const pricedRegions = (data.regions || [])
    .filter((region) => region.prices?.[representativePlan]?.usd)
    .sort((a, b) => (
      parseUsd(a.prices?.[representativePlan]?.usd) - parseUsd(b.prices?.[representativePlan]?.usd)
    ));

  const cheapest = pricedRegions[0] || null;
  const mostExpensive = pricedRegions[pricedRegions.length - 1] || null;
  const hasDiscount = pricedRegions.some((region) => (
    typeof region.prices?.[representativePlan]?.discountPct === 'number'
  ));

  return {
    slug: data.app?.slug || null,
    name: data.app?.name || null,
    representativePlan,
    regionCount: pricedRegions.length,
    cheapest,
    mostExpensive,
    hasDiscount,
    lastUpdated: data.app?.lastUpdated || null,
  };
}
