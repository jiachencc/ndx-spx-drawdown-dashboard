# scripts/ 索引

> 为什么有这个文件：抓取**顺序**原来只写在 CI 的 yml 里、"谁会改仓库文件"没有任何集中说明 →
> 每次排查都要重新 grep。本文件就是那份缺失的清单（**改动脚本时请顺手更新它**）。

## 一、分类

| 类别 | 文件 | 说明 |
|---|---|---|
| **核心库**（不是入口） | `data-quality.mjs` | 被 8 个脚本 import：`readModel / validateModel / metrics / monthly / createRecorder / replaceConst / replaceMember / atomicWrite / auditFiles / isDate / autoBlockIssues / readPosLogic`。**改数据层读写一律经过它**（原子写 ＋ 审计）|
| **共享口径**（不是入口） | 根目录 `positions-logic.js` | 持仓页那三条判据的**唯一出处**（本期已同步 / 场外当日合计的有效集合 /「组合已到」的日期）：页面用 `<script src>` 直接调，脚本用 `readPosLogic()` 读同一份源码。**改口径只改这里** —— 2026-10-16 之前四处各写一份，一次更新漂出三套 ✗ |
| **主题**（深浅两套） | `tokens.css`（调色板）＋ `positions.css` 的 `:root`（深色基座）与 `body.light`（浅色覆盖） | 深色是基座、浅色是覆盖层，默认跟随系统。⚠ **`check-contrast` 只在令牌层做算术**，它读的就是这两处：`--up: var(--green)` 这类一层 `var()` 会被解析 ✓；令牌改名/搬家请同步它 ✗ |
| **抓取（会改仓库）** | `fetch_and_update.mjs` · `fetch-fees.mjs` · `sync-bench.mjs` · `alt-etf-backtest.mjs` · `refresh-otc.mjs` | 写 `data.js` / `positions-data.js` / `fed-cycle/fed-data.json`。失败时**保留旧值**，不污染已有行情 |
| **门禁（只读，失败即 exit≠0）** | `check-data.mjs` · `check-finance.mjs` · `check-fed.mjs` · `check-tokens.mjs` · **`check-contrast.mjs`** · `cross-check.mjs` · `dom-check.mjs` · `layout-check.mjs` · `lint.mjs` | `check-data` 会顺带跑 `cross-check` 的 `crossIssues` 与 `autoBlockIssues`；**`check-contrast` 纯算术、不依赖浏览器** —— 它读 `tokens.css` ＋ `positions.css` 的深浅两套令牌，按「文字 ≥4.5 · 图形 ≥3」判 ✓（2026-10-16 加，起因：主题基座是深色，而截图/layout-check 默认只跑浅色 ✗）；**`layout-check` 在 `verify-all` 里跑深浅两遍** ✓|
| **测试** | `test-dashboard.mjs` | `node --test` 合成数据回归（离线可跑） |
| **工具 / 产图** | `screenshot.mjs` · `apply-screenshot.mjs` · `typecheck.mjs` | `apply-screenshot` 把 App 截图转录成数据（**唯一的人工入口**）|

## 二、抓取顺序（与 `.github/workflows/update-data.yml` 一致）

```
node scripts/fetch_and_update.mjs      # ① 行情 / 快照派生（核心）
node scripts/fetch-fees.mjs            # ② 费率表（7 天阈值，未到就跳过）
node scripts/alt-etf-backtest.mjs      # ③ 标的替换回测
sh   fed-cycle/update.sh               # ④ 加息周期看板（fetch → build → verify）
node scripts/sync-bench.mjs            # ⑤ 补 BENCH（放 fed 之后：它拿不到在线序列时会读 fed 的日线兜底）
node scripts/refresh-otc.mjs           # ⑥ 场外净值区间 / 每笔申购日净值
node scripts/check-data.mjs            # ⑦ 最终审计
```
（2026-10-16 删掉原第 ⑥ 步 `fetch-nowcast.mjs`：页面上的「场外当日预估」模块下线，数据侧无消费者 ✓）

②③⑤ 在 CI 里是 `continue-on-error: true`（补不上只影响自己那一块，不阻断日更）。

## 三、五条隐式约定（加东西时必须遵守）

1. **写数据只能走 `atomicWrite()`**（`data-quality.mjs`）—— 写失败或校验失败时原文件不动。
2. **加数据断言走 `autoBlockIssues()`**（同上）—— 它是「数据门禁」的扩展点，`check-data` 会汇总输出。
3. **门禁脚本必须 `process.exit(非 0)`** —— 否则钩子与 `verify-all` 拦不住；静默通过等于没有门禁。
4. **页面与脚本共用的判据只能写在根目录 `positions-logic.js`**，两侧都从它读（页面 `<script src>`、脚本 `readPosLogic()`）；
   `cross-check` 的 ⑥ 会**去注释后**扫三个消费方，发现判据原文被抄回就判错 —— 加新判据请**先**加到这个文件里。
5. **给人看的输出一律写「名称（代码）」**（2026-10-16 起）：`apply-screenshot` 的改动日志 / 提示 / 报错 / 期注释
   都走 `labelOf(code)` ✓（例：`广发全球精选股票(QDII)人民币F（023402）`，而不是光一个 `023402`）。
   ⚠ **数据文件里仍只存代码**（它是主键、快照 items 的键也是它）—— 这条只管「人读的那一侧」✓；
   查不到名称时**只写代码、不猜** ✗。新加输出时请复用 `labelOf()`，别再直接拼 `f.code` ✗。

## 四、常用命令

```sh
node scripts/verify-all.mjs          # 一条命令跑全部门禁（钩子与 CI 都调它＝单一真源）
node scripts/verify-all.mjs --deep   # 追加 typecheck
node scripts/check-fed.mjs           # 只跑某一个门禁

# 安装提交前钩子（文件在仓库里，但 git 不会自动启用）
cp scripts/hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

## 五、新增东西怎么加

- **新增数据源**：写 `fetch-xxx.mjs`（import `data-quality.mjs`，用 `atomicWrite`），
  再加进 CI 的 `update-data.yml` 与本文件第二节的顺序表。
- **新增断言**：在 `data-quality.mjs` 的 `autoBlockIssues()` 里 push 一条 issue（附证据与建议）。
- **新增门禁**：写 `check-xxx.mjs`（exit≠0），**只改 `verify-all.mjs` 一处**即可被钩子与 CI 覆盖。
- **新增「页面与脚本共用」的判据**：加到根目录 `positions-logic.js`（纯函数、ES5 风格、不 import），
  并在 `positions.html` 加 `<script src>`、在 `scripts/lint.mjs` 的 `positions.inline` 拼接里按同样顺序补上
  —— 漏了后者＝门禁拼的运行时组合与浏览器不一致 ✗（2026-10-12 漏拼 finance-data.js 就踩过）。
- **`apply-screenshot.mjs` 门禁失败时**：完整输出会落到 `outputs/gate-*.log`（已 gitignore），失败信息里带路径 ✓；
  它的解析容两种格式 —— dom-check 的「✗ 描述」与 check-data 的「- 描述」。
