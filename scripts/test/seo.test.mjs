import test from 'node:test';
import assert from 'node:assert/strict';
import { countryName, lowestCountryNames, regionalGameSeo } from '../../site/src/lib/seo.mjs';

const snapshot = {
  regions: [
    { cc: 'US', usd: 59.99, rank: 4 },
    { cc: 'IN', usd: 30, rank: 2 },
    { cc: 'TR', usd: 25, rank: 1 },
    { cc: 'PK', usd: 35, rank: 3 },
  ],
};

test('country labels and lowest three countries derive from ranked snapshot rows', () => {
  assert.equal(countryName('TR'), 'Turkey');
  assert.deepEqual(lowestCountryNames(snapshot), ['Turkey', 'India', 'Pakistan']);
});

test('regional SEO dynamically interpolates game, channel and lowest countries', () => {
  assert.deepEqual(regionalGameSeo('Cyberpunk 2077', 'steam', snapshot), {
    title: 'Cyberpunk 2077 Region Prices | Cheapest Steam Price',
    description: 'Compare Steam pricing across different countries. Find the cheapest country and best regional discount to buy Cyberpunk 2077. Including Turkey price, India price, and Pakistan price.',
    countries: ['Turkey', 'India', 'Pakistan'],
  });

  const eshop = regionalGameSeo('Hades', 'eshop', { regions: snapshot.regions.slice(1, 3) });
  assert.equal(eshop.title, 'Hades Region Prices | eShop Cheapest Regions ranked');
  assert.equal(eshop.description, 'Compare Nintendo eShop pricing across different countries. Find the cheapest country and best regional discount to buy Hades. Including Turkey price and India price.');
});
