# Nintendo eShop Pricing Source Map

## Scope

The Nintendo eShop pricing module is separate from `src/data/steam-pricing/` and `src/data/ai-pricing/`. It models buy-once Nintendo Switch games, regional eShop list prices, sale prices, and eShop-specific NSUID mappings.

Current routes:

- `/eshop-pricing/`
- `/zh/eshop-pricing/`
- `/eshop-pricing/zelda-tears-of-the-kingdom/`
- `/zh/eshop-pricing/zelda-tears-of-the-kingdom/`

Current locales: English and Chinese (`en`, `zh`).

## Data Files

- `src/data/eshop-pricing/zelda-tears-of-the-kingdom.json`
  - `app`: editorial metadata, Nintendo eShop URL, display icon, representative plan, source metadata.
  - `plans`: visible price columns. Each plan stores three NSUIDs: `americas`, `europe`, and `japan`.
  - `regions`: tracked countries, region group, tax note, PPP scale, risk level, local prices, USD estimates, and currencies.
- `src/data/eshop-pricing/index.ts`
  - Sidebar/list registry and supported locales.
- `src/data/eshop-pricing/data-map.ts`
  - Static imports for Astro pages.

## Price Source

Daily price refresh uses Nintendo's storefront price endpoint:

```text
https://api.ec.nintendo.com/v1/price?country={CC}&ids={NSUID[,NSUID...]}&lang=en
```

This is a public endpoint used by Nintendo storefront pages, but it is not a formally documented third-party API with stability guarantees.

Observed response shape:

```json
{
  "country": "US",
  "prices": [
    {
      "title_id": 70010000063714,
      "sales_status": "onsale",
      "regular_price": {
        "amount": "$69.99",
        "currency": "USD",
        "raw_value": "69.99"
      }
    }
  ]
}
```

Sale responses include `discount_price` with `start_datetime` and `end_datetime`. The scraper stores:

- `local` / `usd`: current effective price.
- `listLocal` / `listUsd`: original list price when discounted.
- `discountPct`: computed discount percentage.
- `saleEndsAt`: eShop sale end time when returned.

USD equivalents use `scripts/lib/fetch-rates.mjs`.

## NSUID Mapping

Nintendo uses different NSUIDs across the Americas, Europe/Oceania/Africa, and Japan storefront groups. Cross-region queries return `not_found`, so every game needs a one-time NSUID discovery step before it can be added to the daily scraper.

Current TotK mappings:

| Plan | Americas | Europe | Japan |
| --- | --- | --- | --- |
| Switch Edition | `70010000063714` | `70010000063715` | `70010000063713` |
| Switch 2 Upgrade Pack | `70050000056960` | `70050000056808` | `70050000056483` |

Discovery sources:

- Europe: `https://searching.nintendo-europe.com/en/select?q={name}&fq=type:GAME&rows=8&wt=json`
- Japan: `https://search.nintendo.jp/nintendo_soft/search.json?q={name}&limit=5`
- US: Nintendo product page embedded JSON, fetched with a browser user agent.

NSUID discovery is not part of the cron. It is a one-time setup task per new game.

## Region Set

The first snapshot tracks 16 regions:

`JP`, `NZ`, `AU`, `AR`, `US`, `CA`, `BR`, `PL`, `NO`, `DK`, `DE`, `GB`, `ZA`, `MX`, `CH`, `CO`.

The first TotK scrape ranked Japan as cheapest and Colombia as most expensive. `HK` and `KR` are excluded because the three NSUID groups returned `not_found`; KR was retested on 2026-07-04 with all six configured TotK NSUIDs and still returned `not_found`. `RU` is excluded because the endpoint still returns a RUB price even though Russian eShop purchases are not available.

## Automation

Manual run:

```bash
node scripts/scrape-eshop-prices.mjs
```

Single-game run:

```bash
node scripts/scrape-eshop-prices.mjs zelda-tears-of-the-kingdom
```

Scheduled run:

- `.github/workflows/scrape-eshop-prices.yml`
- Cron: `08:00 UTC`
- Node: `22`
- Commit scope: `src/data/eshop-pricing/*.json`

## UI Notes

The eShop pages reuse the claude-v2 pricing components:

- `ClaudeHeatmap`
- `ClaudeBoards`
- `ClaudeDetailTable`
- `ClaudeSpectrum`

The heatmap coordinate table was extended for `NZ`, `PL`, `NO`, `ZA`, and `CO`.

The eShop detail table follows the Steam game table pattern: the risk column is hidden, the address column is visible, and countries unsupported by the sample-address site fall back to US sample addresses. Shared tax strings continue to flow through the same `tTax` translation map used by Steam pricing pages.

## Adding A Game

1. Discover the three NSUID groups.
2. Copy the TotK JSON shape.
3. Fill editorial metadata and plans.
4. Reuse the 16-region block unless the game lacks prices in specific regions.
5. Register the game in `src/data/eshop-pricing/index.ts`.
6. Add i18n keys for English and Chinese.
7. Run `node scripts/scrape-eshop-prices.mjs {slug}`.
8. Run `npm run build` and inspect the generated list/detail pages.
