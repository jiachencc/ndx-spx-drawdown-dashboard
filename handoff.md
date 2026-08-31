# NDX / SPX 指数回撤决策看板 — 交接说明

> 用途：本文件 + `index.html` + `positions.html` + `data.js` 构成完整交接包。新窗口/新任务直接读这四份即可继续干活，无需翻历史对话。
> 看板性质：个人投资决策辅助单页（深色金融终端风，已支持浅色主题一键切换）。**不构成投资建议。**

---

## 1. 当前状态

| 项 | 值 |
|---|---|
| 版本 | **v6.7**（截至 2026-08-28；v6.6→v6.7 变更：新增持仓水位页 positions.html、字体提取为共享 font.css；持仓页后续迭代：买入位置分布、日志折叠+筛选、成本位/现价点击弹窗） |
| 托管方式 | **GitHub Pages**（静态托管） |
| 远程仓库 | `https://github.com/jiachencc/ndx-spx-drawdown-dashboard.git` |
| 在线地址 | **https://jiachencc.github.io/ndx-spx-drawdown-dashboard/** |
| 本地文件 | `index.html`（~100KB）+ `positions.html`（~40KB）+ `data.js`（数据层，~40KB）+ `font.css`（共享字体，~56KB），日常维护只改 data.js |

---

## 2. 文件清单

```
ndx_spx_dashboard_handoff/
├── handoff.md      ← 本文件（交接 + 部署指南）
├── index.html      ← 看板本体：结构 + CSS + 渲染逻辑（GitHub Pages 入口）
├── positions.html  ← 持仓水位页：成本位置视角 + 操作日志（从看板页头「💼 持仓」进入）
├── font.css        ← JetBrains Mono @font-face（base64 内嵌），index/positions 两页共享
├── data.js         ← 数据层：DEFAULT / MONTHLY / DCA_NDX / DCA_SPX / CALENDAR / POSITIONS，每日更新只改此文件
├── scripts/
│   └── fetch_and_update.mjs   ← AUTO 区抓数脚本（见 §3.3）
└── .github/workflows/
    └── update-data.yml        ← 每日定时触发上面的脚本
```

---

## 3. 核心约定（改数据前必读，避免破坏模型）

### 3.1 数据源与口径
- **NDX / SPX**：脚本直接抓 Yahoo **^NDX / ^GSPC 官方指数**日线（不再用 QQQ/SPY 代理推导），自动重算 MA50/MA200/RSI/52周低/ATH（含 `athDate` 历史高点日期）。
- **年内最大回撤 `ddYtd`**：脚本从 10 年日 K 取当年收盘序列，按运行高点算最大跌幅（收盘口径，与 prevYr/月度涨跌幅一致），随行情每日自动更新。
- **宏观指标**：VIX / 恐贪 FG / 美债 TNX·TNX2 / 人民币 FX 由 Actions 每日自动更新。**估值（peFwd/peTtm/cape/pePct + NDX 的 ndxPeFwd/ndxPePct）与 putcall 也已自动化**（2026-08 起）：估值取自 historyofmarket.com 开放 JSON（CC BY 4.0，`/api/sp500/forward-pe.json` + `/api/sp500/pe.json` + `/api/ndx/forward-pe.json`）；Put/Call 抓取 CBOE 公开每日统计页的 TOTAL PUT/CALL RATIO。`pePct` 口径 = 当前远期 PE 在 1990 年以来全部周度读数中的百分位；`ndxPePct` 口径同法但样本自 2001 年起（NDX 远期PE 数据起点）。CAPE 源为周频，日更时数值不变属正常。抓取失败时脚本自动保留旧值，不报错。
- **仍需人工维护**：`epsGrowth`（无免费源）与 `CALENDAR`（编辑性内容）。
- **定投回测**：`DCA_NDX` / `DCA_SPX` 各 **2517 点**（2016–2026 每日定投 1 元），仅展示累计收益率与一次性买入对比，不产生买卖信号。区间表含近1月/3月/半年/1年/全周期五档（窗口按交易日 21/63/126/252 近似切片）。
- **决策矩阵口径（2026-08-28 校准，基于 10 年日K回测）**：回撤矩阵的历史频率/胜率 = NDX 2016-2026 独立下跌段、触发后 60 个交易日窗口（-5% 约5次/年·胜率82%；-15% 4段；-25% 2段全胜；-35% 1次）。止盈阈值依据：T+1 用 YTD +18%（NDX 年均涨幅约 18%，15% 会常年触发停大额；YTD+15~20% 后 60 日胜率 89% 故只停加码不卖出）；T+2 用 YTD +22%（YTD 首破 +20% 后 20 日胜率仅 38%，是全矩阵唯一有本数据回测支撑的减仓信号）；决策依据确认条件 VIX 阈值用 25（20 在正常波动区间、常年命中无区分度）。卡片上的历史统计是固定文案（历史分布不随每日行情变化），状态联动由 JS 实时计算。

### 3.2 数据模型
字段结构以 **`data.js` 为唯一事实源**（自带注释，本身就是 schema），本文件不复抄字段清单以免漂移。仅记录两条**无法从代码读出**的红线：
- **纪律**：`-15%` 为 DCA 重手加仓触发线（同时是 HBM/DRAM 主题 DCA 条件）；`-25%` 重仓低吸、`-35%` 历史级机会。
- `thresholds` 与触发器矩阵（`renderTriggers`）强耦合，改阈值需同步核对文案。

### 3.3 数据更新（2026-08-27 起自动化）
**AUTO 区**由 GitHub Actions 自动刷新：[scripts/fetch_and_update.mjs](scripts/fetch_and_update.mjs) 抓 Yahoo/Frankfurter/CNN/CBOE/historyofmarket，每个交易日收盘后（UTC 21:47）跑 [.github/workflows/update-data.yml](.github/workflows/update-data.yml)，自动重算 MA50/MA200/RSI/52周低/ATH 并提交。GitHub 定时任务可能延迟数小时，脚本有 `intraday` 判断兜底，晚跑数据仍正确。失败保留旧值；盘中手动触发会如实标 `intraday: true`。宏观已随行情同步时 `macroAsOf` 自动置 null。

**人工只需维护 MANUAL 区三件事**：
1. `epsGrowth`（盈利增速预期）——无免费 API，按你的信息源数日一更。
2. `CALENDAR`（事件日历）——删除已过期事件、补充未来 1-2 周关键事件（名称可标"预计"，写一句决策向解读）。
3. `POSITIONS`（持仓）——买卖后更新 `hold` 的 qty/cost/idxAtCost，并在 `log` 顶部加一条流水（新流水带 `idxAt` 当日指数点位，供买入位置分布图用）；只记份数与成本价，不记金额/账户（隐私模糊化）。`strategy` 的 dip/rally 日内操作线（%）一般不动，调整属策略变更。展示由 positions.html 自动计算。

~~每月月初补 MONTHLY~~ 已自动化：月度涨跌幅由脚本按日 K 聚合（月末收盘环比，当月为至今），无需手改。

兜底：Actions 长期红叉时回到手动流程——改上述 AUTO 字段并推送；本机直连数据源会被反爬拦截，改用查网页人工填数即可。

> **数据/结构分离**：index.html 不再包含任何行情数据；卡片初值用 `--` 占位符，`renderAll()` 启动时从 `DEFAULT` 填充。日常维护只碰 `data.js`，避免误改渲染逻辑。

### 3.4 `asOf` 数据时间条
页头下方时间条由 `us / et / local` 三个字符串组成（美股交易日 / 美东数据时刻 / 本地更新时间），页面渲染为一行：`🕐 更新于 08-28 13:33 · 美股 08-27 收盘`（`intraday` 为 true 时显示「盘中（截至 14:32 EDT）」）。`et` 为脚本抓取时的美东时刻（盘中=抓取时间，收盘=16:00），仅盘中时展示。宏观快照行（`macroAsOf` 非空时）自动出现，同步后隐藏。更新时**照抄 data.js 上一次的格式改数字即可**，`et` 的时区缩写（EDT/EST）随夏令时切换：每年 **3 月第二个周日 → 11 月第一个周日**为夏令时。

---

## 4. 架构速览（改样式/逻辑时参考）

### 4.1 主题系统
- 全部配色走 CSS 变量，定义在 `:root`。
- **浅色主题** = `body.light` 类覆盖同一批变量（白底卡片、深蓝灰文字、降饱和红绿）。
- 切换按钮：`#theme-toggle`（页头右上角），文案 `🌙 切浅色` / `☀️ 切深色`。
- 偏好存储：`localStorage` 键 **`wb_ndxspx_theme`**（`"light"` / `"dark"`）。键名 `wb_` 前缀为 Workbuddy 时代遗留，改键会使老用户主题偏好重置，无实际必要不动它。
- 初始化：`initTheme()` 读存储并 `applyTheme()`；切换时重绘 `drawScale`（手绘 SVG 按 `body.light` 选色，否则白底白线看不见）。
- **改色只需动 `:root` 与 `body.light` 两组变量**，别在组件里硬编码（少数 SVG/标题渐变/hint-pop 气泡有专门覆盖规则，搜索 `body.light` 即可定位）。

### 4.2 视觉层级与布局规则
- **视觉层级** `.card-hi` / `.card-lo`：决策级卡（触发矩阵、决策依据、止盈、DCA 回测）用 `.card-hi` 强化边框阴影引导优先阅读；背景级卡（事件日历）用 `.card-lo` 降饱和缩小。加在 `<div class="card">` 上即可，无 JS 依赖。
- **布局对齐铁律**：`.grid > .card + .card { margin-top: 0 }` —— grid 内卡片间距一律由 `gap: 18px` 控制，不要给 grid 直接子卡片加 margin（会破坏同行 stretch 等高对齐）；纵向堆叠区块间分隔仍走 `.card + .card` 的 margin-top。
- **数字排版**：数字统一 JetBrains Mono（可变字重 woff2 以 base64 内嵌于共享 `font.css`，latin 子集约 40KB，index/positions 两页共用浏览器缓存，零外链；大号展示数字与数据小字同源，仅字号/字重分层）。body 已启用 `font-feature-settings: "tnum"`，多列数据自动对齐。新组件数字直接用 `var(--mono)` 即可，勿再新增字体栈。
- **grid 溢出防御**：`.grid > .card { min-width: 0 }` —— grid item 默认 `min-width: auto` 会被内容 min-content 撑破列宽，导致窄屏（≤440px 手机）横向溢出。新增 grid 容器时沿用此规则。

### 4.3 关键 JS 入口
渲染总入口为 `renderAll()`（index.html），各区块渲染函数统一按 `renderXxx()` 命名，工具函数集中在文件顶部。`drawScale` 是唯一由 JS 动态生成的 SVG（主题切换时需重绘）。新增区块请沿用此命名约定，勿在文档中罗列函数清单——以代码为准以免漂移。

### 4.4 铁律（继承自查错经验）
- **零外部依赖**：不引任何外部框架/CDN/字体/图表库，图表手写 SVG，图标手写 SVG path，不用 emoji 当图标。仓库内本地引用仅允许 `data.js`（脚本）与 `font.css`（共享字体）。
  > **为什么保留**：GitHub Pages 已不强制此条，但它仍是本项目的有意设计——① 国内访问第三方 CDN 不稳定，外链易白屏；② 本看板含个人持仓信息，每次外链请求都会向第三方暴露访问时间与 IP；③ 无依赖即无升级与供应链风险。若未来确需引入外部库，先评估这三点。
- **入场动画**：区块 `riseIn` 渐入 + `.card-hi::after` 金色分割线扫光；`prefers-reduced-motion` 下自动关闭。注意 `.card-hi` 需保持 `position: relative`。
- 字体：中文/正文走系统字体栈，数字走内嵌 JetBrains Mono（见 4.2）；货币用 `¥`、红跌绿涨（国内习惯）。
- 已知例外：主题切换按钮暂用 🌙/☀️ 文本符号（非 SVG 图标），属可接受妥协，其余功能性图标一律手写 SVG path。

### 4.5 持仓页（positions.html）约定
- **隐私红线**：只记份数与成本价，不记账户金额；金额展示模糊到「万」一位小数。
- **成本位置分位** = (成本 − 52周低) / (ATH − 52周低)；三档标签按四舍五入后的整数分位判定：<35% 低 / 35–65% 中 / >65% 高，保证显示与档位一致。
- **口径措辞**：统一用「成本/成本位/现价」，不用「建仓时/建仓」（log 是合并的历史快照，非真实建仓日）；log 中 `act:"建仓"` 仅作为操作类型保留。
- **弹窗定位与去重原则**：52周尺轨道整体可点击（点轨道吸附最近标记弹出解读）。弹窗是「解读层」——只放卡片上没有或需展开的解读（距 52 周低缓冲、成本距高点、浮盈垫/回本提示、操作建议），不重复堆砌卡片已直接展示的数字（如今日涨跌）；新增弹窗字段前先自查卡片是否已有。
- **买入位置分布**：绿点按当日 `idxAt` 落位，点大小 ∝ 份数，点击弹出明细气泡。
- 操作日志默认折叠 3 条，标题下「全部/纳指/标普」筛选 chips 按流水条数动态生成（基于 `hold` 的 `idx` 字段映射，非硬编码 sym）。

---

## 5. 部署指南（发布到 GitHub Pages）

### 5.1 本地预览
```bash
cd ndx_spx_dashboard_handoff
python3 -m http.server 8765
# 浏览器打开 http://localhost:8765/index.html
```

### 5.2 发布（git push 即部署）
```bash
cd <本地仓库目录>
git add index.html positions.html data.js   # 按实际改动添加；日常更新动的是 data.js，别漏
git commit -m "data: 更新至 YYYY-MM-DD 收盘"
git push origin main
```
- 推送后 GitHub Pages 自动构建，通常 **1-3 分钟**内生效。
- Pages 配置（一次性）：仓库 **Settings → Pages → Source 选 `Deploy from a branch`，Branch 选 `main` / `(root)`**，保存即可。

### 5.3 验证发布成功
```bash
curl -s "https://jiachencc.github.io/ndx-spx-drawdown-dashboard/?t=$(date +%s)" \
  | grep -o 'id="theme-toggle"\|body.light\|打开在线最新版'
```
- 加 `?t=` 时间戳参数绕过 CDN 缓存；浏览器强刷可用 Cmd+Shift+R。
- 若线上未更新，先确认 Pages 构建记录（仓库 Actions 页）是否成功。

---

## 6. 已知限制 & 待办

- [x] ~~宏观指标过期~~：VIX/美债/汇率/恐贪已由 Actions 每日自动更新。
- [x] ~~估值五项与 putcall 手动~~：已自动化（2026-08 起，见 §3.1）。
- [x] ~~NDX 滞后 1 天~~：脚本现在直接抓 ^NDX / ^GSPC 官方指数，不再 QQQ 推导。
- [x] ~~MONTHLY 无提醒机制~~：月度涨跌幅已由脚本按日 K 自动聚合（2026-08-28 起），不再是人工项。
- [ ] **监控 Actions 健康度**：偶尔瞄一眼仓库 Actions 页 `update-data` 是否绿；连续红叉按 §3.3 兜底流程转人工。
- [ ] 可选优化：降低首屏信息密度。

---

## 7. 重新开干 · 检查清单
1. 读 `handoff.md`（本文件）确认约定与部署命令。
2. 改数据 → 只编辑 `data.js`；改结构/样式/逻辑 → 编辑 `index.html`（持仓页改 `positions.html`）。
3. 改完按第 5.2 节 `git push` 发布。
4. 用第 5.3 节 curl 验证关键特性已上线。
