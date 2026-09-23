#!/usr/bin/env node
/* 交叉门禁（2026-09-23 加）：专管「同一份数据在几个地方各写一遍」的一致性问题。
   这类错的特点是：只错一处时 schema 全对、页面照常渲染、数据层门禁全绿，只有把两处对起来才暴露。
   （2026-09-23 实操：摩根 9,793.86 同时写在 OTC.funds 与当日快照 items 两处；总资产/浮盈亏/当日
     又在快照字段、注释、页面三处各算一遍。当天是靠临时脚本人工对账才敢提交的 —— 本文件把它固化。）

   四条：
     ① 最新快照的场外 items  ↔  OTC.funds（汇总卡的数字来源）
     ② 各期 flow  ↔  ΔΣ成本 + Δ现金
     ③ 各期 day   ↔  Σ(items 的 Δ市值 − Δ成本)
     ④ 最新快照的场内 items.val  ↔  DEFAULT.close × 持仓 qty（仅当快照日 = 报价日）

   用法： node scripts/cross-check.mjs          只报问题（退出码 1 = 有问题）
          node scripts/cross-check.mjs --diag   额外打印全部推导残差（校准容差时用）

   ⚠ 刻意不放进 validateModel：那个函数是自动更新脚本（fetch_and_update.mjs）写盘前的候选校验闸门，
     而「快照比报价旧一天」在逐日自动抓价时是正常状态；放进去会把正常的自动更新判死。 */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { readModel } from "./data-quality.mjs";

/* 容差：①②③ 都在「元」级（两侧都是同一批 App 读数，理论上应相等；
   留 1 元是因为 App 的市值/收益各自四舍五入过）。④ 用相对 + 绝对双阈值：
   相对 0.25% 是为了容忍「手填收盘价 vs 脚本前复权价」的 0.1% 级源差异
   （2026-09-23 纳指 159941：真实 1.728 vs 脚本 1.730），同时仍能抓住转录错（通常 ≥1%）。 */
const TOL = { sum: 1.0, flow: 1.0, day: 1.0, otc: 0.02, holdRel: 0.0025, holdAbs: 5 };

const evalBlock = (html, re, expr) => {
  const m = html.match(re);
  if (!m) throw new Error("cross-check: 找不到块 " + expr);
  const ctx = vm.createContext({});
  vm.runInContext(m[0] + "\nthis.x = " + expr + ";", ctx, { timeout: 500 });
  return ctx.x;
};
export const parsePositions = (html) => ({
  rows: evalBlock(html, /^const SNAPSHOTS = \[[\s\S]*?^\];/m, "SNAPSHOTS"),
  otc: evalBlock(html, /^const OTC = \{[\s\S]*?^\};/m, "OTC"),
});

const sumOf = (items, field, pick) => Object.entries(items)
  .filter(([c]) => pick(c))
  .reduce((a, [, it]) => a + (Number.isFinite(it[field]) ? it[field] : 0), 0);
const money = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(2);

export function crossIssues(model, html, diag = false) {
  const { rows, otc } = parsePositions(html);
  const issues = [], lines = [];
  const hold = model.POSITIONS?.hold || [];
  const holdCodes = new Set(hold.map((p) => p.code));
  const full = rows.filter((r) => r.items);
  const last = full.at(-1);
  if (!last) return { issues: ["cross: 没有任何含 items 的快照，无法交叉校验"], lines };

  /* ① 最新快照场外部分 ↔ OTC.funds */
  const funds = otc.funds || [];
  const otcVal = funds.reduce((a, f) => a + f.value, 0), otcPl = funds.reduce((a, f) => a + f.pnl, 0);
  const snapVal = sumOf(last.items, "val", (c) => !holdCodes.has(c)), snapPl = sumOf(last.items, "pl", (c) => !holdCodes.has(c));
  lines.push("① 场外 Σ：快照 " + money(snapVal) + " / " + money(snapPl) + "  vs  OTC.funds " + money(otcVal) + " / " + money(otcPl) +
    "   残差 " + money(snapVal - otcVal) + " / " + money(snapPl - otcPl));
  if (Math.abs(snapVal - otcVal) > TOL.otc || Math.abs(snapPl - otcPl) > TOL.otc)
    issues.push("① 最新快照（" + last.d + "）场外 Σval/Σpl 与 OTC.funds 对不上：市值差 " + money(snapVal - otcVal) + "、盈亏差 " + money(snapPl - otcPl) +
      "（同一批 App 读数写了两处，改一处漏了另一处 → 汇总卡与快照会各说各话）");
  for (const f of funds) {
    const it = last.items[f.code];
    if (!it) { issues.push("① OTC.funds 的 " + f.code + "（" + f.name + "）在最新快照 items 里不存在"); continue; }
    if (Math.abs(it.val - f.value) > TOL.otc || Math.abs(it.pl - f.pnl) > TOL.otc)
      issues.push("① " + f.code + "（" + f.name + "）快照 items val/pl " + money(it.val) + "/" + money(it.pl) +
        " ≠ OTC.funds " + money(f.value) + "/" + money(f.pnl));
  }

  /* ② flow ↔ ΔΣ成本 + Δ现金 ；③ day ↔ Σ(Δ市值 − Δ成本) */
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1], c = rows[i];
    if (!p.items || !c.items) { if (diag) lines.push("  " + c.d + "   （非完整快照，跳过 ②③）"); continue; }
    const dCost = sumOf(c.items, "cost", () => true) - sumOf(p.items, "cost", () => true);
    const dVal = sumOf(c.items, "val", () => true) - sumOf(p.items, "val", () => true);
    const dCash = Number.isFinite(c.cash) && Number.isFinite(p.cash) ? c.cash - p.cash : null;
    const f2 = dCash === null ? null : dCost + dCash;
    const d2 = dVal - dCost;
    const rf = Number.isFinite(c.flow) && f2 !== null ? c.flow - f2 : null;
    const rd = Number.isFinite(c.day) ? c.day - d2 : null;
    if (diag) lines.push("  " + c.d + "  flow " + (Number.isFinite(c.flow) ? money(c.flow) : "—") + " vs " + (f2 === null ? "—" : money(f2)) +
      " (残差 " + (rf === null ? "—" : money(rf)) + ")   day " + (Number.isFinite(c.day) ? money(c.day) : "—") + " vs " + money(d2) +
      " (残差 " + (rd === null ? "—" : money(rd)) + ")");
    if (rf !== null && Math.abs(rf) > TOL.flow)
      issues.push("② " + c.d + " flow " + money(c.flow) + " ≠ ΔΣ成本 + Δ现金 " + money(f2) + "（残差 " + money(rf) +
        "）：外部资金流与仓库变动对不上，归因会错");
    /* ③ 只报告、**不判失败**（2026-09-23 实测校准）：把「day ↔ Σ(Δ市值 − Δ成本)」当硬门禁会在历史期误报 ——
       换仓/建仓/银证转账那几天（09-08 +66、09-10 +77、09-16 +3,975、09-17 −9、09-22 +5）残差不为零，
       因为「本期 Δ」在组合**构成变化**时并不等于「当天的市场盈亏」（理论上只对「无申赎无转账」的日子成立）。
       它真正有用的场合是最新一期，而最新一期该由**渲染层**用页面自己的算法校验：
       页面当日 = 场内估（DEFAULT.chg × 份数）+ 场外快（Σ OTC.funds[].day）→ 已并入 dom-check。
       这里保留一行诊断：残差平时 <1 元，突然变大仍是值得看的信号。 */
    if (diag && rd !== null && Math.abs(rd) > TOL.day) lines.push("    ↳ ③ 残差 " + money(rd) + " 偏大（构成变化日属正常；最新一期的正式校验在 dom-check）");
  }

  /* ④ 最新快照场内 items ↔ DEFAULT.close × qty（仅在快照日 = 报价日时可校验） */
  const keys = ["etfNdx", "etfSpx", "kr", "n225", "hkus"];
  const sameDay = keys.every((k) => model.DEFAULT?.[k]?.priceDate === last.d);
  if (!sameDay) {
    lines.push("④ 跳过：快照日 " + last.d + " ≠ 报价日（" + keys.map((k) => k + "=" + model.DEFAULT?.[k]?.priceDate).join(" ") + "）");
  } else {
    for (const k of keys) {
      const code = (hold.find((p) => p.idx === (k === "etfNdx" ? "ndx" : k === "etfSpx" ? "spx" : k)) || {}).code;
      const it = code ? last.items[code] : null, p = code ? hold.find((x) => x.code === code) : null;
      if (!it || !p) continue;
      const derived = model.DEFAULT[k].close * p.qty, diff = it.val - derived;
      const lim = Math.max(TOL.holdAbs, Math.abs(it.val) * TOL.holdRel);
      if (diag) lines.push("  ④ " + code + " items.val " + it.val.toFixed(2) + " vs close×qty " + derived.toFixed(2) +
        "  差 " + money(diff) + "  容差 ±" + lim.toFixed(2));
      if (Math.abs(diff) > lim)
        issues.push("④ " + code + " 最新快照 items.val " + it.val.toFixed(2) + " ≠ DEFAULT.close(" + model.DEFAULT[k].close + ") × qty(" + p.qty + ") = " +
          derived.toFixed(2) + "（差 " + money(diff) + "）：快照与页面报价口径不一致");
    }
  }
  return { issues, lines };
}

function main() {
  const diag = process.argv.includes("--diag");
  const root = new URL("../", import.meta.url);
  const model = readModel(readFileSync(new URL("data.js", root), "utf8"));
  const html = readFileSync(new URL("positions.html", root), "utf8");
  const { issues, lines } = crossIssues(model, html, diag);
  if (diag) lines.forEach((l) => console.log("  " + l));
  if (issues.length) {
    console.error("交叉门禁未通过（同一份数据在几处不一致）：\n" + issues.map((s) => "  - " + s).join("\n"));
    process.exitCode = 1;
  } else console.log("交叉一致性：① 快照场外 ↔ OTC.funds · ② flow ↔ Δ成本+Δ现金 · ④ 场内快照 ↔ 报价×份数 —— 全部通过（③ 当日口径改由渲染层校验，见 dom-check）。");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
