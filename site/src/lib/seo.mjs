const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const SEO_NAME_OVERRIDES = { TR: 'Turkey' };

export function countryName(cc) {
  if (typeof cc !== 'string' || !/^[A-Z]{2}$/.test(cc)) return cc ?? '';
  return SEO_NAME_OVERRIDES[cc] ?? regionNames.of(cc) ?? cc;
}

export function lowestCountryNames(snapshot, limit = 3) {
  return [...(snapshot?.regions ?? [])]
    .filter((row) => row?.cc && Number.isFinite(row?.usd))
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.usd - b.usd)
    .filter((row, index, rows) => rows.findIndex((candidate) => candidate.cc === row.cc) === index)
    .slice(0, limit)
    .map((row) => countryName(row.cc));
}

function priceExamples(countries) {
  if (countries.length === 0) return '';
  if (countries.length === 1) return ` Including ${countries[0]} price.`;
  if (countries.length === 2) return ` Including ${countries[0]} price and ${countries[1]} price.`;
  return ` Including ${countries.slice(0, -1).map((name) => `${name} price`).join(', ')}, and ${countries.at(-1)} price.`;
}

export function regionalGameSeo(gameTitle, channel, snapshot) {
  const countries = lowestCountryNames(snapshot, 3);
  if (channel === 'eshop') {
    return {
      title: `${gameTitle} Region Prices | eShop Cheapest Regions ranked`,
      description: `Compare Nintendo eShop pricing across different countries. Find the cheapest country and best regional discount to buy ${gameTitle}.${priceExamples(countries)}`,
      countries,
    };
  }
  return {
    title: `${gameTitle} Region Prices | Cheapest Steam Price`,
    description: `Compare Steam pricing across different countries. Find the cheapest country and best regional discount to buy ${gameTitle}.${priceExamples(countries)}`,
    countries,
  };
}
