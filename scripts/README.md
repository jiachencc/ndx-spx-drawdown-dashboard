# scripts/ 索引

> 为什么有这个文件：抓取**顺序**原来只写在 CI 的 yml 里、"谁会改仓库文件"没有任何集中说明 →
> 每次排查都要重新 grep。本文件就是那份缺失的清单（**改动脚本时请顺手更新它**）。

## 一、分类

| 类别 | 文件 | 说明 |
|---|---|---|
| **核心库**（不是入口） | `data-quality.mjs` | 被 8 个脚本 import：`readModel / validateModel / metrics / monthly / createRecorder / replaceConst / replaceMember / atomicWrite / auditFiles / isDate / autoBlockIssues`。**改数据层读写一律经过它**（原子写 ＋ 审计） |
| **抓取（会改仓库）** | `fetch_and_update.mjs` · `fetch-fees.mjs` · `fetch-nowcast.mjs` · `sync-bench.mjs` · `alt-etf-backtest.mjs` · `refresh-otc.mjs` | 写 `data.js` / `positions-data.js` / `fed-cycle/fed-data.json`。失败时**保留旧值**，不污染已有行情 |
| **门禁（只读，失败即 exit≠0）** | `check-data.mjs` · `check-finance.mjs` · `check-fed.mjs` · `cross-check.mjs` · `dom-check.mjs` · `lint.mjs` | `check-data` 会顺带跑 `cross-check` 的 `crossIssues` 与 `autoBlockIssues` |
| **测试** | `test-dashboard.mjs` | `node --test` 合成数据回归（离线可跑） |
| **工具 / 产图** | `screenshot.mjs` · `apply-screenshot.mjs` · `typecheck.mjs` · `nowcast-backtest.mjs` | `apply-screenshot` 把 App 截图转录成数据（**唯一的人工入口**）；`nowcast-backtest` 出预估精度回测 |

## 二、抓取顺序（与 `.github/workflows/update-data.yml` 一致）

```
node scripts/fetch_and_update.mjs      # ① 行情 / 快照派生（核心）
node scripts/fetch-fees.mjs            # ② 费率表（7 天阈值，未到就跳过）
node scripts/alt-etf-backtest.mjs      # ③ 标的替换回测
sh   fed-cycle/update.sh               # ④ 加息周期看板（fetch → build → verify）
node scripts/sync-bench.mjs            # ⑤ 补 BENCH（放 fed 之后：它拿不到在线序列时会读 fed 的日线兜底）
node scripts/fetch-nowcast.mjs         # ⑥ 场外预估的代理指数 ＋ 拟合
node scripts/refresh-otc.mjs           # ⑦ 场外净值区间 / 每笔申购日净值
node scripts/check-data.mjs            # ⑧ 最终审计
```

②③⑤⑥ 在 CI 里是 `continue-on-error: true`（补不上只影响自己那一块，不阻断日更）。

## 三、三条隐式约定（加东西时必须遵守）

1. **写数据只能走 `atomicWrite()`**（`data-quality.mjs`）—— 写失败或校验失败时原文件不动。
2. **加数据断言走 `autoBlockIssues()`**（同上）—— 它是「数据门禁」的扩展点，`check-data` 会汇总输出。
3. **门禁脚本必须 `process.exit(非 0)`** —— 否则钩子与 `verify-all` 拦不住；静默通过等于没有门禁。

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
