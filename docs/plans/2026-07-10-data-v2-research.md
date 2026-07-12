# 数据方案 V2 研究：历史价格趋势 + 五平台比价 + 千级规模

> 研究日期 2026-07-10，所有端点均为当日亲手实测（证据附各节）。本文是研究结论与落地建议，供用户决策后交 CodeX 实施。

## 0. 结论摘要

1. **趋势图不需要等任何新数据源**——现有事件化历史（只记变化点）天然就是阶梯折线图的数据结构，先把图画出来（Phase A），ITAD 回填让曲线"变长"是增强而非前提。
2. **五平台免费数据全部可行**：Steam/NS 已在运行；**Xbox 当日实测免 key 全链路通**；**PSN 商店页内嵌 JSON 可用**（避开哈希轮换的 GraphQL）；**Epic 直连已被 Cloudflare 盾墙（实测 403 challenge），价格改走 ITAD**——一把免费 key 同时给 Epic/GOG 等 PC 店现价 + 全部 PC 历史回填。
3. **千级规模的最大隐患不在抓取而在 git 体积**：当前每个快照都带 `updatedAt`，导致**价格没变的日子也全量产生 diff**。修掉这一个问题（内容不变不写盘），git 增长就从"∝ 天数×游戏数"降为"∝ 真实价格变化数"，git-as-DB 可以撑到 3000 游戏不迁移。

## 1. 历史价格与趋势图

### 1.1 数据结构：现状已经是对的

`data/history/{slug}.json` 的 events 只记价格**变化点**（`{d, ch, cc, usd, pct}`）——趋势图用阶梯线（step chart）渲染：每个事件是一个台阶，末尾补一个"今天"点。**不需要每日快照序列**，存储零增长，这是比逐日采样更优的图表数据源。

### 1.2 回填（让曲线覆盖发售至今）

| 渠道 | 回填源 | 说明 |
|---|---|---|
| PC（Steam/Epic/GOG…） | **ITAD API `games/history`**（免费 key） | 按店、按国家返回完整价格变化序列，正好映射进我们的 events 结构（标 `seed:'itad'`）；同一 key 还提供 `games/prices` 现价（Epic 价格的唯一稳定来源）与 `games/storelow` 各店史低。当日实测：服务在线（无 key 返回 403 "Missing api key"），**注册免费 key 是用户操作项**（isthereanydeal.com/apps/，约 2 分钟）。条款要求署名（About 页加一行）+ 非爬库式使用（我们只按目录游戏拉，合规） |
| NS eShop | 无免费回填源（DekuDeals/eshop-prices 均无 API） | 自积累（已开始于 2026-07-08）+ EU 索引 `price_lowest_f` 作"历史最低"地板标注；图表加"tracking since {date}"诚实标签 |
| Xbox / PSN | 无免费回填源 | 同上，自积累；接入当日即开始积累 |

### 1.3 图表实现建议（Phase A，零依赖）

详情页 price-history 子页：inline SVG 阶梯折线（延续设计系统，无图表库），X 轴时间、Y 轴 USD，每渠道一条线（steam / eshop-us 起步），ATL 画金色虚线地板，promo 点标折扣徽章。数据直接内嵌页面（事件数很小）。悬浮读数复用地图 wm-card 样式。

## 2. 五平台数据源注册表（当日实测证据）

| 平台 | 路线 | 实测证据（2026-07-10） | 坑/约束 |
|---|---|---|---|
| Steam | 现行（storefront 批量） | 运行中 | 见方案 §2.1（批量只接受 price_overview 等） |
| NS eShop | 现行（api.ec + EU Solr） | 运行中 | 见方案 §2.2（NSUID 三区、通胀遗留价过滤） |
| **Xbox** | `displaycatalog.mp.microsoft.com/v7.0`：`productFamilies/autosuggest?query=` 发现 → `products?bigIds={批量}&market={CC}` 价格 | autosuggest 命中 ELDEN RING → bigId `9P3J32CTXLRZ`；价格 US $59.99 USD、BR R$299.90 BRL（**market 参数即区域价**） | 免 key；社区共识批量 ≤20 bigIds/请求；发现阶段沿用 NSUID 的教训（精确标题匹配 + 跨游戏去重守卫）；Game Pass 标记在 Properties 里可顺带取 |
| **PSN** | 商店页 `store.playstation.com/{locale}/concept/{id}` 的 `__NEXT_DATA__` 内嵌 JSON | 页面 200（浏览器 UA），含 `basePrice/discountedPrice/discountText` 字段（$59.99、$8.99…） | **选内嵌 JSON 而非 GraphQL persisted query**（后者哈希会轮换，是同类工具的常见断点）；单页 ~1MB → 带宽/时长是主要成本，见 §4 预算；区域价 = 切 locale（en-us/en-gb/ja-jp…），每区一请求；concept id 发现走搜索页同款内嵌 JSON |
| **Epic** | ~~直连~~ → **价格走 ITAD**；免费游戏继续用现行 promotions 端点 | GraphQL 与商品页均 403 + `cf_challenge`（Cloudflare 盾，CI 不可达）；promotions CDN 端点仍 200（已在用） | 不要投入绕盾（违反合规红线且脆弱）；ITAD 的 Epic 价格覆盖美区起步，区域价缺失是接受的代价 |

### 2.1 catalog 扩展（配套）

```json
{ "xboxBigId": "9P3J32CTXLRZ", "psnConceptId": "232581", "itadId": "018d937f-…" }
```
发现管线复制 discover-nsuid 的骨架与守卫（精确标题匹配、置信度、跨游戏重复丢弃、--apply 人审）；ITAD id 用 `games/lookup?appid=` 由 steamAppId 直接反查（零歧义）。

## 3. 千级规模：存储与稳定性

### 3.1 必须先修的一个 bug（比任何新功能优先）

**现状**：scraper 每天重写全部快照文件（`updatedAt` 必变）→ 42 游戏时每日 commit diff 就是全量文件；1000 游戏 × 5 渠道时 git 会以每天数 MB 膨胀，一年 1GB+，git-as-DB 被拖垮。
**修复**：写盘前对比新旧内容（忽略 updatedAt）；不变则不写。新鲜度已由 `health.json` 承担，快照的 updatedAt 改为"价格数据实际变化时间"。修复后 git 增长 ∝ 真实变价事件，估算 1000 游戏 × 5 渠道 ≈ **15–40MB/年**，git 十年无忧。附带收益：Pages 不再每天全量重建缓存失效。

### 3.2 请求与时长预算（GH Actions 私有仓 2000 分钟/月）

按 1000 游戏、请求间隔 1.5s 估算：

| 渠道 | 请求数/天 | 时长 | 备注 |
|---|---|---|---|
| Steam 18 区 | 20 批 × 18 = 360 | ~9 min | 现行模式线性放大 |
| eShop 16 区 | 20 批 × 16 = 320 | ~8 min | 同上 |
| Xbox（10 市场起步） | ceil(1000/20) × 10 = 500 | ~13 min | 批量 20 bigIds |
| ITAD 现价（Epic 等） | 1000/100 批 = 10 | <1 min | POST 批量 |
| PSN | 1000 页 × ~1MB | **~30 min** | **建议：core 100 款每日 + 其余每周轮转**，或整体降为每周 |
| feeds/汇率/历史 | ~20 | ~1 min | 现行 |

合计（PSN 分层后）：**~35 min/天 ≈ 1050 min/月**，私有额度内但已过半；3000 游戏时必须启用 catalog `tier` 分级（方案 §6 既有开关）或把 PSN/Xbox 降为每周。**历史回填是一次性任务**（1000 游戏 × ITAD 批量 ≈ 1-2 小时，跑一次入库）。

### 3.3 稳定性设计（延续既有原则，逐条落到新渠道）

- **每渠道独立 fail-soft**：Xbox/PSN 任一源挂掉只影响自己的快照（保旧数据 + /status 标 STALE），绝不阻塞 Steam/NS 主线。
- **validate 扩展**：新增跨渠道 sanity（同游戏各平台 USD 价差 >3 倍 → 告警不阻断，多半是版本/合集错配）；PSN 解析加 `__NEXT_DATA__` 结构指纹断言（页面改版第一时间在 CI 报警而非静默出脏数据）。
- **非契约端点分级**：Xbox displaycatalog 稳定性社区口碑最好（多年未破坏性变更）；PSN 内嵌 JSON 次之（改版风险，靠指纹断言兜底）；两者均按 Steam 待遇（低频、退避、可独立下线）。
- **存储阈值**（沿用方案 §6）：repo >300MB 或部署临近 2 万文件 → 快照/历史迁 R2，git 只留 catalog+代码。修完 §3.1 后预计 3000 游戏内不会触发。

## 4. 建议的实施切分（交 CodeX）

| Phase | 内容 | 依赖 | 量级 |
|---|---|---|---|
| **A** | ①快照"内容不变不写盘"修复；②详情页 SVG 阶梯趋势图（用现有 events） | 无 | 小，先做 |
| **B** | ITAD 接入：lookup 反查 id 入 catalog → 一次性历史回填（seed:'itad'）→ 每日现价（Epic 列上详情页价格表） | **用户注册 ITAD key** → GH secret `ITAD_KEY` | 中 |
| **C** | Xbox：discover-xbox（autosuggest+守卫）→ scrape-xbox（10 市场）→ 价格表/地图/历史接入 | 无 | 中 |
| **D** | PSN：discover-psn（搜索页内嵌 JSON）→ scrape-psn（core 日更/其余周更）→ 同上接入 | 无 | 中偏大（解析+指纹断言） |
| **E** | validate 跨渠道 sanity + /status 新源行 + About 页数据表更新 | A–D 各自附带 | 小 |

**用户操作项（唯一）**：注册 ITAD 免费 API key（isthereanydeal.com/apps/ → New app → 复制 key），存入 GitHub 仓库 Settings → Secrets → `ITAD_KEY`。

## 5. 明确不做

绕 Epic 的 Cloudflare 盾（合规红线+脆弱）；PSN GraphQL persisted query（哈希轮换断点）；主机历史价的第三方爬取（SteamDB/DekuDeals 禁止抓取）；逐日快照存储（事件化已是更优结构）。

---

# v2.1 修订（2026-07-11，经 CodeX 评审 + 逐条实证后取代 §4 实施切分）

## 0. 评审裁定（先验证后采纳）

| 论点 | 裁定 | 证据 |
|---|---|---|
| "忽略 updatedAt 不够：usd/listUsd/rank 随汇率每日变" | **成立（决定性）** | git 实证：07-08 vs 07-09（同在夏促、本币零变化），532 个区域行仅因汇率抖动改变 usd/listUsd，42/42 快照全脏（示例 animal-well UA 349 UAH：$7.83→$7.84） |
| 停止更新时间会把"抓到但未变价"误报过期 | 成立 | /status 新鲜度由快照 updatedAt 推导（validate.mjs newestStamp） |
| 三层拆分（人审目录 → 原始观测 → 构建期派生） | **采纳为底座核心** | 唯一使 git diff ∝ 真实变价的结构 |
| 事件历史被汇率污染 | **不成立（好消息）** | 实证：全部快照 US 区原生 USD（0 个例外），events 只记 US 区，天然 FX 免疫 |
| ITAD 条款风险/仅三月历史 | 无关（用户决策出局） | → Epic 价格需求放弃（免费游戏 feed 保留）；PC 历史回填放弃，全线自观测 |
| Xbox 仅作 POC | 采纳 | 与原"非契约源"分级一致，细化为小样本人工映射验收制 |
| offers[] 映射拒绝版本混淆 | 原则采纳，随首个新平台落地 | 现有 Steam appid/NS nsuid 即标准版无歧义；Xbox POC 起每条映射人工标注 edition |
| 趋势图末端应到 lastSuccessAt 而非"今天" | 采纳 | 诚实性：抓取失败期间不虚构known状态 |
| PSN 预算数量级 | 承认表述歧义 | 原 30min 按单市场估算未标明；全区域（×10 市场）≈9GB/日、250min，超 45min 上限 → **PSN 暂缓** |
| tier 未被调度使用 | 成立（scrape 脚本零引用） | 列为扩容硬前置 |
| 少写快照 ≠ Pages 停止日构建 | 成立，收回原表述 | rates/feeds/health 每日仍变，仍触发构建；收益仅 git 体积 |

## 1. 修订后的分层（A' 数据底座）

```
catalog（人审） → 原始观测层（git 事实源）        → 构建期派生层（不入库）
                   本币 amount/list、currency、      usd、listUsd、rank、
                   discountPct、saleEndsAt、market、  地图分档、榜单
                   lastPriceChangeAt
                 + source-health.json（每源×市场：lastAttemptAt/lastSuccessAt/
                   coverage/consecutiveFailures —— 新鲜度唯一来源）
```

- 快照文件**移除 usd/listUsd/rank/updatedAt**；USD 与排名由 site 构建期用当日 rates 派生（toUsd/assembleSnapshot 逻辑移至 site/lib）。
- 写盘守卫：语义比较（本币字段），不变不写；scraper 失败区域**保留旧快照该区行**并计入 source-health。
- validate 相应调整：换算偏差断言改到构建期派生检查；快照断言针对本币；新增 source-health schema 断言。
- 一次性迁移：现存 42×2 快照剥离派生字段（events/history 不动）。

## 2. 修订后的实施切分

| Phase | 内容 | 状态 |
|---|---|---|
| **A'** | 数据底座分层（上节）+ 趋势图（美区自观测阶梯线；末端=该源 lastSuccessAt；<2 事件显示 "tracking since"） | **✅ 完成 2026-07-11**（实施记录见 tasks/todo.md；62 单测；写入守卫实证：二次抓取 0 changed/42 unchanged） |
| **B'** | Xbox POC：10–20 款人工映射（bigId+edition 核对入 suggestions 人审）、US 单市场、每周频率、连续两周稳定后再评估扩容与多市场 | **工程完成，稳定性 Week 1/2（2026-07-12）**：用户批准 14 个标准版映射；首次正式抓取 14 changed/0 failed，二跑 0 changed/14 unchanged；历史二跑 0 新事件；69 单测/validate/139 页构建/桌面与 390px 浏览器验收通过。Week 2 完整成功前禁止扩容或多市场 |
| 弃 | ITAD 全部用途（用户决策）；Epic 比价（无合规源）；PC 历史回填 | — |
| 缓 | PSN（预算数量级 + 无回填价值；重启条件：目录分层调度就绪 + 单市场起步） | — |
| 前置 | tier 调度真正实现（scraper 按 tier 过滤 + weekly 长尾轮转）——任何目录扩容之前 | — |
