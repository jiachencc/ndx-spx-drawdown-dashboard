# NDX / SPX 指数回撤决策看板 — 交接说明

> 用途：本文件 + 仓库根目录 `index.html` 构成完整交接包。新窗口/新任务直接读这两份即可继续干活，无需翻历史对话。
> 看板性质：个人投资决策辅助单页（深色金融终端风，已支持浅色主题一键切换）。**不构成投资建议。**

---

## 1. 当前状态

| 项 | 值 |
|---|---|
| 版本 | **v6.5**（截至 2026-08-27） |
| 托管方式 | **GitHub Pages**（静态托管） |
| 远程仓库 | `https://github.com/jiachencc/ndx-spx-drawdown-dashboard.git` |
| 在线地址 | **https://jiachencc.github.io/ndx-spx-drawdown-dashboard/** |
| 本地文件 | `ndx_spx_dashboard_handoff/index.html`（约120KB，全内联零外链） |

---

## 2. 文件清单

```
ndx_spx_dashboard_handoff/
├── handoff.md      ← 本文件（交接 + 部署指南）
└── index.html      ← 看板本体（仓库根目录同名文件，GitHub Pages 入口）
```

---

## 3. 核心约定（改数据前必读，避免破坏模型）

### 3.1 数据源与口径
- **NDX（纳斯达克100）**：Nasdaq 日线 API 有 **1 天滞后**，`DEFAULT.ndx` 最新真实值仅到前一交易日；**当日值用 QQQ ETF 涨跌幅推导**（误差 < 0.02%）。
- **SPX（标普500）**：用 **SPY ETF 真实收盘 ×10** 作代理（SPY 与 SPX 点位比 ≈ 10:1）。
- **宏观指标**（VIX / 恐贪 FG / 美债 TNX·TNX2 / 人民币 FX / 估值 PE·CAPE）：**沿用快照数据**，无实时源，更新需人工替换数值。
- **定投回测**：`DCA_NDX` / `DCA_SPX` 数组长度 **2517**，含义为 2016–2026 每日定投 1 元，展示当前累计收益率并与一次性买入对比（仅展示，不做买卖信号）。

### 3.2 数据模型（`DEFAULT` 对象结构）
```js
const DEFAULT = {
  date: "2026-08-26",
  intraday: false,                 // true=盘中快照(显示"美股盘中"chip)，false=收盘
  ndx: { close, ath, days, chg, ma50, ma200, rsi, low52, prevYr },
  spx: { close, ath, days, chg, ma50, ma200, rsi, low52, prevYr },
  vix, fg, tnx, tnx2, putcall, fx, peFwd, peTtm, cape, pePct, epsGrowth,
  asOf: { us, et, cn, tz, local }, // 时区换算显示条（见 3.4）
  thresholds: { t1:-5, t2:-15, t3:-25, t4:-35 }  // 回撤四档触发线
};
```
- **纪律**：`-15%` 为 DCA 重手加仓触发线（同时是 HBM/DRAM 主题 DCA 条件）；`-25%` 重仓低吸、`-35%` 历史级机会。
- `thresholds` 与触发器矩阵（`renderTriggers`）强耦合，改阈值需同步核对文案。

### 3.3 更新行情的标准动作
1. 改 `DEFAULT.ndx` / `DEFAULT.spx` 的 `close/ath/days/chg/ma50/ma200/rsi/low52/prevYr`。
2. 如需刷新宏观，直接替换 `vix/fg/tnx/...` 数值（记得在页脚/asOf 注明快照日期）。
3. 同步更新 `asOf` 四字段（见下）。
4. 更新 `CALENDAR` 数组（去掉已过期事件、补未来 1-2 周新事件，如 FOMC/CPI/非农/财报季）。位于 `renderCalendar` 函数定义之前，搜索 `const CALENDAR =` 定位。
5. 提交并推送（见第 5 节），Pages 自动重新部署。

> **HTML 卡片静态值**：v6.5+ 起，所有"会被 JS 覆盖"的卡片初值已改为 `--` 占位符，无需手动同步 HTML 中的具体数值——只改 `DEFAULT` 即可，`renderAll()` 会自动填充。若新增字段，初值也用 `--`，避免"双数据源不一致"。

### 3.4 `asOf` 时区显示条（用户重点特性）
页头下方「美股时区换算」条，让用户一眼看出数据对应美股什么时间：
- `us`：美股交易日（如 `2026-08-26`）
- `et`：美东收盘时刻（夏令时恒为 `16:00 EDT`，冬令时 `15:00 EST`）
- `cn`：对应北京时间 = 美东日期 +1 天、时刻 +12h（夏令时）/ +13h（冬令时）→ 如 `2026-08-27 04:00`
- `tz`：时区标注（`夏令时(EDT·UTC-4)` 或 `冬令时(EST·UTC-5)`）
- `local`：本地更新时间（如 `2026-08-27 10:20`）

> 北京时差规则：夏令时美东比北京慢 12h，冬令时慢 13h。每年 3 月第二个周日→11 月第一个周日为夏令时。

---

## 4. 架构速览（改样式/逻辑时参考）

### 4.1 主题系统（v6.5 新增）
- 全部配色走 CSS 变量，定义在 `:root`。
- **浅色主题** = `body.light` 类覆盖同一批变量（白底卡片、深蓝灰文字、降饱和红绿）。
- 切换按钮：`#theme-toggle`（页头右上角），文案 `🌙 切浅色` / `☀️ 切深色`。
- 偏好存储：`localStorage` 键 **`wb_ndxspx_theme`**（`"light"` / `"dark"`）。
- 初始化：`initTheme()` 读存储并 `applyTheme()`；切换时重绘 `drawScale`（手绘 SVG 按 `body.light` 选色，否则白底白线看不见）。
- **改色只需动 `:root` 与 `body.light` 两组变量**，别在组件里硬编码（少数 SVG/标题渐变/hint-pop 气泡有专门覆盖规则，搜索 `body.light` 即可定位）。
- **视觉层级** `.card-hi` / `.card-lo`（v6.5+）：
  - `.card-hi`：决策级卡片（触发矩阵、决策依据、止盈、DCA 回测），边框/阴影更强、背景微亮，引导用户优先看。
  - `.card-lo`：背景级卡片（未来事件日历），降饱和、缩小字号，作为参考而非决策焦点。
  - 加在 `<div class="card">` 上即可，无 JS 依赖。
- **布局对齐铁律**：`.grid > .card + .card { margin-top: 0 }` —— grid 内卡片间距一律由 `gap: 18px` 控制，不要给 grid 直接子卡片加 margin（会破坏同行 stretch 等高对齐）；纵向堆叠区块间分隔仍走 `.card + .card` 的 margin-top。

### 4.2 关键函数（JS）
| 函数 | 作用 |
|---|---|
| `renderIndexCard(p, idx, th)` | 渲染 NDX/SPX 指数卡（消除重复代码） |
| `drawScale(ndxDD, spxDD)` | 手绘回撤刻度 SVG（唯一内联 SVG，主题感知） |
| `ddOf / ytdOf / toAthOf / maDev` | 派生指标计算 |
| `ddColor(dd, th)` / `bandColor(v, r)` | 回撤三档 / 指标三档配色 |
| `renderTriggers / renderConds / renderTakeProfit` | 触发器 / 条件 / 止盈矩阵 |
| `renderDCA()` | 定投回测指标（含 toggle 交互） |
| `renderAsOf()` | 时区换算显示条 |
| `applyTheme(mode)` / `initTheme()` | 主题切换与初始化 |

### 4.3 铁律（继承自查错经验）
- **全内联零外链**：不引任何外部框架/CDN/字体/图表库，图表手写 SVG，图标手写 SVG path，不用 emoji 当图标。
- 字体走系统字体栈；货币用 `¥`、红跌绿涨（国内习惯）。

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
git add index.html
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

- [ ] **宏观指标过期**：VIX/恐贪/美债/汇率/估值仍为快照数据，需人工更新。
- [ ] **NDX 滞后 1 天**：靠 QQQ 推导（误差 <0.02%），非真实 NDX 收盘。
- [ ] 浅色主题下极个别写死颜色已覆盖（标题渐变、tag-black、SVG 标记点、hint-pop 气泡），如再发现白底白字按第 4.1 节补 `body.light` 覆盖即可。
- [ ] 设备目标：iQOO15 / iPad 2022 / Mac；移动端单列、按钮 ≥44px 已满足。
- [ ] 可选优化：降低首屏信息密度、金色分割线入场动画。

---

## 7. 重新开干 · 检查清单
1. 读 `handoff.md`（本文件）确认约定与部署命令。
2. 用 `index.html` 直接编辑（或本地预览核对）。
3. 改完按第 5.2 节 `git push` 发布。
4. 用第 5.3 节 curl 验证关键特性已上线。
5. 大改前先备份当前 html（复制一份带日期后缀），避免回退困难——git 历史本身也是回退保障。
