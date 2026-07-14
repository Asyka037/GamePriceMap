# GamePriceMap

多平台游戏折扣聚合站：Steam + Nintendo eShop 区域定价、史低、促销、免费游戏与新游日历。

- **线上**：https://gamepricemap.com
- **架构**：GitHub 仓库承载代码+数据（git 即数据库）→ Actions 定时抓取（每日/每周）→ 校验闸门 → Cloudflare Pages 静态站自动重建。运行时零服务器。

## 快速开始

```bash
npm test                                  # 单测（fixtures 驱动，零网络）
npm run scrape:steam && npm run history   # 实抓 + 历史演进
npm run validate                          # 数据闸门
cd site && npm install && npm run dev     # 本地站点 http://localhost:4321
```

## 目录

| 路径 | 说明 |
|---|---|
| `scripts/` | 抓取/校验/发现脚本（Node 22，零 npm 运行时依赖） |
| `data/` | 数据层：目录（人审）、快照、事件化历史、feeds、健康度 |
| `site/` | Astro 静态站 |
| `.github/workflows/` | daily.yml / weekly.yml 数据管线 |

## 数据治理

`data/catalog.json` 是人工审核的游戏目录。发现脚本只会生成 `data/suggestions/` 候选，不会自动把游戏加入生产目录；价格快照只保存商店返回的本币原始观测，USD 换算和排名在构建期派生。
