# Lessons

## 2026-07-08
- 即使计划写着"今天实测"，执行前仍按当前日期重新核验关键外部端点、免费额度和返回字段；外部商店 API、折扣数量和平台限额都是易变事实。
- 不要把参考项目的 `validate-data.mjs` 等同于生产校验闸门；参考实现只证明数据形状可读，正式管线还需要价格范围、折扣范围、区域覆盖率、汇率换算和失败保旧数据等断言。
- CheapShark 会拒绝通用 User-Agent；后续所有抓取脚本必须统一使用项目级 HTTP helper 注入真实描述性 UA，避免某个脚本绕过公共 helper。
- 文档中的实时数量（如 Nintendo Europe 折扣条目数）只能作为核验样例，不应作为稳定验收标准。
- 记录外部端点行为时必须带上**触发条件和测试日期**，否则复核会产生假冲突：Steam appdetails 组合 filters 单 appid 是 200、批量 appids 是 400——"组合 filters 会 400"和"组合 filters 能用"都对了一半。复核他人的端点结论时，先还原对方的请求条件（单/批量、参数、UA）再下结论。
- CheapShark `cheapestPriceEver` 会把 Epic 限免等赠送记录当成 $0.00 史低返回；聚合器语义里"赠送"不等于"售价"，任何外部史低种子必须拒绝 ≤0 的值。发现方式：validate 闸门的 `atl>0` 断言在首日就拦住了两条脏数据——校验器先于直觉。
- NSUID 发现的两类真实错配：franchise 名是续作标题的前缀（"Hades" startsWith 匹配到 "HADES II"），标题匹配必须用精确相等而非 contains/startsWith；猜测的商品页 URL 会 200 重定向到通用商店页并携带无关游戏的 nsuid，必须校验最终 URL + 页面含目标标题 + 跨游戏 nsuid 去重。半自动发现管线里"宁可落空转人工，不可低置信度自动写入"。
- Nintendo price API 会返回多年未调的通胀遗留价（AR 区 2017 年 ARS 定价换算后 $0.12），属于"真实返回但经济上无意义"的数据；聚合层需要按中位数比例过滤离群区域，且过滤逻辑要做成带单测的纯函数。

## 2026-07-09
- Twitch 官方 OAuth 文档仍用 `http://localhost:3000` 举例，但当前开发者控制台注册表单会提示“重定向 URL 必须使用 HTTPS”；操作指引应以实时控制台校验为准，并说明文档滞后。DealDex 访问 IGDB 使用 Client Credentials，不发送 `redirect_uri`，因此可在注册表单填 `https://localhost` 作为未使用的占位地址；只有未来真正做用户 OAuth 登录时，才需要换成可访问且精确匹配的 HTTPS 回调。
- 构建期读文件不要用 fs + import.meta.url 相对路径：Astro/Vite 打包后模块位置改变，运行时才 ENOENT。构建期静态数据的通用形态是 ESM 数据模块（export default {...}），Node 测试与打包器都天然支持。
- 地理质心要取最大连通块而非全体格子：阿拉斯加把 US 全格质心拉到加拿大边界，视觉锚点类特征永远考虑离岛/飞地。
