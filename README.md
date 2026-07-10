# GamePriceMap

> **接手维护先读 [docs/HANDOFF.md](docs/HANDOFF.md)**（状态快照 / 代码地图 / 不可破坏约定）。

多平台游戏折扣聚合站：Steam + Nintendo eShop 区域定价、史低、促销、免费游戏与新游日历。

- **线上**：https://gamepricemap.pages.dev
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
| `site/` | Astro 5 静态站（139 页） |
| `.github/workflows/` | daily.yml / weekly.yml 数据管线 |

## 必读文档

1. **[docs/HANDOFF.md](docs/HANDOFF.md)** — 当前状态快照、代码地图、不可破坏约定、遗留清单（接手先读这个）
2. [docs/plans/2026-07-07-dealdex-v1-plan.md](docs/plans/2026-07-07-dealdex-v1-plan.md) — 架构方案与端点实测记录
3. [design.md](design.md) — UI 设计规范（约束性）
4. [tasks/todo.md](tasks/todo.md) / [tasks/lessons.md](tasks/lessons.md) — 执行记录与踩坑教训
