# DealDex V1 落地方案与技术架构

> **For CodeX（执行者必读）：**
> 1. 本文档是唯一执行依据，按 Phase 顺序执行，每个 Task 完成后勾选 `tasks/todo.md` 并提交一次 commit。
> 2. UI 必须遵守根目录 `design.md`（设计规范，具有约束力）；`demo/` 是视觉参照物而非生产代码，处置清单见 §7。
> 3. `game-regional-pricing-core/` 是上一代参考实现：其中的**接口知识和坑**已被验证可信（见 §2），但其"每游戏一个手工 JSON + 无目录层"的结构**不要照抄**，V1 采用 §4 的新数据模型。
> 4. 遵守 `CLAUDE.md`：不得自行推送 main；完成前必须运行验证命令并贴出输出；犯错后更新 `tasks/lessons.md`。
> 5. 所有对外请求使用描述性 UA：`DealDexBot/1.0 (+https://<域名>; contact@<域名>)` —— CheapShark 会直接 400 拒绝通用 UA（2026-07-07 实测）。

**Goal：** 上线一个免费额度内可运营的多平台游戏折扣聚合站（Steam + Nintendo eShop 起步），覆盖游戏基础数据、区域定价、历史价格、跨平台/跨店比价、促销折扣、新游日历、免费游戏七个数据域，首批 300–600 游戏，架构可扩展到 3000+。

**Architecture：** GitHub 仓库同时承载代码与数据（JSON 快照 + 事件化历史）；GitHub Actions 定时抓取并提交数据；Cloudflare Pages 上的 Astro 静态站在数据更新后重建。运行时零服务器、零数据库，全部免费额度内。数据规模触及阈值后按 §6 迁移到 D1/R2（架构已预留接缝）。

**Tech Stack：** Node 22（抓取脚本，零 npm 运行时依赖，沿用参考项目风格）· Astro 5 + TypeScript（SSG 前端）· MiniSearch（客户端搜索，构建期生成索引）· GitHub Actions（定时任务）· Cloudflare Pages（托管）。

---

## 1. 总体架构

```
┌─────────────────── GitHub Repo（公开，见 §6 额度说明） ───────────────────┐
│  /scripts        抓取与构建脚本（Node 22, 零依赖）                        │
│  /data           数据层（JSON，git 即数据库）                             │
│  /site           Astro 前端                                              │
│  /docs /tasks    文档与任务                                               │
└──────────────────────────────────────────────────────────────────────────┘
        ▲ commit                                    │ push 触发
        │                                           ▼
┌── GitHub Actions ──────────────┐        ┌── Cloudflare Pages ──────────┐
│ daily.yml   每日数据管线        │        │ Astro build（静态生成全站）   │
│ weekly.yml  目录/元数据/日历    │───────▶│ 免费：无限静态请求            │
│ （抓取→校验→commit→deploy hook）│        │ 限制：单次部署 ≤2 万文件      │
└────────────────────────────────┘        └──────────────────────────────┘
```

原则：**数据变更节奏 = 日/周，因此全静态是最优解**——比 Workers SSR 少一整层运行时故障面和配额风险，页面即 CDN 缓存，SEO 最快。促销倒计时等"看起来实时"的元素由页面内 JS 基于时间戳客户端渲染。

## 2. 数据源注册表（2026-07-07 全部实测验证）

每个源标注：用途 / 端点 / 频率 / 已验证的坑。全部免 Key（仅 IGDB 需免费 Twitch 凭据）。

### 2.1 Steam Storefront（无 Key，非契约 API，低频使用）

| 用途 | 端点 | 频率 |
|---|---|---|
| 区域价格（核心） | `store.steampowered.com/api/appdetails?appids={批量}&cc={区}&filters=price_overview` | 每日 |
| 元数据（封面/发行商/类型） | 同上，不带 filters，`cc=us` | 每周 |
| 评价数据 | `store.steampowered.com/appreviews/{appid}?json=1&language=all&purchase_type=all&num_per_page=0` | 每周 |
| 折扣/新品/热销发现 | `store.steampowered.com/api/featuredcategories?cc=us` → `specials/top_sellers/new_releases/coming_soon` | 每日 |

**已验证的坑（来自参考项目 + 本次复测）：**
- `filters` 行为**取决于单/批量 appids**（2026-07-08 双向实测）：单 appid 时组合 filters（如 `price_overview,metacritic,recommendations,basic`）返回 200 且字段完整；**批量 appids（≥2 个）+ 任何组合 filters 一律 400，批量只接受 `filters=price_overview` 单独使用**。价格抓取走批量，因此该约束真实存在；记录端点行为时必须注明单/批量条件与测试日期。执行策略不变：价格批量抓 `price_overview`，元数据单 appid 低频抓（可顺带组合 filters 省请求数）。
- **必须信任返回的 `currency` 字段**，严禁按国家推断货币：实测 TR 返回 USD（土耳其已转美元计价），AR/PK 同理。
- `final`/`initial` 一律 ÷100，包括零小数位货币。
- 限速礼仪：请求间隔 ≥1.5s，指数退避重试 3 次，30s 超时（Storefront 非官方约 200 req/5min/IP）。
- `coming_soon` 含大量 Demo 噪音，需过滤（名称含 "Demo"/type 检查），仅作日历辅源。

### 2.2 Nintendo eShop

| 用途 | 端点 | 频率 |
|---|---|---|
| 区域价格+促销（核心） | `api.ec.nintendo.com/v1/price?country={CC}&ids={NSUID批量}&lang=en` | 每日 |
| 欧区目录/折扣发现/元数据 | `searching.nintendo-europe.com/en/select?q=*&fq=type:GAME AND price_has_discount_b:true&wt=json`（Solr） | 每日 |
| 日区 NSUID 发现 | `search.nintendo.jp/nintendo_soft/search.json?q={name}` | 入库时一次 |
| 美区 NSUID 发现 | Nintendo 商品页内嵌 JSON（需浏览器 UA），备源 Algolia 公开索引 | 入库时一次 |

**已验证的坑：**
- NSUID 分 `americas`/`europe`/`japan` 三组，跨组查询返回 `not_found`；**每个游戏入库时需一次性发现三组 NSUID**（§5 Phase 2 已做成半自动管线）。
- 促销返回 `discount_price.start/end_datetime` → 存入 `saleEndsAt`（倒计时数据源）。
- KR/HK 三组 NSUID 均 `not_found`（2026-07-04 参考项目复测），RU 返回价格但实际不可购买——**区域集排除这三者**。
- 欧区 Solr 索引实测含 `price_lowest_f`（**欧区史低种子**）、`price_discount_percentage_f`、`related_nsuids_txt`、`dates_released_dts`（发售日），一个源同时服务目录发现、折扣列表、史低引导、日历。折扣游戏数量为实时值（07-07 测得 3043、07-08 测得 2977），**只作接口可用性样例，不得写进任何验收断言**。

### 2.3 CheapShark（PC 多店比价 + PC 史低种子，免 Key）

| 用途 | 端点 | 频率 |
|---|---|---|
| 多店折扣列表（Steam/GOG/Fanatical/GMG/Humble 等） | `cheapshark.com/api/1.0/deals?sortBy=Savings&pageSize=60` | 每日 |
| 按 Steam appid 反查 + **历史最低价** | `games?steamAppID={id}` → `games?id={gameID}` → `cheapestPriceEver` | 入库时一次 + 每周 |
| 商店清单 | `stores`（storeID → 名称/图标，缓存到 data） | 每月 |

**已验证的坑：**
- **通用 UA（如 `Mozilla/5.0`）直接 400**：`Missing or generic User-Agent header detected`。必须用描述性 Bot UA（本文档头部格式）。
- 实测 `cheapestPriceEver` 对 Elden Ring 返回 `{"price":"29.95","date":...}` —— PC 史低无需自己积累冷启动。
- 条款要求对 CheapShark 链接保留跳转归因（deal 链接走 `cheapshark.com/redirect?dealID=`），页脚注明数据来源。

### 2.4 其他

| 数据域 | 源 | 端点/说明 | 频率 |
|---|---|---|---|
| 免费游戏（Epic） | Epic 促销接口 | `store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US`。**实测响应含局部 GraphQL errors 但 `data.Catalog.searchStore.elements` 完整**，解析必须容忍 errors 字段；`promotions.promotionalOffers` 非空 = 当前免费（`status:"free-now"`），`upcomingPromotionalOffers` 非空 = 即将免费（`status:"upcoming"`），feed 两者都收 | 每日 |
| 免费游戏（Steam） | featuredcategories | `specials` 中 `discount_percent==100` + 每周免费周末项 | 每日 |
| 新游日历 | eShop EU `dates_released_dts` + Steam `coming_soon`（appdetails 补日期，模糊日期拒绝不猜测） | **用户决策（2026-07-08）：不引入 IGDB/Twitch 凭据**，本组合即正式方案；代价是 PS/Xbox 独占日期缺失、Steam 侧精确日期偏少 | 每周 |
| 汇率 | open.er-api.com | `open.er-api.com/v6/latest/USD`，备源 `api.exchangerate-api.com/v4/latest/USD`（参考项目 `fetch-rates.mjs` 直接复用，唯一可整体照搬的模块）；需页脚归因 | 每日 |
| 目录种子 | SteamSpy + featuredcategories.top_sellers + eShop EU 热销排序 | 仅用于"建议新游戏入库"，不直接进目录（见 §4 catalog 治理） | 每周 |

**合规红线**：全部为公开只读端点；不绕过任何认证/付费墙；任何源连续失败 3 天自动跳过并告警而非加压重试；robots/ToS 变化时该源可独立下线（fail-soft，页面显示数据日期）。

## 3. 免费额度核算（可行性证明）

| 资源 | 免费额度 | V1 用量（600 游戏） | 3000 游戏时 |
|---|---|---|---|
| GH Actions | 公开仓库标准 runner 免费（仍受单 job 时长/并发/存储限制）；私有 2000 min/月 | 日任务 ~15 min ≈ 450 min/月（Steam 20区×12批 + eShop 16区×12批 + 折扣/免费/汇率 ≈ 700 请求 × 1.5s）；**私有预算需另计 weekly、PR CI 与失败重跑** | ~45 min/日 ≈ 1350 min/月；私有仓库将超额 → **建议公开仓库**（数据本就是公开信息），或私有时降为核心游戏日更+长尾周更 |
| CF Pages 构建 | 500 次/月，单次 build 超时 20 min | 日构建 1 次 + 开发推送 ≈ 60 次/月；600 游戏 Astro build 远低于 20 min | 3000 游戏时构建耗时需实测，接近 10 min 即启用增量/缓存优化 |
| CF Pages 文件数 | ≤2 万/次部署 | 600 游戏 × 3 页 + 枢纽/日历 ≈ 2500 文件 | 3000×3+杂项 ≈ 1 万，仍安全；超限前先合并低流量子页 |
| 仓库体积 | — | 数据 ~10 MB | 事件化历史下 ~60 MB/年，git 无压力；>300MB 时启动 §6 迁移 |

## 4. 数据模型（git 即数据库）

```
data/
  catalog.json                # 目录 = 唯一事实来源（人审入库）
  rates/usd.json              # 汇率快照 {updatedAt, rates:{TRY:..,UAH:..}}
  stores.json                 # CheapShark 商店清单缓存
  snapshots/
    steam/{slug}.json         # Steam 区域价最新快照
    eshop/{slug}.json         # eShop 区域价最新快照
    stores/{slug}.json        # 多店现价（CheapShark）
  history/{slug}.json         # 事件化价格历史（只追加）
  feeds/
    deals-steam.json          # 每日折扣清单（发现层，含未入目录游戏）
    deals-eshop.json
    deals-stores.json
    free-games.json
    calendar.json             # 未来 6 个月发售日历
  suggestions/
    catalog-candidates.json   # 周任务产出的入库建议（人审后并入 catalog）
```

### 4.1 catalog.json（每条目 = 一个逻辑游戏，跨平台 ID 聚合于此）

```json
{
  "slug": "hollow-knight-silksong",
  "title": "Hollow Knight: Silksong",
  "steamAppId": 1030300,
  "nsuids": { "americas": "7001…", "europe": "7001…", "japan": "7001…" },
  "cheapsharkGameId": "…",
  "platforms": ["pc", "switch", "switch-2", "ps5", "xbox"],
  "genres": ["metroidvania", "action"],
  "msrpUsd": 19.99,
  "addedAt": "2026-07-10",
  "tier": "core"            // core=日更 | extended=周更（规模化开关）
}
```

治理规则：**catalog.json 只能通过人审 PR 修改**；周任务把种子源的热门候选写入 `suggestions/`（附自动发现的各平台 ID 与置信度），用户审核合并。这是"数百→数千"扩张时唯一的质量闸门。

### 4.2 快照 schema（steam/{slug}.json，eshop 同构）

```json
{
  "slug": "elden-ring",
  "updatedAt": "2026-07-07T07:30:00Z",
  "regions": [
    { "cc": "TR", "currency": "USD", "amount": 39.99, "usd": 39.99,
      "list": 59.99, "listUsd": 59.99, "discountPct": 33,
      "saleEndsAt": null, "rank": 3 }
  ]
}
```

与参考项目的关键差异：**存数值不存格式化字符串**（`"$15.03"` → `15.03`），本地化显示是前端构建期的职责；`regions` 仍按代表价 USD 升序重排并写 `rank`。

### 4.3 history/{slug}.json（事件溯源，只记变化）

```json
{
  "slug": "elden-ring",
  "atl": { "pc": { "usd": 29.95, "date": "2025-11-28", "seed": "cheapshark" },
           "eshop-us": { "usd": 29.99, "date": "2026-06-12", "seed": "self" } },
  "events": [
    { "d": "2026-07-03", "ch": "steam", "cc": "US", "usd": 29.99, "pct": 50 }
  ]
}
```

- 每日抓取后 diff 快照：**价格变化才追加事件**（600 游戏×365 天全量快照会撑爆 git；事件化后每游戏每年约 2–8 KB）。
- ATL 三来源：CheapShark 种子（PC）、eShop EU `price_lowest_f` 种子（欧区）、自积累（其余）；`seed` 字段标注出处，前端据此显示 "since we started tracking" 的诚实措辞。

### 4.4 校验闸门

`scripts/validate.mjs`：**从零实现，禁止照搬参考项目的 `validate-data.mjs`**（后者只做结构/存在性检查，不合格作为生产闸门）。必须逐条实现的断言：schema 校验、价格 >0、折扣 0–100、USD 换算偏差 <2%、区域数不低于上次快照的 80%、feed 条目数不为零。**校验失败 = 整批不 commit**，保留旧数据并在 Actions 日志告警。这是防脏数据进 git 的唯一闸门，不可跳过。

## 5. 实施计划（Phase 0–6）

> 每个 Task 粒度 = 一次可验证的提交。执行时逐条勾选 `tasks/todo.md`。

### Phase 0：仓库与骨架（0.5 天）

- **T0.1** `git init`；建目录 `scripts/ data/ site/ docs/`；根 `package.json`（`"type":"module"`, engines node>=22）；`.editorconfig`、`.gitignore`（node_modules, dist, .DS_Store）。验收：`node --version` ≥22，目录就位。
- **T0.2** 把 `game-regional-pricing-core/src/lib/fetch-rates.mjs` 复制为 `scripts/lib/rates.mjs`（唯一整体复用的文件），补上描述性 UA 常量模块 `scripts/lib/http.mjs`（fetchJson：UA/超时 30s/退避重试 3 次/`sleep`，从参考 scraper 中提炼为公共库；**所有脚本禁止自行 fetch，必须走此模块**）。验收：`node -e "import('./scripts/lib/rates.mjs').then(m=>m.fetchRates()).then(r=>console.log(r.TRY))"` 输出数字；**UA 中的域名与联系邮箱为真实值（域名未定则先用真实可收信邮箱），不得带 `<域名>` 占位符提交**。
- **T0.3** GitHub 仓库创建与首推（**由用户执行/授权**，CLAUDE.md 约束）；决定公开/私有（§3 建议公开）。

### Phase 1：Steam 区域价管线（2 天）

- **T1.1** `data/catalog.json` 首批 ~40 条（从 demo 出现过的游戏 + 参考项目 18 款 Steam 游戏迁移；eShop 字段留空待 Phase 2）。
- **T1.2** `scripts/scrape-steam.mjs`：读 catalog 中含 steamAppId 的条目 → 按区(20 区，沿用参考项目区域集去掉 RU)×批量 50 appids 抓 `price_overview` → 写 `data/snapshots/steam/*.json`（§4.2 数值化 schema）。**先写 `scripts/test/fixtures/` 录制的真实响应样本和 `node --test` 解析单测（货币信任、÷100、USD 折算），测试通过再跑真网**。验收：40 游戏快照生成，抽查 TR 区 currency 为 USD 的游戏换算正确。
- **T1.3** `scripts/build-history.mjs`：对比新旧快照产出事件 + 更新 ATL；CheapShark `games?steamAppID` 批量补 `cheapestPriceEver` 种子（注意 UA）。验收：连续跑两次第二次零事件；ATL 与 CheapShark 实测值一致。
- **T1.4** `scripts/validate.mjs` + `npm run validate`。验收：手工篡改一个负价格能被拦截。
- **T1.5** `.github/workflows/daily.yml` 骨架：rates → steam → history → validate → commit（`chore(data): daily steam …`）→ 失败即中止不提交。验收：workflow_dispatch 手动跑通一次。

### Phase 2：eShop 管线与 NSUID 发现（2 天）

- **T2.1** `scripts/discover-nsuid.mjs {slug}`：EU Solr（取 `nsuid_txt`）→ JP search.json → US 商品页内嵌 JSON（浏览器 UA）；输出三组 NSUID + 置信度，写回 catalog 需人工确认（脚本打印 diff，不自动写）。验收：对 Silksong 跑出三组 NSUID 并与任天堂商店页人工核对一致。
- **T2.2** `scripts/scrape-eshop.mjs`：16 区（参考项目区域集）× NSUID 批量 → `data/snapshots/eshop/*.json`，含 `saleEndsAt`；EU `price_lowest_f` 写入 history ATL 种子。同样先 fixtures 单测。验收：TotK 三区价格与商店页抽查一致。
- **T2.3** 首批 eShop 游戏入库（catalog 补 nsuids，15–20 款 NS 热门）；daily.yml 增加 eshop job（与 steam job 串行，间隔 30 min）。

### Phase 3：折扣/免费/多店/日历 feeds（2 天）

- **T3.1** `scripts/scrape-feeds.mjs`：featuredcategories → `deals-steam.json` + `free-games.json`（100% 折扣项）；EU Solr 折扣查询 → `deals-eshop.json`；CheapShark deals（sortBy=Savings，各激活商店）→ `deals-stores.json`；Epic 促销 → 并入 `free-games.json`（**解析必须容忍顶层 errors**；`free-games` 条目带 `status: "free-now" | "upcoming"`，见 §2.4）。feed 条目统一 schema：`{title, storeId, url, price, list, pct, endsAt?, steamAppId?, slugIfTracked?}`——`slugIfTracked` 把 feed 与目录游戏挂接（有详情页的折扣可内链）。
- **T3.2** 日历：`scripts/scrape-calendar.mjs`（EU dates + Steam coming_soon，过滤 Demo/模糊日期）→ `calendar.json`（月分组）。IGDB 路线经用户决策废弃，不得引入 Twitch 依赖。
- **T3.3** `weekly.yml`：元数据/评价刷新 + 目录候选建议（SteamSpy top + top_sellers + EU 热销，排除已入库，写 `suggestions/catalog-candidates.json`）+ 日历刷新。

### Phase 4：Astro 前端（4–5 天）

- **T4.1** `site/` 初始化 Astro + TS strict；`site/src/styles/tokens.css` ← **从 `demo/assets/styles.css` 迁移全部 design tokens（§7 处置清单）**；`Layout.astro` + `Header.astro`（含停靠搜索结构）+ `Footer.astro`——demo 三份重复 header 的教训：布局只写一次。
- **T4.2** 数据接入层 `site/src/lib/data.ts`：构建期读 `../data/**`，提供 `getGame(slug)`、`getDeals()`、`getBoards()` 等纯函数 + 派生计算（区域榜、史低榜、$/区差榜）。单测覆盖派生逻辑。
- **T4.3** 页面（IA 沿用已定结构，全部静态路由）：
  - `/` 首页：复刻 demo 首屏（打字机搜索重写为 Astro island，参数沿用 design.md §3.6；实时卡数据来自真实 snapshots）+ 区域入口 + 各 feed 区块。
  - `/steam/deals` `/switch/deals`：feed 渲染 + 客户端筛选（island）。
  - `/steam/regional-pricing` `/switch/regional-pricing`：区域枢纽页（全目录区域价概览表 + 说明内容）。**所有展示区域价的页面（枢纽页 + 详情 regional-prices 子页）必须带免责 note-box**（design.md §3.3 组件）：展示的是商店列价与汇率估算，不保证跨区可购买，不等于含税/支付手续费后的最终结算价；demo game.html 的 note-box 文案是基线。
  - `/game/{slug}`（Overview）+ `/game/{slug}/regional-prices` + `/game/{slug}/price-history`：**独立静态子页 + Tab 视觉**（demo 已定结构）；史低徽章、买/等占位（V1 只按"当前价 vs ATL"给静态规则文案，预测模型不做——YAGNI）。
  - `/new-releases/{yyyy-mm}`：日历月页。
  - `/free-games`。
- **T4.4** 搜索：构建期产出 `search-index.json`（slug/title/平台/别名），MiniSearch island 接入头部搜索框。验收：输入 "silk" 能到详情页。
- **T4.5** SEO 基建：每页 title/description 模板、schema.org `Product/Offer/AggregateRating` JSON-LD（价格页）、`VideoGame`（详情）、sitemap（@astrojs/sitemap）、robots.txt、OG 图（静态模板即可，动态 OG 不做）。验收：Rich Results Test 通过 Product 校验。

### Phase 5：区域定价可视化地图（1.5 天，方案见 §8）

- **T5.1** `PixelWorldMap.astro`：按 §8 规格实现（坐标表 + tier 配色 + tooltip + 无障碍回退）。
- **T5.2** 接入 `/game/{slug}/regional-prices` 顶部；首页区域入口卡加静态缩略版（同组件 `compact` 模式）。位置未最终确定——组件必须上下文无关，由页面传数据。

### Phase 6：部署与监控（0.5 天）

- **T6.1** Cloudflare Pages 连接仓库（用户授权），build command `cd site && npm run build`，输出 `site/dist`；`daily.yml` 末尾 `curl` Pages Deploy Hook（数据 commit 用 `[skip ci]` 避免 git 集成重复构建，统一走 hook——或反之，二选一并写入 README）。
- **T6.2** 监控：Actions 失败通知（GitHub 自带邮件）+ 每页页脚渲染 `updatedAt` 数据时间戳 + `validate` 产出的 `data/health.json`（各源最后成功时间）渲染成 `/status` 页。

## 6. 规模化路径（触发条件写死，避免过早优化）

| 触发 | 动作 |
|---|---|
| 目录 >1500 或私有仓库 Actions 超时 | catalog `tier` 生效：core 日更 / extended 周更轮转（脚本已按 tier 过滤，无需改架构） |
| 仓库 >300 MB 或单次部署临近 2 万文件 | 数据迁 R2（快照/历史）+ 构建期从 R2 拉取；或详情子页合并。此时才考虑 D1 |
| 需要用户账户/告警订阅 | Workers + D1/KV 增量引入，静态站不动 |

## 7. demo/ 处置清单（对 CodeX 有约束力）

| 资产 | 处置 |
|---|---|
| `design.md` | **约束性规范**，前端一切实现以此为准 |
| `demo/assets/styles.css` 的 `:root` tokens + 组件配方 | **迁移**为 `site/src/styles/tokens.css` + 各 Astro 组件样式；类名可重构，视觉结果必须与 demo 一致 |
| demo 三个 HTML 的页面结构/信息层级 | **参照**（组件化重写，杜绝三份 header 的复制粘贴） |
| 打字机/停靠搜索的交互参数与坑（design.md §3.6） | **沿用参数重写**为 island；坑（预览环境 IO/rAF 不可靠、focus 暂停）已记录 |
| demo 假数据、`serve.mjs`、`launch.json` | **舍弃**；demo 目录整体保留在仓库作历史参照，不部署 |
| Steam CDN 封面直链 | V1 继续直链（构建期校验 200 + akamai 回退，坑见 design.md §8）；正式运营后再评估 R2 缓存 |

## 8. 区域定价可视化地图方案

**已实施（2026-07-10 v2，响应用户反馈）：真实地理像素栅格图。** `scripts/build-worldgrid.mjs` 将 Natural Earth 派生 GeoJSON 栅格化为 80×40 网格（run-length 编码 ~252 个 SVG rect，含可辨认的大陆海岸线），产出 `site/src/lib/worldgrid.data.mjs`（一次性生成入库）。配色三向：基线（US）中性白、比基线便宜绿系、比基线贵红系，深浅两档表 30% 分界；hover/聚焦画基线对比虚线（方向色）+ 提示条；质心取最大连通块（避免阿拉斯加拉偏 US 锚点）。原坐标表方案已废弃。

规格（`site/src/components/PixelWorldMap.astro`）：
- **输入**：`regions: {cc, name, usd, pctVsUs}[]`、`mode: 'full' | 'compact'`。组件不感知平台（Steam/eShop 通用）。
- **布局**：内置坐标表 `{cc → {col, row, w, h}}`，在 24×12 网格上按真实地理近似位置摆放国家色块（美洲左、欧非中、亚太右）；未追踪区域画 `--surface-2` 底色块作背景轮廓。
- **配色**：按 `pctVsUs` 分 5 档 tier，用现有 token：≤−30% `--green-bg`、−30~−10% 浅绿、±10% `--surface-2`、+10%+ `--red-bg` 系；描边一律 `--ink`（遵守 design.md 糖果色成对规则，色块上文字用 `--ink`）。
- **交互**：hover/focus 显示 tooltip（国名 + 当地价 + USD + vs US%）；点击滚动至下方表格对应行并高亮。键盘可达（色块为 `<button>`，`aria-label` 完整）。
- **无障碍与降级**：地图 `role="img"` + 摘要 `aria-label`；紧邻的区域表格是同数据的文本等价物，无 JS 时地图纯展示不影响任何功能。
- **放置**：主位 = `/game/{slug}/regional-prices` 顶部；`compact` 模式（无交互、8×4 网格、只显最便宜 3 区）备用于首页区域入口卡与枢纽页。最终位置用户未定——组件自包含，挪动零成本。
- **V2 升级路径**（不在本期）：Natural Earth（公有领域）→ topojson → 构建期生成真实 choropleth SVG，替换坐标表；组件 API 不变。

## 9. 测试与质量策略

- 解析器全部走 **fixtures 单测**（`node --test`，录制真实响应存 `scripts/test/fixtures/`）：Steam 货币信任/÷100、eShop saleEndsAt、Epic errors 容忍、CheapShark schema。网络零依赖，CI 秒级。
- `validate.mjs` 是数据 commit 的强制闸门（§4.4）。
- 前端：`site/src/lib/data.ts` 派生逻辑单测；构建即测试（Astro build 失败 = 页面级回归）；上线前跑一次 Rich Results/hreflang 抽查清单（写入 tasks/todo.md）。
- CI（PR 触发）：lint + 单测 + validate + astro build。

## 10. 风险与应对

| 风险 | 概率 | 应对 |
|---|---|---|
| Steam Storefront 收紧限速/封 GH Actions IP | 中 | 已低频+退避；备用：分时段分片、自托管 runner（家用机）跑抓取仅提交数据 |
| Nintendo 端点变更/NSUID 体系随 Switch 2 演化 | 中 | fail-soft 保旧数据 + health 页告警；发现脚本独立于日更管线 |
| Epic/CheapShark 接口变化 | 低 | 均为增值 feed，降级不影响核心区域价 |
| Pages 2 万文件上限 | 低（3000 游戏内安全） | §6 触发器 |
| 版权素材（封面图） | 低 | 直链官方 CDN 不转存，页脚声明非官方站点；被投诉即换文字卡 |

## 11. 明确不做（YAGNI，防跑偏）

用户账户/云端愿望单（本地 localStorage 起步）、价格预测模型（详情页仅基于 ATL 的规则文案）、多语言（结构预留 hreflang，V1 纯英文）、PS/Xbox 区域价抓取（仅日历覆盖）、联盟链接改写（流量起来前无收益，V2 再接）、自建图片代理、评论/社区功能。

---

**执行入口**：CodeX 从 Phase 0 开始，每 Phase 结束在 `tasks/todo.md` 打勾并向用户汇报一次。首个里程碑 = Phase 1 完成（40 款游戏的 Steam 区域价每日自动更新进 git）。
