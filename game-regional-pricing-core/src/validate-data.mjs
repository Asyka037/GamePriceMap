import { listPricingFiles, loadPricing, summarizePricing } from './index.mjs';

const stores = ['steam', 'eshop'];
let failures = 0;

function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`  x ${message}`);
  }
}

for (const store of stores) {
  const files = await listPricingFiles(store);
  console.log(`\n${store}: ${files.length} file(s)`);

  for (const file of files) {
    const slug = file.replace(/\.json$/, '');
    const data = await loadPricing(store, slug);
    const summary = summarizePricing(data);

    assert(data.app?.slug === slug, `${store}/${file}: app.slug should match file name`);
    assert(data.app?.name, `${store}/${file}: app.name is required`);
    assert(Array.isArray(data.plans) && data.plans.length > 0, `${store}/${file}: plans are required`);
    assert(Array.isArray(data.regions) && data.regions.length > 0, `${store}/${file}: regions are required`);
    assert(summary.representativePlan, `${store}/${file}: representative plan is required`);
    assert(summary.regionCount > 0, `${store}/${file}: no regions have USD prices for representative plan`);
    assert(summary.cheapest?.countryCode, `${store}/${file}: cheapest country is missing`);
    assert(summary.mostExpensive?.countryCode, `${store}/${file}: most expensive country is missing`);

    console.log(
      `  ok ${slug}: ${summary.regionCount} regions, ${summary.cheapest?.countryCode} -> ${summary.mostExpensive?.countryCode}`
    );
  }
}

if (failures > 0) {
  console.error(`\nValidation failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log('\nValidation passed.');
