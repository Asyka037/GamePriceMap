# DealDex V1 任务清单

> 执行依据：`docs/plans/2026-07-07-dealdex-v1-plan.md`（完整方案，含每个 Task 的文件路径、命令与验收标准）。
> 执行者：CodeX。每完成一项打勾并 commit；每个 Phase 结束向用户汇报。

## Phase 0：仓库与骨架
- [ ] T0.1 目录结构 + package.json + editorconfig/gitignore
- [ ] T0.2 复用 rates.mjs + 提炼公共 http.mjs（描述性 UA/重试/超时）
- [ ] T0.3 GitHub 仓库创建与首推（需用户授权）

## Phase 1：Steam 区域价管线
- [ ] T1.1 catalog.json 首批 ~40 条
- [ ] T1.2 scrape-steam.mjs（fixtures 单测先行 → 真网验证）
- [ ] T1.3 build-history.mjs（事件化历史 + CheapShark ATL 种子）
- [ ] T1.4 validate.mjs 校验闸门
- [ ] T1.5 daily.yml 跑通（rates→steam→history→validate→commit）

## Phase 2：eShop 管线与 NSUID 发现
- [ ] T2.1 discover-nsuid.mjs（EU/JP/US 三组发现，人工确认写回）
- [ ] T2.2 scrape-eshop.mjs（16 区 + saleEndsAt + EU 史低种子）
- [ ] T2.3 首批 NS 游戏入库 + daily.yml 增加 eshop job

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

## 需要用户操作的事项
- [ ] GitHub 仓库创建/授权首推（T0.3）；决定公开或私有（方案 §3：建议公开）
- [ ] Twitch/IGDB 免费凭据申请（T3.2，约 5 分钟；不申请则用降级日历源）
- [ ] Cloudflare Pages 绑定仓库（T6.1）
- [ ] 每周审核 suggestions/catalog-candidates.json 决定新游戏入库
