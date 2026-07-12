# DealDex V1 任务清单

## 2026-07-10 全面 Code Review（CodeX）

- [x] 核对工作区、交接文档与架构/数据流的实际一致性
- [x] 审查抓取、校验闸门、数据质量与供应链风险
- [x] 审查 Astro 前端、SEO、可访问性与交互实现
- [x] 审查测试、GitHub Actions、部署配置与可运维性
- [x] 运行与评审范围相称的本地验证，并记录可复现结果
- [x] 汇总按严重度排序的发现、未发现项和建议修复顺序

### 评审记录

#### 2026-07-10 Code Review 结果

- 范围：抓取/校验/历史、Astro 页面与交互、地图、GitHub Actions 配置、依赖与线上静态产物；三条独立审查线交叉核对。
- 验证：`npm test` 45/45 通过；`site/npm run build` 成功生成 139 页；`git diff --check` 通过。另在隔离 HEAD 副本复现了“删除一个 Steam 快照仍被 validate 放行”。
- 结论：发现多项 P1，包括过期优惠仍称当前、按渠道混淆史低、快照缺失/部分数据可通过提交闸门、NSUID 日文匹配和 catalog 人审约定失效、首页搜索不可用、地图持平区错色，以及构建期数据进入受影响 Astro `define:vars` / 原始 JSON-LD 的 XSS 风险。
- 交接文档不是完全可信的运行规范：其“所有请求走 HTTP helper”“catalog 只可人审”“失败保旧数据”三项均有代码反例。未修改产品代码；本文件仅记录评审过程与结果。

> 执行依据：`docs/plans/2026-07-07-dealdex-v1-plan.md`（完整方案，含每个 Task 的文件路径、命令与验收标准）。
> 执行者：CodeX。每完成一项打勾并 commit；每个 Phase 结束向用户汇报。

## Phase 0：仓库与骨架
- [x] T0.1 目录结构 + package.json + editorconfig/gitignore
- [x] T0.2 复用 rates.mjs + 提炼公共 http.mjs（描述性 UA/重试/超时）
- [x] T0.3 GitHub 仓库创建与首推（用户提供 https://github.com/Asyka037/GamePriceMap 并授权）

## Phase 1：Steam 区域价管线
- [x] T1.1 catalog.json 首批 42 条（msrpUsd 按 YAGNI 移除，US 快照价即基准）
- [x] T1.2 scrape-steam.mjs（fixtures 单测先行 → 真网验证 42/42）
- [x] T1.3 build-history.mjs（事件化历史 + CheapShark ATL 种子，幂等已验证）
- [x] T1.4 validate.mjs 校验闸门（篡改拦截 exit 1 已验证）
- [x] T1.5 daily.yml 跑通（远端 workflow_dispatch 实跑 47s 成功，机器人数据提交 a8f8401 已落 main）

## Phase 2：eShop 管线与 NSUID 发现
- [x] T2.1 discover-nsuid.mjs（EU/JP/US 三组发现；精确标题匹配 + 跨游戏去重守卫；21 款应用）
- [x] T2.2 scrape-eshop.mjs（16 区 21/21 零失败 + saleEndsAt + EU £史低种子 + 通胀遗留价离群过滤）
- [x] T2.3 21 款 NS 游戏 nsuid 入库 + daily.yml 增加 eshop step（单 job 顺序执行，单次提交无冲突，偏离计划的"双 job 间隔 30min"——原因：单仓单提交无并发冲突场景）

## Phase 3：折扣/免费/多店/日历 feeds
- [x] T3.1 scrape-feeds.mjs（四源 fail-soft；实跑 5/5：10 steam + 293 eshop-eu + 119 多店 + 5 免费含 upcoming）
- [x] T3.2 日历（降级源版：EU upcoming 120 条 + Steam coming_soon 精确日期 4 条 → 4 个月 116 条；用户决策不引入 IGDB，此即正式方案）
- [x] T3.3 weekly.yml（meta 42/42 + 日历 + 候选建议；SteamSpy 403 fail-soft 转 top_sellers + 噪音过滤）

## Phase 4：Astro 前端
- [x] T4.1 站点骨架 + 设计系统 CSS 整体迁移 + Layout/Header/Footer 组件化（header 单点维护，杜绝 demo 的三份复制）
- [x] T4.2 data.mjs 读取层 + derive.mjs 纯派生（买/等规则、三榜单、追踪折扣）+ 7 项单测（39/39 全绿）
- [x] T4.3 全部页面：137 静态页 825ms 构建；详情 Tab 是真实子路由；区域页带免责 note-box；判定文案区分外部种子/自观测史低
- [x] T4.4 MiniSearch（/search-index.json 42 条；/ 快捷键；首屏打字机搜索桥接头部搜索）
- [x] T4.5 canonical/OG/VideoGame+Offer+AggregateRating JSON-LD/sitemap/robots

## Phase 5：区域定价地图
- [x] T5.1 PixelWorldMap.astro（24×12 网格、糖果分档、tooltip、点击滚动至表格行、aria 完整；瓦片覆盖/重叠/越界由单测保障）
- [x] T5.2 已接入 regional-prices（每通道一张图，行锚点+高亮）；compact 模式已实现待用

## Phase 6：部署与监控
- [x] T6.1 Cloudflare Pages git 集成上线（gamepricemap.pages.dev，自动部署已启用；Deploy Hook 方案弃用——git 集成已覆盖）
- [x] T6.2 health.json（validate 通过时产出）+ /status 页（9 源 FRESH/STALE/DOWN）+ 页脚时间戳（Phase 4 已有）

## 评审记录
（每个 Phase 完成后在此追加：改动摘要、验证输出、遗留问题）

### 2026-07-08 方案核验（Claude 计划审计）
- [x] 复核 `docs/plans/2026-07-07-dealdex-v1-plan.md`、`design.md`、参考项目抓取脚本与源映射文档。
- [x] 运行参考数据校验：`node game-regional-pricing-core/src/validate-data.mjs`，结果 `Validation passed`（Steam 18 个 JSON、eShop 16 个 JSON）。
- [x] 实时核验核心端点：Steam appdetails/reviews/featuredcategories、Nintendo eShop price、Nintendo Europe Solr、CheapShark games/stores、Epic freeGamesPromotions、open.er-api.com 与 exchangerate-api fallback。
- [x] 核验免费额度：GitHub Actions public repo 标准 runner 免费、private repo Free 计划 2000 min/月；Cloudflare Pages Free 计划 500 builds/月、20,000 files/site、20 min build timeout。
- [x] 记录执行边界：当前目录不是 Git 仓库，`git status` 无法运行，无法对比 main 分支。

结论：方案总体可执行，推荐作为 Phase 0 起点；但执行前应修正/补充以下点：
- Steam `filters=price_overview,metacritic` 及 `price_overview,metacritic,recommendations,basic` 在 2026-07-08 实测返回 200，不应继续写成"组合 filters 会 400"。更稳妥表述：价格抓取仍只用 `price_overview`，元数据单独低频抓，避免依赖非契约组合字段。
- Nintendo Europe Solr 折扣数从方案记录的 3043 条变为 2977 条，属于实时数据变化；文档中的数量只能作为样例，不应写成稳定验收标准。
- GitHub Actions 公开仓库免费判断成立，但不是"没有任何限制"；仍受 job 时长、并发、artifact/cache/storage 等限制。按方案估算，600 游戏私有仓库日更约 450-600 min/月，3000 游戏约 1350 min/月；需把 weekly、PR CI 和开发重跑一起计入 2000 min/月预算。
- Epic 免费游戏接口确实 200 且带顶层 `errors`；解析规则必须以 `data.Catalog.searchStore.elements` 为主，并按 `promotions.promotionalOffers`/`upcomingPromotionalOffers` 区分当前免费和即将免费。
- `validate.mjs` 需要比参考项目强很多：参考项目现在只做结构/存在性校验，不能直接满足价格合理性、区域覆盖率和 USD 换算偏差闸门。
- 代码实现时不要把 `DealDexBot/1.0 (+https://<域名>; contact@<域名>)` 原样带占位符上线；Phase 0 必须落真实域名或真实联系邮箱。
- CheapShark 通用 UA 400 已复现，所有 HTTP 请求应统一从 `scripts/lib/http.mjs` 走描述性 UA。
- 区域价页面要明确免责声明：展示的是商店列价与汇率估算，不等于用户一定能跨区购买，也不等于含税/支付费的最终结算价。

### 2026-07-08 Claude 复核裁定（对上述审计逐条验证后）
- **Steam 组合 filters：双方各对一半，已按实测改写方案 §2.1。** 复测矩阵（单/批量 × filters 组合）结论：单 appid + 组合 filters 返回 200 且字段完整（审计正确）；**批量 appids + 任何组合 filters 仍然 400**（原方案约束真实存在，审计测试缺批量场景）。价格抓取走批量，约束保留；表述改为带单/批量条件 + 测试日期。
- 采纳并已写入方案：EU 折扣数标注为样例（§2.2）、UA 占位符禁入 Phase 0 验收（T0.2）、validate.mjs 明确"从零实现禁止照搬"（§4.4，原方案断言清单不变）、区域页免责 note-box（T4.3）、Epic free-now/upcoming 区分（§2.4 + T3.1）、Actions 私有预算含 weekly/CI/重跑 + Pages 20min 构建超时（§3）。
- 未采纳/无需改动：validate 断言集本身（原方案 §4.4 已含价格范围/折扣范围/区域覆盖率/汇率偏差/保旧数据，审计要求与其一致）。

### 2026-07-08 Phase 0 + Phase 1 执行记录（Claude）
- 提交序列：bootstrap → T0.1 → T0.2 → T1.1 → T1.2 → T1.3 → T1.4 → T1.5，已推送 origin/main。
- 验证输出：单测 17/17 通过；实抓 42 游戏 × 18 区零失败；史低种子 29 外部 + 13 自观测；重跑幂等（0 新事件）；validate 干净数据放行、负价格篡改 exit 1 拦截。
- 执行中发现并修复：CheapShark `cheapestPriceEver` 对 Epic 送过的游戏（DREDGE、Ghostwire: Tokyo）返回 $0.00，若直接入库会产生"$0 史低"的误导数据——解析器现在拒绝 ≤0 的种子，已补单测（教训已记 lessons.md）。
- 与计划的偏差：catalog 移除 msrpUsd 字段（US 快照价是唯一基准，避免双源）；rates.mjs 移植时把 process.exit(1) 改为 throw（fail-soft 归调用方）。
- 遗留：T1.5 需在 GitHub 网页上手动 workflow_dispatch 一次确认 Actions 环境可跑（本地已全链路验证）。

### 2026-07-08 Phase 2 执行记录（Claude）
- 单测 24/24；eShop 实抓 16 区 21/21 零失败；validate 通过；重跑幂等。
- NSUID 发现踩坑并修复（详见 lessons.md）：① 首轮 startsWith 匹配把 "Hollow Knight"→Silksong、"Hades"→HADES II，收紧为精确标题匹配（franchise 名是续作前缀）；② US 商品页 URL 猜错时 200 重定向到通用商店页，正则抓到无关 nsuid——加 res.url 校验 + 页面标题验证 + 跨游戏重复 nsuid 守卫（5 个重复项自动丢弃转人工）。
- 数据质量决策：Nintendo API 会返回通胀遗留价（Stardew AR = 2017 年的 ARS 179.99 ≈ $0.12），快照层按"低于中位数 10%"过滤离群区域（纯函数 + 单测；Silksong AR 正常价 $17.33 正确保留）。
- 遗留（转人工/后续）：5 款游戏 US nsuid 待手工补（sea-of-stars/dredge/balatro/nine-sols/animal-well）；cyberpunk（Switch 2 仅 Ultimate 版）、palworld 等未入 eShop；JP 有 7 款未匹配到（英文标题搜索不中，后续用日文名重试）。

### 2026-07-08 Phase 3 执行记录（Claude）
- 单测 32/32；validate 扩展覆盖 feeds/calendar/meta 后全绿；四个 feed 实跑 5/5 源成功。
- 设计偏差（已论证）：feed schema 增加 currency 字段（Steam 是 USD、eShop-EU 是 GBP，混同会错价）；免费流条目带 status: free-now|upcoming。
- 已知局限：Steam coming_soon 多数条目日期模糊（"Q4 2026"类被拒绝不猜测），日历 Steam 侧仅 4 条精确（用户决策：不引入 IGDB，接受此局限）；SteamSpy 返回 403（UA 或防爬调整），候选建议暂靠 top_sellers 单源。

### 2026-07-09 Phase 4 执行记录（Claude）
- astro build 137 页 / 825ms；产物内容断言全绿（首页三榜单真实数据、Silksong 详情 BUY@$14.99、区域页 16+18 区、搜索索引 42 条、JSON-LD/sitemap/robots 就位）。
- 单测 39/39（新增 derive 层 7 项：判定分档、榜单派生、货币格式化、史低诚实措辞）。
- 品牌名沿用仓库名 GamePriceMap（demo 的 DealDex 是占位符）；site URL 暂用 gamepricemap.pages.dev，正式域名定了改 astro.config.mjs 一处即可。
- 与计划偏差：数据层用 .mjs+JSDoc 而非 .ts（让根目录 node --test 直接测同一份代码，避免双构建链）；home 打字机数据由构建期真实快照生成而非硬编码。
- 遗留到 Phase 5/6：区域页预留 #region-map-slot 挂点；/status 页与 health.json 在 T6.2。

### 2026-07-09 Phase 5 执行记录（Claude）
- 单测 44/44（新增 mapgrid 5 项：34 追踪区域瓦片全覆盖、无重叠、网格边界、分档边界、pct 计算）。
- 构建 137 页正常；Silksong 区域页断言：34 交互瓦片 + 12 大陆底纹 + aria-label 含本币/USD/差价 + 行锚点生效。
- 地图为坐标表方案（V2 升级到 Natural Earth choropleth 的路径已写入方案 §8，组件 API 不变）。

### 2026-07-09 Phase 5 补充 + T6.2 执行记录（Claude）
- 定时 cron 已自主完成 2026-07-09 日更（无人触发），管线连续两天正常。
- T6.2：validate 闸门通过时产出 data/health.json；/status 页按各源节奏预算渲染 FRESH/STALE/DOWN，当前 9/9 FRESH；构建 138 页。
- 剩余：仅 T6.1（Cloudflare Pages 绑定，用户操作）。绑定用 git 集成即可（数据日更 push 自动触发构建，约 35 次/月 << 500 限额），daily.yml 里的 Deploy Hook 注释段可以永久不启用。

### 2026-07-10 V1 上线验证（Claude）
- https://gamepricemap.pages.dev 全站 11 条关键路由 200；线上断言：首页三榜单+实时卡、Silksong BUY 判定、区域地图 34 瓦片、/status 9/9 FRESH、搜索索引 42 条、sitemap 138 URL、canonical 与域名一致。
- 注意：Pages 对无尾斜杠路径返回 308 重定向（正常行为，SEO 用 canonical 收敛）。
- V1 全部 Phase（0-6）完成。后续任一数据日更 push 都会自动触发 Pages 重建。

### 2026-07-10 地图 v2 重做（用户反馈驱动）
- 反馈三点全部落实：① 真实地理栅格（80×40，Natural Earth 数据点在多边形判定，ASCII 预览确认海岸线可辨）；② hover 画"国家→US 基线"的方向色对比虚线 + 基线圆点 + 工具条（实测 AU +2%、GB +12% 正确）；③ 配色收敛三向（基线白/便宜绿/贵红，深浅表 30% 分界），旧五档糖果色废弃。
- 修复：US 质心被阿拉斯加拉偏 → 质心改取最大连通块；worldgrid 由 JSON 改为 ESM 数据模块（fs 相对路径在 Astro 打包后失效的坑）。
- 验证：44/44 单测（栅格覆盖/越界/三向边界）；构建 138 页；本地预览截图确认地图形态与交互。

### 2026-07-10 地图 v3（参考图驱动重做）
- 用户三点要求全部落实：① 常驻价格标签（HTML 层 + 手工偏移表，DOM 几何断言双图 34 标签零重叠零越界）；② hover 深色悬浮卡（本币/USD/±% 三行）+ 方向色对比弧线，最便宜区常驻绿色弧线 + 脉冲点 + 图内 CHEAPEST/BASELINE 摘要条；③ 全宽地图 + 1:1 离散像素块（RLE 只作存储格式，渲染逐格）。
- 修复一个 CSS 特异性 bug：.wm-label.wm-cheaper-2 i 压过 .wm-label-best i，最便宜标签绿字绿底隐形。
- 验证：45/45 单测（新增标签偏移越界断言）；构建 138 页；预览截图 + hover 冒烟 + 几何断言全绿。

### 2026-07-11 CodeX Review 裁定与修复（Claude，逐条验证后）
**全部 6 项 P1 成立**（验证证据）：free-games 结构性无过期过滤（当日数据恰巧干净但日历首月=过去的 2026-06 实锤）；validate 删除 celeste 快照后照样通过（复现 exit=0）；Celeste eShop 行显示 PC $1.99 史低（数据+代码证实）；日文标题归一化后为空串且互相相等（node 实测）；hero 搜索结果渲染进 display:none 容器；npm audit 报 astro HIGH（GHSA-j687-52p2-xcff define:vars XSS）。次级项中 wm-par 产物 58 处而 CSS 零规则（黑块实锤）、$schema 指向不存在文件、无 PR CI 均成立。
**修复清单**：① isLive 集中过期过滤（trackedDeals/free 页/首页/日历月地板 + scrape-calendar 源头丢过去月）；② validate 新增 catalog 推导必需快照存在性 + NSUID 格式/全局唯一断言，scrape-feeds free 流失败源条目从旧文件继承；③ ATL 全面渠道化（atlFor：价格表每行/deals 徽章/history 页标签 'PC (any store, US)'）；④ match.mjs Unicode 归一化（\p{L}\p{N}）+ 空串不匹配 + discover --apply 只写 suggestions/nsuid-candidates.json（catalog 人审治理恢复）；⑤ 搜索重构为可复用 attach（hero 自有结果框、异步竞态修复、Esc 关闭）；⑥ XSS 攻击面消除（define:vars 移除改转义 JSON 数据脚本、JSON-LD 转义 <、innerHTML 改 textContent 构建）——astro 5→7 大版本升级风险高，列为独立后续任务；⑦ wm-par 配色（--surface）+ ±0% 文案 + par 方向 hover 弧线；⑧ ci.yml（push/PR：test+validate+build）；⑨ skip-link + <main>；⑩ $schema 移除、README 首行指 HANDOFF、HANDOFF 三条约定表述修正。
**验证**：51/51 单测（新增 isLive/atlFor/match/par 共 6 项）；validate 删快照现在正确 fail；139 页构建；产物断言全绿（JSON-LD 无裸 <、Celeste eShop ATL $19.99、日历默认 2026-07）。
**后续任务（未在本批）**：astro 7.x 大版本升级（需回归测试）；/status 每游戏粒度陈旧检测；移动端汉堡菜单（既有遗留 #3）。

### 2026-07-11 数据 v2.1 Phase A' 实施（Claude）
- [x] 快照层重写：`assembleRawSnapshot`（本币观测，cc 排序）/ `sameObservations`（语义写入守卫，排除 lastPriceChangeAt）/ `enrichSnapshot`（构建期派生 usd/listUsd/rank）/ `usObservation`（美区原生 USD 断言）
- [x] 双 scraper 改造：失败区域行进位（steam 用 `cc in prices` 区分抓取失败与无售；eshop 用 failedCcs 集合）、语义不变不写盘、仅变化日更新 `lastPriceChangeAt`、每源写 `recordSourceRun`
- [x] `data/source-health.json` 台账（lastAttemptAt/lastSuccessAt/consecutiveFailures）；footer 新鲜度与 validate 均改从台账取数
- [x] validate 强化：快照禁含派生字段、US 行必须原生 USD、cc 排序、币种缺汇率即失败、source-health schema 断言置于错误闸门之前
- [x] 一次性迁移 63 快照（幂等，二跑 0）；实抓验证写入守卫：steam 二次运行 **0 changed / 42 unchanged**（旧架构下汇率抖动曾致 42/42 天天全脏）
- [x] 趋势图：`site/src/lib/chart.mjs` 纯几何 `stepChartModel`（阶梯线；末端=该源 lastSuccessAt 并对过期值钳制；<2 事件返回 null）+ price-history 页每渠道 SVG 图（单渠道游戏不显示无关渠道列，降级"tracking since"虚线空态）
- [x] 测试：steam/eshop 测试改断言 raw schema，新增 snapshot/chart 测试组，共 **62/62 绿**（原 45）
- [x] 顺手修复既有文案 bug：WAIT 卡百分比公式与措辞不符（(ratio−1) 可超 100%，Elden Ring 显示 "100% below today"），改为 1−atl/best（现 50%），补回归测试
- [x] 预览验证：Hades II 双渠道阶梯图（$20.99→$29.99，末端延伸至 07/11）、Elden Ring 单渠道空态、移动端叠列，截图确认
- 评审：派生与观测彻底分离后，git diff 恢复"有变化才有 diff"的语义；趋势图诚实性三原则落地（自观测、末端=最后确认日、数据不足不硬画）。

### 2026-07-12 数据 v2.1 交接审查 + Phase B' Xbox POC（CodeX）
- [x] 复核 `efca541` 的 A' 分层、失败保旧、历史与趋势图实现；修复 `listUsd` 漏检、部分失败误推进 lastSuccessAt、全失败台账无法提交、source-health 弱 schema，并补回归测试
- [x] 实测并固化 Xbox display catalog 解析纯函数、fixtures 与精确标题/edition/重复 ID 守卫；明确排除 `$0 License/Redeem`、trial、bundle、过期 offer
- [x] 实现 `discover-xbox`：20 款候选只写 `data/suggestions/`，绝不直接修改 catalog；真实运行 14/20 通过 autosuggest 唯一精确标题 + 标准 SKU + 正价 Purchase 三重指纹
- [x] 实现 Xbox US 单市场 POC 抓取：批量上限 20、原始观测快照、语义写入守卫、失败保旧、source-health 独立台账；无已批准映射时安全 no-op
- [x] 接入周更工作流、validate/health/status、构建期派生、历史事件与详情页渠道展示
- [x] 完成离线单测、validate、真实 POC 抓取、历史幂等、Astro build 与产物断言
- [x] 更新方案/交接/lessons，并在本节追加评审结果与两周稳定性验收边界
- 人审前评审：**69/69 单测**、validate 通过、139 页构建成功；真实 Microsoft Catalog 发现 20 款中 14 款通过三重指纹；dist 断言 42 个趋势面板且未批准 Xbox 渠道零泄漏；人工注入 `listUsd` 已实证被 validate 以 exit 1 拦截。该阶段的人审阻塞已于用户批准 14 个映射后解除。
- 最终评审：用户批准 14 个映射后，正式首抓 **14 changed / 0 failed**，立即二抓 **0 changed / 14 unchanged**；14 个 native-USD 原始快照、14 个 `xbox-us` self ATL 与事件全部通过产物计数。`history:observations` 二跑 0 新事件且 0 外部请求；69/69 单测、validate、139 页构建全绿。浏览器验收桌面双渠道/三渠道渲染正确；390px 趋势与详情纵向堆叠、`scrollWidth=viewport=390`、零 console error。稳定性记为 **Week 1/2（2026-07-12）**；Week 2 必须等待 2026-07-19 后自然周更完整成功，不得用同日重复抓取替代。

### 2026-07-12 游戏详情、导航与品牌细节修正（CodeX）
- [x] 详情页主价格强化：显示 US 国旗/来源商店与折扣，移除价格判断横幅
- [x] 多平台价格表显示 US 来源；仅在最低价未全员相等时标记全部并列 BEST
- [x] 顶部导航移除路径提示，统一 Deals / Regional pricing，并为跨平台专题明确平台名
- [x] Free games / New releases 的 title、description、H1 与面包屑前置平台名
- [x] 收紧 Header/Footer 品牌字标中 `Game` 与 `PriceMap` 的间距并保持一致
- [x] 更新回归测试，运行单测、validate、构建与产物断言
- [x] 本地浏览器完成桌面、移动端视觉/交互验收
- [x] 提交并推送 `main`，确认生产部署生效
- 评审：70/70 单测、validate、139 页 Astro 构建与产物断言通过。浏览器实证：Elden Ring 两渠道同价时 BEST=0；Dead by Daylight 三渠道中 Steam/eShop 同为 $19.99 时 BEST=2；TUNIC 主价格显示 Nintendo eShop、US 国旗、−80% 与原价。桌面无横向溢出；390px 下宽表收敛为局部可访问滚动区，`scrollWidth=viewport=390`；控制台零 error/warning。功能提交 `82320ba` 已推送 `main`，生产域名逐页确认新 DOM、SEO title 与 BEST 规则生效。

## 需要用户操作的事项
- [ ] 每周审核 suggestions/catalog-candidates.json 决定新游戏入库
- [x] 已审核并批准 `suggestions/xbox-candidates.json` 的 14 个标准版映射（2026-07-12），已合并 catalog 并完成首次生产观测
