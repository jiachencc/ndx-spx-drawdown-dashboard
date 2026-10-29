#!/usr/bin/env node
/* 场外定投流水补记（2026-10-29 新增）
 *
 * 起因（用户）：「每次这个图里也有交易记录待确认的笔数，每笔都是 200，我也不想把历史交易记录
 *   截图进来，比较麻烦……你从截图的份数可以判断吗？」
 * → 不用截图。**App 的「持仓成本」本身就是笔数的计数器**：
 *     成本每 +200 ⇒ 有一笔 200 的定投确认了（份额也会 +200/净值，两者互为验证 ✓）
 *   实测 10-29：成本 27,000 → 27,200、份额 11,640.21 → 11,727.94（+87.73 × 2.2797 ≈ 200 ✓）
 *
 * 做法：对**明确仍在定投**的基金（DCA 表），把「App 成本 − 流水净额」的差额按整笔补进 OTC_LOG：
 *   · 每笔固定金额、按**交易日**从上一笔之后逐日排（跳过周末）
 *   · 只补整数笔；余额差不为 0（手续费零头 / 大额申购）→ **只报不写** ✗
 *   · 幂等：补完再跑会说「无变化」，不会重复记账 ✓
 *   · 补的每笔都带 note「（按交易日推定）」—— 将来能分清哪些是截图确认的、哪些是推定的 ✓
 *
 * ⚠ 为什么只对 021000：广发 021778 已停止定投（9-21 那笔「额度用尽」失败），
 *   它那 200 的缺口不是 200 定投（历史定投是 30 元/日），自动补会造出假记录 ✗。
 *   要新增一只，只在 DCA 表里加一行即可。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const FILE = path.join(root, "positions-data.js");
const DCA = { "021000": 200 };       // 仍在按「每交易日 × 金额」定投的基金（其余不自动补）
const TOL = 0.5;                     // 元；差额小于它视为已平

const src = readFileSync(FILE, "utf8");
const pick = (name) => {
  const m = src.match(new RegExp("^const " + name + " = \\{[\\s\\S]*?^\\};", "m"));
  if (!m) throw new Error("找不到 " + name);
  const c = vm.createContext({});
  vm.runInContext(m[0] + "\nthis.o = " + name + ";", c, { timeout: 3000 });
  return { block: m[0], obj: c.o };
};
const { obj: OTC } = pick("OTC");
const { block: LOG_BLOCK, obj: LOG } = pick("OTC_LOG");

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
const flowOf = (code) => (LOG[code] || []).filter((t) => t.status === "成功")
  .reduce((a, t) => a + (/赎回/.test(String(t.act)) ? -t.amt : t.amt), 0);

const plan = [], skipped = [];
for (const f of OTC.funds) {
  const step = DCA[f.code];
  const log = LOG[f.code] || [];
  if (!step || !log.length) continue;
  const cost = Math.round((f.value - f.pnl) * 100) / 100;
  const gap = Math.round((cost - flowOf(f.code)) * 100) / 100;
  if (gap < TOL) { if (Math.abs(gap) >= TOL) skipped.push([f.code, gap, "流水多于成本（不是漏记，需人工看）"]); continue; }
  const n = Math.round(gap / step);
  if (Math.abs(gap - n * step) > TOL) { skipped.push([f.code, gap, "不是 " + step + " 的整数倍"]); continue; }
  /* 交易日：上一笔之后的工作日（A 股节假日寥寥，按工作日推的误差 ≤1 天，
     且每笔 note 都标了「按交易日推定」，将来可核 ✓） */
  const last = new Date(log[log.length - 1].d + "T00:00:00Z");
  const days = [];
  for (let d = new Date(last.getTime() + 86400000); iso(d) <= iso(today) && days.length < n; d = new Date(d.getTime() + 86400000)) {
    if (!isWeekend(d)) days.push(iso(d));
  }
  if (days.length < n) { skipped.push([f.code, gap, "可用交易日不足（" + days.length + "/" + n + "）"]); continue; }
  plan.push({ code: f.code, step, days });
}

if (!plan.length) {
  console.log("OTC_LOG：定投流水已齐（" + Object.keys(DCA).join("/") + " 无缺口），跳过写盘");
  skipped.forEach(([c, g, why]) => console.log("  · " + c + " 差额 " + g + " 未自动补：" + why));
  process.exit(0);
}

/* 写盘：按「在每只基金的数组末尾插行」的文本手术，不做整体重排（避免把 300 多行 diff 弄脏 ✗） */
let out = src;
for (const p of plan) {
  const lines = out.split("\n");
  const head = "  \"" + p.code + "\": [";
  const i = lines.findIndex((l) => l.trim() === head.trim());
  if (i < 0) throw new Error("找不到 " + p.code + " 的流水数组");
  let j = i + 1;
  while (j < lines.length && lines[j].trim() !== "],") j++;
  const indent = (lines[i + 1].match(/^\s*/) || ["    "])[0];
  const rows = p.days.map((d) => indent + '{ d: "' + d + '", act: "定投", amt: ' + p.step
    + ', status: "成功", note: "（按交易日推定）" },');
  lines.splice(j, 0, ...rows);
  out = lines.join("\n");
}
writeFileSync(FILE, out);
plan.forEach((p) => console.log("OTC_LOG：补 " + p.code + " " + p.days.length + " 笔 × " + p.step
  + "（" + p.days[0] + " ~ " + p.days[p.days.length - 1] + "）"));
skipped.forEach(([c, g, why]) => console.log("  · " + c + " 差额 " + g + " 未自动补：" + why));
