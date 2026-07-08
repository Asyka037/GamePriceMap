# DealDex 设计规范（Design System）

> 适用范围：`demo/` 下的所有页面（index.html / deals.html / game.html），实现文件为 `demo/assets/styles.css`。
> 本文档是唯一的风格事实来源（source of truth）。任何 AI 或人类维护者改动 UI 前先读本文；改动风格时同步更新本文。
> 产品语言为英文（全球市场），文档语言为中文。

---

## 1. 风格定位

**糖果像素街机风（Candy Pixel Arcade）**：奶油纸底 + 糖果色块 + 墨色描边 + 无模糊硬阴影 + 像素字体点缀。
灵感来自 FC 平台跳跃游戏（天空、白云、砖块地面），但**像素化只发生在"展示层"，凡是用户需要阅读的内容一律使用可读字体**。

五条核心原则（冲突时按此优先级裁决）：

1. **可读性 > 风格**。价格、表格、正文永远不用像素字体。
2. **颜色即语义**。颜色不做装饰，只编码含义（见 §3）。
3. **硬边世界**。无模糊阴影、无渐变、无毛玻璃；阴影是实心色块偏移。
4. **克制的灵动**。动效短（≤300ms）、少、有信息量；尊重 `prefers-reduced-motion`。
5. **信任感**。比价站的转化靠信任：披露联盟关系、标注数据更新时间、排序永远按价格。

---

## 2. 设计 Token（styles.css `:root`）

改风格 = 改 token。禁止在组件里写死颜色，新颜色必须先注册为 token。

### 2.1 基础色

| Token | 值 | 用途 |
|---|---|---|
| `--bg` | `#FBF3E0` | 页面底色（奶油纸） |
| `--bg-raised` | `#FFFDF6` | 头部导航底色 |
| `--surface` | `#FFFFFF` | 卡片/表格底色 |
| `--surface-2` | `#FFF1C9` | 表头、hover 底、次级面板 |
| `--ink` | `#292344` | **全局描边色 + 主文字色 + 页脚底色**（深紫墨色，整站唯一"黑"） |
| `--text-2` | `#6B6485` | 次级文字 |
| `--text-3` | `#9A93AE` | 弱化文字（meta、占位、划线价） |

### 2.2 糖果色（成对规则，重要）

每种语义色都是**一对**：`-bg` 结尾的是浅亮填充色（只做底色，上面必须放 `--ink` 文字）；不带后缀的是加深的文字安全色（只做文字/描边，可直接用在白/奶油底上）。**禁止把 `-bg` 色当文字色用，禁止把文字色当大面积填充用。**

| 语义 | 填充（-bg） | 文字安全色 | 什么时候用 |
|---|---|---|---|
| 折扣/省钱/免费 | `--green-bg` `#7DE8A9` | `--green` `#1FA45B` | 折扣徽章底、省钱筹码底；绿色文字 |
| 史低/最佳/荣耀 | `--gold-bg` `#FFD84D` | `--gold` `#A87400` | ATL 徽章、BEST 标签、主按钮底、榜首排名文字 |
| 紧迫/激活/强调 | `--red-bg` `#FF8A80` | `--red` `#E8433F` | 倒计时文字、导航激活下划线、热榜表头底、CTA 文字链 |
| 区域/信息/好评 | `--teal-bg` `#52DCCB` | `--teal` `#0FA396` | 区域榜表头、平台胶囊底、好评率文字 |
| 品牌天空 | `--sky` `#63B8F6` | —（无文字版） | 首屏 hero 背景、装饰色块 |
| 点缀粉 | `--pink-bg` `#FF8FC0` | —（无文字版） | 占位封面等纯装饰 |

语义硬规则：**金色是全站唯一的"荣耀色"，只给史低/最佳相关**；绿色只表示"省钱"；红色只表示"紧迫或当前位置"，不表示错误以外随意用途。

### 2.3 字体

| Token | 字体 | 允许的用途（白名单） |
|---|---|---|
| `--font-pixel` | Press Start 2P | Logo、hero 大标题、区块标题（h2，全大写）、页面 H1（全大写）、徽章文字（ATL/WAIT/FREE/BEST/标签，7–11px）、排行榜表头、筛选组小标题、`.re-arrow` 箭头。**禁止用于：正文、表格数据、按钮文字、任何超过一行的文本** |
| `--font-body` | Nunito（400/600/700/800） | 正文、按钮、导航、表格、筛选器——默认字体 |
| `--font-mono` | JetBrains Mono（500–700） | 所有价格、百分比、倒计时、排名数字、URL 提示——**数字必须等宽** |

像素字体排版规则：一律 `text-transform: uppercase`（或直接写大写文案）；字号 7–13px 用于标签、22–38px 用于大标题，中间字号避免使用；`line-height ≥ 1.5`。

### 2.4 形状与阴影

| Token | 值 | 用法 |
|---|---|---|
| 描边 | `2px / 2.5px / 3px solid var(--ink)` | 小徽章 2px；小控件 2.5px；卡片/表格/输入框 3px |
| `--radius` | `6px` | 按钮、输入框、小卡 |
| `--radius-lg` | `10px` | 大卡片、表格、面板 |
| `--shadow-sm` | `2px 2px 0 var(--ink)` | 小控件、徽章 |
| `--shadow` | `4px 4px 0 var(--ink)` | 标准卡片 |
| `--shadow-lg` | `6px 6px 0 var(--ink)` | hover 抬升态 |

**交互位移模式（全站统一手感）**：hover = `translate(-2px,-2px)` + 阴影升一档（"弹起"）；active = `translate(1px,1px)` + 阴影降到 sm 以下（"按扁"）；transition `0.12–0.15s`。小控件用 ±1px。

---

## 3. 组件规范

### 3.1 头部导航（.site-header）

- sticky 顶部，`--bg-raised` 底 + 3px 墨色下边框。
- 结构与顺序（三页一致）：`logo → header-search → main-nav（Home/Steam/Nintendo）→ region-btn`。
- **导航整体右锚定**；激活态 = 文字 `--ink` + 底部 4px 红色实心条（`::after`），**绝不做成带边框阴影的"按钮"样子**——带边框阴影的只有真正的操作控件（如 US·USD）。
- 下拉菜单：白底 3px 墨边 + 硬阴影，项 hover 换 `--surface-2` 底；每项右侧用 mono 小字展示真实 URL 路径（`.hint`），这是给用户和维护者的路由自文档。
- 导航不放：Topics（在页脚）、New releases（在 Steam/Nintendo 下拉内）、登录（无账户体系，数据存本地）。
- **搜索框停靠（仅首页）**：首页头部搜索框带 `.dock` 类默认 `display:none`；滚动越过首屏大搜索框（`bottom < 70px`）时加 `.show` 出现，回滚收起。DOM 上搜索框位于 nav 之前，配合 `.header-search { margin-left:auto }` + `.header-search.dock:not(.show) + .main-nav { margin-left:auto }`，保证出现/消失时右侧导航项**像素级零位移**。子页面搜索框无 `.dock`，常驻。滚动监听用 scroll 事件 + 300ms 轮询兜底（内嵌预览环境的 IntersectionObserver/rAF 不可靠；接框架后可换 IO）。

### 3.2 按钮三档

| 档 | 类 | 样式 | 用途 |
|---|---|---|---|
| 主 | `.btn-primary` | 金底 + 墨字 + 3px 墨边 + 硬阴影 | 每屏至多一个主动作（Set price alert 等） |
| 次 | `.btn-ghost` / `.region-btn` | 白底 + 墨字 + 墨边 + 硬阴影 | 次要操作 |
| 链 | `.live-cta` / `.view-all` / `.bh-more` | 红色加粗文字，hover 下划线 2px | 导流链接 |

### 3.3 卡片家族

- 通用配方：白底 + 3px 墨边 + `--radius-lg` + `--shadow` + hover 弹起。封面图内嵌时加 2–3px 墨色分隔边。
- `game-card`（网格卡）：封面 460/215 比例；ATL 时左上角贴金色像素徽章 `.atl-flag`。
- `deal-row`（列表行）：缩略图 + 标题/meta + 红色 mono 倒计时（固定宽度列）+ 价格组（绿色折扣筹码 → 划线原价 → mono 现价）。
- `board`（排行榜）：糖果色表头（teal=区域 / gold=史低 / red=热度）+ 像素字标题 + 3 行数据；榜首排名数字用 `--gold`。
- `live-card`（首屏实时卡）：结构固定为 封面头部 + 三行"图标方块 + 像素小标签 + 粗体数据"（CROSS-PLATFORM / BEST REGION / CURRENT DEAL）+ 红字 CTA。内容更新时加 `.pop` 类触发弹跳。
- `re-card`（区域入口卡）：图标方块 46px + 标题/描述/筹码 + 像素箭头。
- `verdict`（买/等判定）：金色双层阴影（`5px 5px 0 --gold-bg` 外加墨色描边层），WAIT/BUY 徽章用像素字，附 BETA 小标。
- `note-box`（提示框）：白底墨边 + 左侧 10px teal 色条，RPG 对话框气质；用于合规提示、数据说明。

### 3.4 徽章与筹码

- `chip-off`（折扣）：绿底墨字 mono，`−N%` 格式（注意是 U+2212 −，不是连字符）。
- `badge-atl` / `.atl-flag` / `.b-chip.y`（史低类）：金底墨字，像素字 7–8px 或 mono。
- `.b-chip.g`（省钱筹码）：绿底 mono，如 `−39% ZA`（区域用 ISO 两字码）。
- `plat-pill`（平台）：teal 底墨字。`tag`（类型标签）：灰调底弱描边，唯一允许的低对比装饰件。

### 3.5 表格（price-table / region-full）

外框 3px 墨边 + 大圆角 + 硬阴影；表头 `--surface-2` 底、11px/800/大写/宽字距（Nunito 而非像素字）；行分隔 `2px solid #F0E9D6`；行 hover `#FFFBEE`；最优行绿色浅底 `#EAF9EE` + BEST 像素徽章。价格列一律 mono。

### 3.6 首屏（hero v2）

天空蓝背景 + 像素白云（inline SVG rect 组，`shape-rendering: crispEdges`，`z-index:0` 永远垫底）+ 底部砖块地面条（repeating-linear-gradient，上下 4px 墨边）。
左列：像素大标题（白字 + 4px 墨色投影）→ 一句话 lede → 打字机搜索框 → live-card。
右列：三块 board。
打字机参数：录入 62ms/字，完成后光标 `█` 闪烁 5 拍 × 460ms，删除 26ms/字，间隔 260ms；游戏数据在 index.html 底部 `games` 数组中维护；聚焦即暂停并恢复正常 placeholder，失焦且为空时续播；`prefers-reduced-motion` 时退化为整名 4.2s 轮换。

### 3.7 页脚

墨色底反白：链接 `#B9B3CE` hover 白；栏目标题金色像素字 9px。栏目：品牌+信任声明 / Steam / Nintendo / Topics / DealDex。信任声明三要素不可删：只收白名单商店、联盟披露、按价格排序。

---

## 4. 图标

- 只用 **inline SVG 描边图标**（lucide 风格）：`viewBox="0 0 24 24"`、`fill="none"`、`stroke-width 2–2.5`、round cap/join，颜色继承 `currentColor` 或显式 `var(--ink)`。
- **禁止 emoji 做图标**；禁止引入图标字体/外部图标库。
- 图标方块容器（`.s-icon` / `.live-ic` / `.re-ic`）：糖果底 + 墨边 + 小圆角，尺寸 28–46px。

## 5. 动效清单

| 名称 | 用途 | 时长 |
|---|---|---|
| hover/active 位移 | 所有可点卡片按钮 | 0.12–0.15s |
| `cardpop` | live-card 内容更新 | 0.28s |
| `blink` | LIVE 红点 | 1.1s steps(2) 循环 |
| `dockin` | 头部搜索框停靠出现 | 0.22s |

全局规则：`@media (prefers-reduced-motion: reduce)` 杀掉所有 transition/animation（已在 styles.css 末尾实现，新动效无需单独处理，但 JS 驱动的动画要自行判断 `matchMedia`）。

## 6. 布局与断点

- 容器 `--maxw: 1200px`，左右 padding 24px（`.wrap`）。
- 区块节奏：`.section` 上间距 36px；区块头 = 图标方块 + 像素 h2 + 右侧红色 view-all。
- `≤1024px`：hero 单列、榜单横排三列、卡片网格 2 列、筛选栏横排、导航隐藏（TODO：汉堡菜单未做）。
- `≤560px`：全部单列、头部搜索隐藏。

## 7. 可访问性底线

- `-bg` 糖果底上只放 `--ink` 文字；`--text-3` 不用于关键信息；`--gold` 已特意加深到可过 4.5:1。
- `:focus-visible` 全局 3px 红色 outline。
- 颜色不是唯一指示：折扣有 `−N%` 文字、史低有 ATL 字样、激活导航有下划线形状。
- 装饰性 SVG 加 `aria-hidden="true"`；封面图必须有具体 alt（游戏名）。

## 8. 文案与数据格式

- UI 语言英文；像素标题全大写，正文 sentence case。
- 价格 `$29.99`；折扣 `−50%`（U+2212）；区域两字码（ZA/BR/TR）；倒计时 `1d 04h left`；相对史低 `−$3.00 vs ATL`。
- 封面图：Steam CDN `cdn.cloudflare.steamstatic.com/steam/apps/{appid}/header.jpg`；该域 301 时改用 `shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg`（黑神话曾踩坑）。无封面（未发售等）用糖果纯色块 + 像素缩写（见 Coming this month）。生产环境需自建图片代理/缓存。

## 9. 文件结构与修改指南

```
demo/
  index.html        首页（hero v2 + 打字机 JS + 搜索停靠 JS，数据在底部 games 数组）
  deals.html        折扣列表页（筛选布局模板）
  game.html         游戏详情页（Tab=真实子路由的原型；图表为 inline SVG）
  assets/styles.css 唯一样式文件；顶部 :root 为 token 区
design.md           本文档
```

- 改全局观感 → 只动 `:root` token。
- 新增组件 → 复用"墨边 + 硬阴影 + hover 弹起"三件套，禁止发明新阴影/新圆角值。
- 新增语义色 → 必须成对注册（`-bg` + 文字安全色）并在 §2.2 表格补一行。
- 详情页 Tab 是"视觉 Tab、结构独立 URL"的原型（hover 显示目标路径），实装时每个 Tab 是服务端独立页面，子页放主页没有的全量内容以规避薄重复。

## 10. 禁止清单（Do NOT）

1. 像素字体写正文/表格/按钮文字。
2. emoji 当图标；引入图标库/图标字体。
3. 模糊阴影（box-shadow 带 blur）、渐变按钮、毛玻璃。（唯一现存渐变 = 砖块地面/占位封面这类"像素贴图"用途）
4. `-bg` 糖果色当文字色；金色用于"史低/最佳"以外的含义。
5. 导航激活态做成按钮样式（描边+阴影）。
6. 写死颜色 hex 到组件（token 之外）。
7. 灰色 key 市场（G2A/Kinguin 类）出现在商店列表——这是产品信任策略，不只是设计规范。
