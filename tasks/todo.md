# DealDex V1 任务清单

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
- [ ] T3.1 scrape-feeds.mjs（Steam specials / EU 折扣 / CheapShark / Epic）
- [ ] T3.2 日历（IGDB 主源，需用户申请 Twitch 凭据；降级方案见方案 §T3.2）
- [ ] T3.3 weekly.yml（元数据/评价刷新 + 目录候选建议）

## Phase 4：Astro 前端
- [ ] T4.1 站点骨架 + tokens.css 迁移 + Header/Footer 组件化
- [ ] T4.2 data.ts 数据接入层 + 派生逻辑单测
- [ ] T4.3 全部页面（首页/折扣/区域枢纽/详情三子页/日历/免费）
- [ ] T4.4 MiniSearch 客户端搜索
- [ ] T4.5 SEO 基建（JSON-LD/sitemap/OG）

## Phase 5：区域定价地图
- [ ] T5.1 PixelWorldMap.astro（方案 §8 规格）
- [ ] T5.2 接入详情页 regional-prices + compact 模式

## Phase 6：部署与监控
- [ ] T6.1 Cloudflare Pages 接入 + Deploy Hook（需用户授权）
- [ ] T6.2 health.json + /status 页 + 页脚数据时间戳

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

## 需要用户操作的事项
- [ ] GitHub 仓库创建/授权首推（T0.3）；决定公开或私有（方案 §3：建议公开）
- [ ] Twitch/IGDB 免费凭据申请（T3.2，约 5 分钟；不申请则用降级日历源）
- [ ] Cloudflare Pages 绑定仓库（T6.1）
- [ ] 每周审核 suggestions/catalog-candidates.json 决定新游戏入库
