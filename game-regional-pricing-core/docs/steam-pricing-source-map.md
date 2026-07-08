# Steam Pricing Source Map

Last updated: 2026-07-03

## Scope

The Steam pricing module is separate from `src/data/ai-pricing/`. It models buy-once games, DLC/add-ons, regional sale prices, and Steam-returned currencies without changing the subscription pricing data flow.

Current games:

- `baldurs-gate-3` - base game appid `1086940`, Digital Deluxe Upgrade appid `2378500`
- `cyberpunk-2077` - base game appid `1091500`
- `sekiro-shadows-die-twice` - base game appid `814380`
- `stardew-valley` - base game appid `413150`
- `hollow-knight-silksong` - base game appid `1030300`
- `palworld` - base game appid `1623730`
- `mount-and-blade-ii-bannerlord` - base game appid `261550`
- `red-dead-redemption-2` - base game appid `1174180`
- `forza-horizon-6` - base game appid `2483190`
- `dead-by-daylight` - base game appid `381210`
- `rust` - base game appid `252490`
- `subnautica-2` - base game appid `1962700`
- `meccha-chameleon` - base game appid `4704690`
- `elden-ring` - base game appid `1245620`
- `terraria` - base game appid `105600`
- `death-stranding-2-on-the-beach` - base game appid `3280350`
- `resident-evil-requiem` - base game appid `3764200`
- `god-of-war-ragnarok` - base game appid `2322010`

Current routes:

- `/steam-pricing/`
- `/steam-pricing/baldurs-gate-3/`
- `/steam-pricing/cyberpunk-2077/`
- `/steam-pricing/sekiro-shadows-die-twice/`
- `/steam-pricing/stardew-valley/`
- `/steam-pricing/hollow-knight-silksong/`
- `/steam-pricing/palworld/`
- `/steam-pricing/mount-and-blade-ii-bannerlord/`
- `/steam-pricing/red-dead-redemption-2/`
- `/steam-pricing/forza-horizon-6/`
- `/steam-pricing/dead-by-daylight/`
- `/steam-pricing/rust/`
- `/steam-pricing/subnautica-2/`
- `/steam-pricing/meccha-chameleon/`
- `/steam-pricing/elden-ring/`
- `/steam-pricing/terraria/`
- `/steam-pricing/death-stranding-2-on-the-beach/`
- `/steam-pricing/resident-evil-requiem/`
- `/steam-pricing/god-of-war-ragnarok/`

Steam game pages currently support English and Chinese (`zh`). Route generation and sidebar/list visibility must use each game config's `supportedLocales` so hreflang, canonical, and the language switcher do not create ghost localized URLs. Chinese pages localize game display names with standard Chinese titles while keeping the platform name "Steam" untranslated.

## Data Files

- `src/data/steam-pricing/baldurs-gate-3.json`
  - `app`: display metadata, Steam appid, Store URL, generated icon, source metadata.
  - `plans`: Steam appids mapped to visible columns.
  - `regions`: 19 tracked regions with `countryCode`, `flag`, `ppp`, `continent`, `riskLevel`, `tax`, `currency`, and `prices`.
- `src/data/steam-pricing/{slug}.json`
  - One JSON file per tracked Steam game. The scraper processes every `.json` file in this directory by default, or only the files passed as CLI args.
- `src/data/steam-pricing/index.ts`
  - Sidebar/list config for Steam games.
- `src/data/steam-pricing/data-map.ts`
  - Central import map for route templates.

## Scraper

Command:

```bash
node scripts/scrape-steam-prices.mjs
```

To refresh only selected games:

```bash
node scripts/scrape-steam-prices.mjs forza-horizon-6 dead-by-daylight
```

Workflow:

- `.github/workflows/scrape-steam-prices.yml`
- Daily cron: `30 7 * * *` UTC
- Node: 22
- Commit scope: `src/data/steam-pricing/*.json`
- Includes `git pull --rebase origin "${GITHUB_REF_NAME}"` before push to reduce non-fast-forward failures against sibling crons.

## Public Endpoints Used

### Regional Prices

Endpoint:

```text
https://store.steampowered.com/api/appdetails?appids=1086940,2378500&cc=ua&l=english&filters=price_overview
```

Important behavior:

- Multiple appids work in one request.
- `filters=price_overview` works for regional price requests.
- Combining `price_overview,metacritic,recommendations,basic` returned HTTP 400 in testing, so metadata is fetched separately.
- `price_overview.final` and `price_overview.initial` are integer price units scaled by 100. The scraper divides by 100 for all currencies.
- The scraper trusts `price_overview.currency`. Do not infer currency from country code: Turkey, Argentina, and Pakistan can return `USD`.
- `final_formatted` / `initial_formatted` are used for local display, with trailing ` USD` stripped when present.

Stored price fields:

```json
{
  "local": "674₴",
  "usd": "$15.06",
  "listLocal": "899₴",
  "listUsd": "$20.09",
  "discountPct": 25
}
```

`local` and `usd` are the current final prices. `listLocal`, `listUsd`, and `discountPct` exist only when Steam returns an active discount.

### Game Metadata

Endpoint:

```text
https://store.steampowered.com/api/appdetails?appids=1086940&cc=us&l=english
```

Used fields:

- `header_image`
- `metacritic.score`
- `recommendations.total`

### Reviews

Endpoint:

```text
https://store.steampowered.com/appreviews/1086940?json=1&language=all&purchase_type=all&num_per_page=0
```

Used fields:

- `query_summary.review_score_desc`
- `query_summary.total_positive`
- `query_summary.total_reviews`

`reviewPercent` is computed as `total_positive / total_reviews * 100`.

### Current Players

Endpoint:

```text
https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=1086940
```

Used field:

- `response.player_count`

### Exchange Rates

The Steam scraper reuses:

- `scripts/lib/fetch-rates.mjs`

This helper is shared with `scripts/update-exchange-rates.mjs` and currently falls back between:

- `https://open.er-api.com/v6/latest/USD`
- `https://api.exchangerate-api.com/v4/latest/USD`

## Region Set

The first version intentionally tracks 19 regions, aligned with the heatmap coordinate table:

`UA`, `RU`, `KZ`, `PK`, `IN`, `TR`, `GE`, `AR`, `BR`, `CN`, `KR`, `JP`, `CA`, `US`, `AU`, `GB`, `DE`, `MX`, `CH`.

This set covers the current tracked low/high extremes for BG3 after USD conversion and includes Georgia (`GE`) because Steam currently returns regional prices for every tracked game. Expanding beyond 19 regions requires adding coordinates to `src/components/pricing/claude-v2/ClaudeHeatmap.astro` or disabling the heatmap for regions without coordinates.

## UI Notes

- `ClaudeHeatmap` supports `showShare={false}` because the existing share card is App Store/subscription-specific.
- `ClaudeDetailTable` displays `listUsd` + `discountPct` only when those optional sale fields exist.
- Detail/list pages filter out regions where Steam returns no price for the representative plan, then re-rank the visible rows.
- Address columns are visible on Steam detail pages for layout parity with the AI pricing detail pages.
- Steam appdetails does not expose stable square logo URLs. New game cards use the predictable Steam `library_600x900.jpg` asset and square `object-cover` rendering.
- The `pages.dev` redirect is limited to `opentherank.pages.dev` so Cloudflare branch previews remain testable.

## Known Limitations

- The Storefront API is public and keyless but not a contractual partner API. Keep retries, timeouts, and conservative cron frequency.
- USD equivalents are exchange-rate estimates, not exact checkout totals. Taxes, payment fees, wallet currency, local surcharges, and Steam rounding can differ.
- Steam store country availability is account/payment dependent. The page compares listed regional prices and friction signals; it does not assume every account can buy every region.
