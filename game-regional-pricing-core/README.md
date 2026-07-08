# Game Regional Pricing Core

这个目录是从 OpenTheRank 当前站点中抽离出来的游戏区域定价后端模块。它不包含 Astro 页面、Tailwind 样式、热力图或详情表 UI，新项目可以直接复用这里的数据结构、抓取脚本和文档，再接自己的前端。

## 目录结构

```text
game-regional-pricing-core/
  data/
    steam-pricing/        # Steam 游戏价格 JSON 快照
    eshop-pricing/        # Nintendo eShop / Switch 游戏和会员价格 JSON 快照
  docs/
    steam-pricing-source-map.md
    eshop-pricing-source-map.md
  src/
    lib/fetch-rates.mjs   # USD 汇率抓取，Steam/eShop 共用
    scrapers/
      scrape-steam-prices.mjs
      scrape-eshop-prices.mjs
    index.mjs             # UI 或 API 层读取 JSON 的轻量 helper
    validate-data.mjs     # 数据结构校验
  package.json
```

## 环境要求

- Node.js `>=22.12.0`
- 无 npm 依赖，使用 Node 内置 `fetch`、`fs`、`path`
- 抓取需要能访问 Steam、Nintendo eShop 和汇率 API

## 常用命令

```bash
cd game-regional-pricing-core
npm run validate:data
npm run scrape:steam
npm run scrape:eshop
```

只刷新单个游戏：

```bash
npm run scrape:steam -- baldurs-gate-3
npm run scrape:eshop -- zelda-tears-of-the-kingdom
```

如果新项目想把数据目录放到别处，可以用环境变量覆盖：

```bash
STEAM_PRICING_DATA_DIR=/path/to/steam-json npm run scrape:steam
ESHOP_PRICING_DATA_DIR=/path/to/eshop-json npm run scrape:eshop
```

## 数据模型

每个游戏一个 JSON 文件，核心结构一致：

```json
{
  "app": {
    "slug": "baldurs-gate-3",
    "name": "Baldur's Gate 3",
    "representativePlan": "base",
    "lastUpdated": "2026-07-03T01:43:56.559Z",
    "metadata": {}
  },
  "plans": [
    {
      "id": "base",
      "name": "Base Game",
      "usBenchmark": "$44.99"
    }
  ],
  "regions": [
    {
      "rank": 1,
      "region": "Ukraine",
      "countryCode": "UA",
      "prices": {
        "base": {
          "local": "674₴",
          "usd": "$15.03",
          "listLocal": "899₴",
          "listUsd": "$20.04",
          "discountPct": 25
        }
      },
      "currency": {
        "base": "UAH"
      },
      "tax": "20% VAT included"
    }
  ]
}
```

约定：

- `prices[planId].local` / `usd` 是当前实付价。
- `listLocal` / `listUsd` / `discountPct` 只在平台返回促销时存在。
- `saleEndsAt` 目前主要来自 Nintendo eShop 的 `discount_price.end_datetime`。
- `representativePlan` 用于列表页、摘要、最低价/最高价排序。
- `regions` 在抓取后会按代表 plan 的 USD 价格升序重排，并刷新 `rank`。

## 供新 UI 使用的 helper

`src/index.mjs` 提供几个不依赖 UI 的读取函数：

```js
import { listCatalog, loadPricing, summarizePricing } from './src/index.mjs';

const steamGames = await listCatalog('steam');
const bg3 = await loadPricing('steam', 'baldurs-gate-3');
const summary = summarizePricing(bg3);
```

返回的数据仍是原始 JSON，UI 层可以自行决定表格、热力图、SEO 和多语言展示方式。

## Steam 抓取逻辑

脚本：`src/scrapers/scrape-steam-prices.mjs`

使用公开 Storefront API：

```text
https://store.steampowered.com/api/appdetails?appids={appid[,appid]}&cc={country}&l=english&filters=price_overview
```

同时补充：

- `appdetails` 完整响应：封面、横幅、Metacritic、推荐数
- `appreviews`：评价摘要、好评率、评价数
- `GetNumberOfCurrentPlayers`：实时在线人数

注意：

- Steam 返回的 `currency` 必须可信任，不能按国家推断货币；土耳其、阿根廷、巴基斯坦等可能返回 USD。
- `final` / `initial` 统一按除以 100 处理。
- 这是公开、免 Key、长期稳定的 Storefront 接口，但不是正式合作 API，建议保持低频 cron、重试和超时。

## Nintendo eShop 抓取逻辑

脚本：`src/scrapers/scrape-eshop-prices.mjs`

使用 Nintendo 店铺价格接口：

```text
https://api.ec.nintendo.com/v1/price?country={CC}&ids={NSUID[,NSUID...]}&lang=en
```

关键差异：

- Nintendo 的 NSUID 按 `americas` / `europe` / `japan` 三个区域组不同。
- 每个新游戏都需要先发现并填入 `plans[].nsuids`。
- 价格接口返回促销截止时间，脚本会写入 `saleEndsAt`。
- 当前 eShop 数据排除了容易误导的不可购买/不支持区域，详情见 `docs/eshop-pricing-source-map.md`。

## 加新 Steam 游戏

1. 复制一个 `data/steam-pricing/*.json`。
2. 修改 `app.slug`、`app.name`、`app.steamAppId`、`steamUrl`。
3. 在 `plans` 中填 Steam appid；DLC/升级包可以作为第二列。
4. 复用现有 `regions` 国家列表，保留 `tax`、`countryCode`、`flag`。
5. 运行：

```bash
npm run scrape:steam -- new-slug
npm run validate:data
```

## 加新 Nintendo eShop 游戏

1. 先发现 Americas / Europe / Japan 三组 NSUID。
2. 复制一个 `data/eshop-pricing/*.json`。
3. 修改 `app.slug`、`app.name`、`plans[].nsuids`。
4. 复用现有 eShop `regions`，如某国家 `not_found`，抓取后再决定是否剔除。
5. 运行：

```bash
npm run scrape:eshop -- new-slug
npm run validate:data
```

## 建议 cron

Steam 和 eShop 可以分开跑，避免同一时间推送同一批数据文件：

```text
Steam: 07:30 UTC daily
eShop: 08:00 UTC daily
```

新项目如果使用 GitHub Actions，建议：

- Node 22
- `concurrency` 按平台分组
- cron 前 `git pull --rebase`
- 只提交 `data/steam-pricing/*.json` 或 `data/eshop-pricing/*.json`
- commit message 标清平台，例如 `chore: update steam regional prices`

## 从 OpenTheRank 剥离时刻

本目录只保留后端逻辑和数据：

- 不包含 Astro 页面。
- 不包含 `ClaudeHeatmap`、`ClaudeDetailTable`、`ClaudeBoards`、`ClaudeSpectrum` 等 UI 组件。
- 不包含 i18n JSON；新项目 UI 可自行决定多语言。
- 不包含 Cloudflare Pages 配置。

如果后续要接数据库，可以把 `data/*/*.json` 当作种子数据，scraper 的写入目标从 JSON 文件替换成数据库 upsert。
