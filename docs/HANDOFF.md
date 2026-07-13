# GamePriceMap 交接文档（2026-07-12）

> 读者：CodeX / 任何接手的维护者。本文是当前状态的快照与代码地图；**执行任何开发前，先读 `design.md`（UI 约束）与 `tasks/lessons.md`（踩坑记录），两者具有约束力。**

## 1. 项目状态一览

- **线上**：https://gamepricemap.com （Cloudflare Pages git 集成，push main 自动部署；`gamepricemap.pages.dev` 仅为平台部署域名）
- **进度**：V1 Phase 0–6 **全部完成**；数据 v2.1 **Phase A' 已完成并经 CodeX 复审加固**；Phase B' Xbox POC 工程已完成，用户已批准 14 个标准版映射，首次正式观测成功，当前处于不可压缩的稳定性 **Week 1/2**
- **自动化**：GitHub Actions 每日 07:30 UTC 数据管线（Steam 18 区 + eShop 16 区 + 4 路 feeds + 历史/史低 + 校验闸门 + 机器人提交）、每周一 09:00 UTC（元数据/Xbox US POC/自观测历史/日历/目录候选）；周更历史使用 `observations-only`，不重复触发 CheapShark 外部种子请求
- **规模**：42 款游戏（21 款含 eShop NSUID、14 款含 Xbox 标准版映射）、14 个 Xbox US 原始快照、139 静态页、69 项单测全绿
- **验收记录**：每个 Phase 的验证输出都在 `tasks/todo.md` 评审区，含真实运行数字

## 2. 数据流（一句话版）

```
catalog.json(人审目录) → scripts/scrape-*.mjs(每日抓取) → data/snapshots(本币原始观测,仅语义变化才写)
→ build-history.mjs(事件化历史+史低,美区原生USD免疫汇率) → validate.mjs(闸门,失败不提交)
→ git commit(附 data/source-health.json 新鲜度台账) → Cloudflare Pages 重建 Astro 静态站
   （site/lib/data.mjs 构建期用当日汇率派生 usd/rank，下游页面拿到的形状不变）
```

快照分层是 v2.1 的核心决策：git 里只存本币观测（cc/currency/amount/list/discountPct/saleEndsAt），
USD 与排名在站点构建期派生。动机有实证：汇率抖动曾让 42/42 快照每天全部"变脏"（532 行 usd 变动而本币价格零变化）。

Xbox B' 复用同一分层，但仅 US、每周：`discover-xbox` 只写 suggestions；当前 14 个
`xboxBigId+xboxEdition=standard` 已由用户批准并进入 catalog，`scrape-xbox` 写正式快照/历史/UI。
2026-07-12 首抓 14/14 成功，二抓 0 changed/14 unchanged；2026-07-19 后的下一次完整周更成功才满足 Week 2/2。

## 3. 代码地图

```
scripts/
  lib/http.mjs          全项目唯一的 fetch 封装（描述性 UA/重试/超时）——任何新抓取必须走这里
  lib/rates.mjs         汇率（双源回退）
  lib/steam.mjs         Steam 解析纯函数 + 18 区定义（坑注释：批量 appids 只接受 filters=price_overview）
  lib/eshop.mjs         eShop 解析 + 16 区/NSUID 组 + 通胀遗留价离群过滤
  lib/feeds.mjs         四路 feed 解析（Steam specials/EU 折扣/CheapShark/Epic 容错）
  lib/calendar.mjs      日历解析（模糊日期拒绝不猜测）
  lib/history.mjs       事件溯源 + 史低种子合并（≤0 价拒绝）
  lib/cheapshark.mjs    CheapShark 解析（赠送价≠史低）
  lib/xbox.mjs          Xbox 发现/价格纯解析（只认正价 Purchase；排除 $0 License、trial、bundle）
  lib/snapshot.mjs      快照层核心：assembleRawSnapshot(本币组装,cc排序)/sameObservations(写入守卫)/
                        enrichSnapshot(构建期派生usd+rank)/usObservation(美区原生USD断言)
  lib/sourcehealth.mjs  data/source-health.json 台账（lastAttemptAt/lastSuccessAt/consecutiveFailures）
  scrape-steam.mjs / scrape-eshop.mjs / scrape-xbox.mjs / scrape-feeds.mjs / scrape-calendar.mjs / scrape-meta.mjs
  build-history.mjs     历史演进 + CheapShark/EU 种子
  discover-nsuid.mjs    半自动 NSUID 三区发现（精确标题匹配 + 去重守卫；--apply 写回）
  discover-xbox.mjs     Xbox POC 发现（最多20款；三重指纹；--apply 只写 suggestions）
  suggest-catalog.mjs   目录候选（只写 suggestions/，绝不碰 catalog）
  validate.mjs          生产闸门（原始层禁派生字段/价格/折扣/币种/覆盖率/health schema）
  build-worldgrid.mjs   一次性：Natural Earth → 80×40 像素栅格（产出 site/src/lib/worldgrid.data.mjs，勿手改）
  test/                 69 项单测 + 真实响应 fixtures（node --test）
site/
  src/lib/data.mjs      构建期读 /data（唯一 IO 层）
  src/lib/derive.mjs    派生纯函数（买/等规则、榜单、格式化）——根目录单测直接测它
  src/lib/mapgrid.mjs   地图数据层（三向配色 directionFor、LABEL_OFFSETS 手工标签偏移表）
  src/lib/chart.mjs     趋势图纯几何（阶梯线模型；末端=该源 lastSuccessAt 而非"今天"；<2 事件返回 null）
  src/components/       Header(搜索停靠)/Footer/GameHero/GameTabs/DealRows/PixelWorldMap(v3) 等
  src/pages/            首页/折扣×2/区域枢纽×2/game/[slug]×3 子页/日历/免费/about/status
  src/styles/global.css 设计系统唯一实现（token 区在顶部，改视觉先看 design.md）
data/                   git 即数据库：catalog(人审)/snapshots(本币原始观测)/history/feeds/meta/
                        health.json + source-health.json(各源新鲜度台账)
.github/workflows/      daily.yml + weekly.yml（共享并发组，validate 不过不提交）
```

## 4. 本地运行手册

```bash
npm test                 # 69 项单测（零网络，fixtures 驱动）
npm run scrape:steam     # 实抓（约 1 分钟，写 data/snapshots/steam + rates）
npm run scrape:eshop
npm run discover:xbox -- --apply  # 只更新 suggestions，不改 catalog
npm run scrape:xbox               # 仅抓 catalog 已批准映射；US 单市场
node scripts/scrape-feeds.mjs
npm run history          # 事件化历史 + 史低种子（幂等）
npm run validate         # 闸门；篡改数据会 exit 1
cd site && npm install && npm run build   # 139 页静态站 → site/dist
npx astro dev            # 本地开发 http://localhost:4321
```

## 5. 不可破坏的约定

1. **所有对外请求走 `scripts/lib/http.mjs`**（CheapShark 会 400 拒绝通用 UA；UA 指向 /about 页 + 真实邮箱）。**唯一例外**：discover-nsuid 的美区商品页需要浏览器 UA（bot UA 会被拒），该处 raw fetch 属有意为之
2. **validate.mjs 是唯一提交闸门**：断言只能加强不能移除；失败=保旧数据
3. **catalog.json 只能人审修改**；所有脚本（含 discover-nsuid --apply）只写 `data/suggestions/`，由人合并
4. **地图三向配色**是用户明确决策：基线中性 / 便宜绿 / 贵红，禁止加第四种语义色
5. **worldgrid.data.mjs 是生成物**（`node scripts/build-worldgrid.mjs` 重新生成），勿手改
6. **史低诚实性**：外部种子与自观测在 UI 措辞上必须区分；赠送价（$0）不是史低
7. **推送 main 需用户授权**（CLAUDE.md/AGENTS.md）；数据机器人提交是既定授权的例外
8. **仓库转公开**（用户 2026-07-11 决定）：GitHub Actions 公开仓库免费无限，配额不再是扩容约束；但 tier 分级调度仍是目录扩容的硬前置（礼貌抓取与管线时长，见数据方案 v2.1）
9. **快照只存本币原始观测**：usd/listUsd/rank 是站点构建期派生物，绝不能写回 `data/snapshots/`（validate 会直接失败）；改动快照 schema 前先跑 `scripts/migrate-snapshots-raw.mjs` 式的幂等迁移并留档

## 6. 已知遗留（按建议优先级）

| # | 事项 | 说明 |
|---|---|---|
| 1 | Xbox 稳定性 Week 2/2 待自然时间 | Week 1 于 2026-07-12 完整成功；2026-07-19 后下一次周更需 14/14、0 failures、validate/build 全绿。此门槛前禁止扩市场/扩目录，不能用重复抓取伪造一周时间跨度 |
| 2 | 5 款 US NSUID 待手工补 | sea-of-stars / dredge / balatro / nine-sols / animal-well（发现器按"宁缺勿错"丢弃了重复项；补法：任天堂商店页搜索→取 7001 开头 nsuid→写 catalog→跑 `npm run scrape:eshop -- <slug>` 验证价格合理） |
| 3 | 7 款 JP NSUID 未匹配 | 英文标题在 search.nintendo.jp 搜不中，用日文名重跑 `node scripts/discover-nsuid.mjs <slug> --apply` 或手工 |
| 4 | 移动端导航 | ≤1024px 时 main-nav 直接隐藏，无汉堡菜单（design.md 已标 TODO） |
| 5 | SteamSpy 403 | 目录候选暂靠 top_sellers 单源；可试换 UA 或改用 Steam 搜索排行 |
| 6 | 日历 Steam 侧精确日期少 | 降级源固有局限（用户决策不引入 IGDB/Twitch，勿翻案） |
| 7 | compact 地图未挂载 | PixelWorldMap 的 compact 模式已实现，可上首页区域入口卡 |
| 8 | 正式域名 | 定域名后改 `site/astro.config.mjs` 的 site + `scripts/lib/http.mjs` 的 UA + robots.txt |

## 7. 候选开发方向（供用户指派）

- **目录扩容到 100+**：走 suggestions 人审 → discover-nsuid 批跑 → 验证管线耗时（方案 §6 有 tier 分级开关）
- **首页/枢纽页挂 compact 地图**、移动端汉堡菜单、区域枢纽页排序筛选
- **多语言脚手架**（方案定的优先级：ja → de/fr → zh；hreflang 结构 Layout 已预留 canonical 单域）
- **联盟变现层**（方案 §11 曾列为 V2；CheapShark redirect 已天然带归因）
- **Xbox B' 后续门槛**：当前 14 个映射已批准；仅在连续两周完整成功后，才评估多市场/更多游戏；此前只修 POC 问题，不扩容

## 8. 文档索引

- `docs/plans/2026-07-07-dealdex-v1-plan.md` — 架构与决策（含所有端点坑的实测记录）
- `docs/plans/2026-07-10-data-v2-research.md` — 数据 v2.1：A' 已完成；B' 工程与首次观测完成，稳定性 Week 1/2
- `design.md` — UI 设计规范（约束性）
- `tasks/todo.md` — 全部执行与验收记录（按 Phase）
- `tasks/lessons.md` — 踩坑教训（新错误必须追加）
- `demo/` — 早期视觉原型（只作参照，不部署）
- `game-regional-pricing-core/` — 上一代参考实现（只作接口知识来源）
