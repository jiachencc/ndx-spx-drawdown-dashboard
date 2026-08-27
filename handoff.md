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
- **宏观指标**（VIX / 恐贪 FG / 美债 TNX·TNX2 / Put/Call Ratio / 人民币 FX / 估值 PE·CAPE·EPS 增速）：**均为人工快照**，无实时源，更新需手动替换数值。
- **定投回测**：`DCA_NDX` / `DCA_SPX` 各 **2517 点**（2016–2026 每日定投 1 元），仅展示累计收益率与一次性买入对比，不产生买卖信号。

### 3.2 数据模型
字段结构以 **`data.js` 为唯一事实源**（自带注释，本身就是 schema），本文件不复抄字段清单以免漂移。仅记录两条**无法从代码读出**的红线：
- **纪律**：`-15%` 为 DCA 重手加仓触发线（同时是 HBM/DRAM 主题 DCA 条件）；`-25%` 重仓低吸、`-35%` 历史级机会。
- `thresholds` 与触发器矩阵（`renderTriggers`）强耦合，改阈值需同步核对文案。

### 3.3 更新行情的标准动作
1. 改 **`data.js`** 中 `DEFAULT.ndx` / `DEFAULT.spx` 的 `close/ath/days/chg/ma50/ma200/rsi/low52/prevYr`。
2. 如需刷新宏观，直接替换 `vix/fg/tnx/...` 数值（记得在页脚/asOf 注明快照日期）。
3. 同步更新 `asOf` 四字段与 `updatedAt`（见下）。
4. 更新 `CALENDAR` 数组（同样在 `data.js`：去掉已过期事件、补未来 1-2 周新事件，如 FOMC/CPI/非农/财报季）。
5. **每月月初**：补上月值到 `MONTHLY` 数组（含分红 ETF 总回报口径，QQQ 代理 NDX / SPY 代理 SPX），并按需调 `MC_MAX` 满刻度。⚠️ 无自动提醒机制，是已知维护盲区。
6. 提交并推送（见第 5 节），Pages 自动重新部署。

> **数据/结构分离**：index.html 不再包含任何行情数据；卡片初值用 `--` 占位符，`renderAll()` 启动时从 `DEFAULT` 填充。日常维护只碰 `data.js`，避免误改渲染逻辑。

### 3.4 `asOf` 时区换算
页头下方时区换算条由 `us / et / cn / tz / local` 五个字符串组成（美股交易日 / 美东收盘时刻 / 对应北京时间 / 时区标注 / 本地更新时间）。更新时**照抄 data.js 上一次的格式改数字即可**。唯一需记忆的规则：每年 **3 月第二个周日 → 11 月第一个周日**为夏令时（美东落后北京 12h），其余时间冬令时（落后 13h）。

---

## 4. 架构速览（改样式/逻辑时参考）

### 4.1 主题系统
- 全部配色走 CSS 变量，定义在 `:root`。
- **浅色主题** = `body.light` 类覆盖同一批变量（白底卡片、深蓝灰文字、降饱和红绿）。
- 切换按钮：`#theme-toggle`（页头右上角），文案 `🌙 切浅色` / `☀️ 切深色`。
- 偏好存储：`localStorage` 键 **`wb_ndxspx_theme`**（`"light"` / `"dark"`）。键名 `wb_` 前缀为 Workbuddy 时代遗留，改键会使老用户主题偏好重置，无实际必要不动它。
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
- **零外部依赖**：不引任何外部框架/CDN/字体/图表库，图表手写 SVG，图标手写 SVG path，不用 emoji 当图标。仓库内资源仅允许 `data.js` 一个本地脚本引用。
  > **为什么保留**：GitHub Pages 已不强制此条，但它仍是本项目的有意设计——① 国内访问第三方 CDN 不稳定，外链易白屏；② 本看板含个人持仓信息，每次外链请求都会向第三方暴露访问时间与 IP；③ 无依赖即无升级与供应链风险。若未来确需引入外部库，先评估这三点。
- **入场动画**：区块 `riseIn` 渐入 + `.card-hi::after` 金色分割线扫光；`prefers-reduced-motion` 下自动关闭。注意 `.card-hi` 需保持 `position: relative`。
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

- [ ] **宏观指标过期**：VIX/恐贪/美债/汇率/估值仍为快照数据，需人工更新。
- [ ] **NDX 滞后 1 天**：靠 QQQ 推导（误差 <0.02%），非真实 NDX 收盘。
- [ ] **MONTHLY 无提醒机制**：每月月初需人工补上月涨跌幅（见 §3.3 第 5 步）。
- [ ] 浅色主题下极个别写死颜色已覆盖（标题渐变、tag-black、SVG 标记点、hint-pop 气泡），如再发现白底白字按第 4.1 节补 `body.light` 覆盖即可。
- [ ] 可选优化：降低首屏信息密度。

---

## 7. 重新开干 · 检查清单
1. 读 `handoff.md`（本文件）确认约定与部署命令。
2. 改数据 → 只编辑 `data.js`；改结构/样式/逻辑 → 编辑 `index.html`。
3. 改完按第 5.2 节 `git push` 发布。
4. 用第 5.3 节 curl 验证关键特性已上线。
