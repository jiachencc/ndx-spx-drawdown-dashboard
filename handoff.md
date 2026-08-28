# NDX / SPX 指数回撤决策看板 — 交接说明

> 用途：本文件 + 仓库根目录 `index.html` 构成完整交接包。新窗口/新任务直接读这两份即可继续干活，无需翻历史对话。
> 看板性质：个人投资决策辅助单页（深色金融终端风，已支持浅色主题一键切换）。**不构成投资建议。**

---

## 1. 当前状态

| 项 | 值 |
|---|---|
| 版本 | **v6.6**（截至 2026-08-27；v6.5→v6.6 变更：数据层分离至 data.js、meta/favicon、入场动画） |
| 托管方式 | **GitHub Pages**（静态托管） |
| 远程仓库 | `https://github.com/jiachencc/ndx-spx-drawdown-dashboard.git` |
| 在线地址 | **https://jiachencc.github.io/ndx-spx-drawdown-dashboard/** |
| 本地文件 | `ndx_spx_dashboard_handoff/index.html`（~95KB）+ `data.js`（数据层，~35KB），除 data.js 外全内联零外链 |

---

## 2. 文件清单

```
ndx_spx_dashboard_handoff/
├── handoff.md      ← 本文件（交接 + 部署指南）
├── index.html      ← 看板本体：结构 + CSS + 渲染逻辑（GitHub Pages 入口）
└── data.js         ← 数据层：DEFAULT / MONTHLY / DCA_NDX / DCA_SPX / CALENDAR，每日更新只改此文件
```

---

## 3. 核心约定（改数据前必读，避免破坏模型）

### 3.1 数据源与口径
- **NDX（纳斯达克100）**：Nasdaq 日线 API 有 **1 天滞后**——`DEFAULT.ndx` 当日值用 **QQQ ETF 涨跌幅推导**（误差 < 0.02%），非官方收盘价。
- **SPX（标普500）**：用 **SPY ETF 真实收盘 ×10** 作代理（点位比 ≈ 10:1）。
- **宏观指标**：VIX / 恐贪 FG / 美债 TNX·TNX2 / Put/Call Ratio / 人民币 FX 由 Actions 每日自动更新；**估值五项（PE·CAPE·EPS 增速等）仍为人工快照**，无免费实时源，更新需手动替换数值。
- **定投回测**：`DCA_NDX` / `DCA_SPX` 各 **2517 点**（2016–2026 每日定投 1 元），仅展示累计收益率与一次性买入对比，不产生买卖信号。区间表含近1月/3月/半年/1年/全周期五档（窗口按交易日 21/63/126/252 近似切片）。

### 3.2 数据模型
字段结构以 **`data.js` 为唯一事实源**（自带注释，本身就是 schema），本文件不复抄字段清单以免漂移。仅记录两条**无法从代码读出**的红线：
- **纪律**：`-15%` 为 DCA 重手加仓触发线（同时是 HBM/DRAM 主题 DCA 条件）；`-25%` 重仓低吸、`-35%` 历史级机会。
- `thresholds` 与触发器矩阵（`renderTriggers`）强耦合，改阈值需同步核对文案。

### 3.3 数据更新（2026-08-27 起自动化）
**AUTO 区**由 GitHub Actions 自动刷新：[scripts/fetch_and_update.mjs](scripts/fetch_and_update.mjs) 抓 Yahoo/Frankfurter/CNN，每个交易日收盘后（UTC 21:30）跑 [.github/workflows/update-data.yml](.github/workflows/update-data.yml)，自动重算 MA50/MA200/RSI/52周低/ATH 并提交。失败保留旧值；盘中手动触发会如实标 `intraday: true`。宏观已随行情同步时 `macroAsOf` 自动置 null。

**人工只需维护 MANUAL 区两件事**：
1. `putcall` 与估值五项（`peFwd/peTtm/cape/pePct/epsGrowth`）——无免费 API，按你的信息源数日一更。
2. `CALENDAR` 日历——去旧补新（FOMC/CPI/非农/财报季），顺手检查 `macroAsOf` 是否被 Actions 正确重置。

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
- **数字排版**：body 已启用 `font-feature-settings: "tnum"` 等宽数字，KPI 表格与收益列自动对齐。新组件无需额外设置。

### 4.3 关键 JS 入口
渲染总入口为 `renderAll()`（index.html），各区块渲染函数统一按 `renderXxx()` 命名，工具函数集中在文件顶部。`drawScale` 是唯一由 JS 动态生成的 SVG（主题切换时需重绘）。新增区块请沿用此命名约定，勿在文档中罗列函数清单——以代码为准以免漂移。

### 4.4 铁律（继承自查错经验）
- **零外部依赖**：不引任何外部框架/CDN/字体/图表库，图表手写 SVG，图标手写 SVG path，不用 emoji 当图标。仓库内资源仅允许 `data.js` 一个本地脚本引用。
  > **为什么保留**：GitHub Pages 已不强制此条，但它仍是本项目的有意设计——① 国内访问第三方 CDN 不稳定，外链易白屏；② 本看板含个人持仓信息，每次外链请求都会向第三方暴露访问时间与 IP；③ 无依赖即无升级与供应链风险。若未来确需引入外部库，先评估这三点。
- **入场动画**：区块 `riseIn` 渐入 + `.card-hi::after` 金色分割线扫光；`prefers-reduced-motion` 下自动关闭。注意 `.card-hi` 需保持 `position: relative`。
- 字体走系统字体栈；货币用 `¥`、红跌绿涨（国内习惯）。
- 已知例外：主题切换按钮暂用 🌙/☀️ 文本符号（非 SVG 图标），属可接受妥协，其余功能性图标一律手写 SVG path。

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
git add index.html data.js   # 日常更新动的是 data.js，别漏
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

- [x] ~~宏观指标过期~~：VIX/美债/汇率/恐贪已由 Actions 每日自动更新（估值五项与 putcall 仍手动）。
- [x] ~~NDX 滞后 1 天~~：脚本现在直接抓 ^NDX / ^GSPC 官方指数，不再 QQQ 推导。
- [x] ~~MONTHLY 无提醒机制~~：月度涨跌幅已由脚本按日 K 自动聚合（2026-08-28 起），不再是人工项。
- [ ] **监控 Actions 健康度**：偶尔瞄一眼仓库 Actions 页 `update-data` 是否绿；连续红叉按 §3.3 兜底流程转人工。
- [ ] 浅色主题下极个别写死颜色已覆盖（标题渐变、tag-black、SVG 标记点、hint-pop 气泡），如再发现白底白字按第 4.1 节补 `body.light` 覆盖即可。
- [ ] 可选优化：降低首屏信息密度。

---

## 7. 重新开干 · 检查清单
1. 读 `handoff.md`（本文件）确认约定与部署命令。
2. 改数据 → 只编辑 `data.js`；改结构/样式/逻辑 → 编辑 `index.html`。
3. 改完按第 5.2 节 `git push` 发布。
4. 用第 5.3 节 curl 验证关键特性已上线。
