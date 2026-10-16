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
const TOL = { sum: 1.0, flow: 1.0, day: 1.0, otc: 0.02, holdRel: 0.0025, holdAbs: 5,
  /* ⑤ 场外「市值 ↔ 净值」：val = qty × nav.close + 在途，在途 ≥ 0 且不该超过千元量级。
     -0.5 的负向容差是给「商 × 净值」与 val 各自四舍五入留的。 */
  navSlack: 0.5, navSlackMax: 1000 };

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
  /* ⚠ 2026-10-14 加：场外的**全额清仓**台账（本文件此前只能从 POSITIONS.log 拿已实现，而那只装场内交割单 ✗）。
     页面 closedCostGap() 与下面 ② 的修正项**共用这一份 MANUAL 数据**，口径 = Σ(成本 − 回款) ✓。
     取不到（老版本数据文件没有这个常量）时返回 [] —— 不抛错，保持向后可跑 ✓ */
  otcCleared: (() => {
    try { return evalBlock(html, /^const OTC_CLEARED = \[[\s\S]*?^\];/m, "OTC_CLEARED") || []; }
    catch (e) { return []; }
  })(),
});

const sumOf = (items, field, pick) => Object.entries(items)
  .filter(([c]) => pick(c))
  .reduce((a, [, it]) => a + (Number.isFinite(it[field]) ? it[field] : 0), 0);
const money = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(2);

export function crossIssues(model, html, diag = false) {
  const { rows, otc, otcCleared } = parsePositions(html);
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

  /* ⑤ 场外「市值 ↔ nav.close」自洽（2026-09-29 加，起因是一次真事故）
     基金条目里 value（市值）与 nav.close / nav.closeDate（净值与净值日）是**同一件事的两种表示**，
     改一个忘一个就会出「市值是今天的、净值日还是 5 天前」——页面照旧渲染，①②③④ 也全部通过
     （那些校验只看 val/pl/cost，不看 nav），只有人眼看卡片才发现。实测事故就是如此：
     09-29 期把 7 只的 value/day/pnl/rate/upd 都更新了，唯独 nav 留在 09-24。
     判据用本页已有的恒等式：val = qty × nav.close + 在途（在途 ≥ 0、且是最近几笔定投扣款的量级）。
     ⚠ 负向最灵：nav 比市值「还新」几乎只可能是漏改；正向只设上限，另用「在途必须是该只定投额的倍数」
       兜住「旧净值恰好比新净值低」那种漏改（当时 021000 就是这样溜过去的：slack 213 而非 0/200/400）。 */
  let otcLog = null;
  try { otcLog = evalBlock(html, /^const OTC_LOG = \{[\s\S]*?^\};/m, "OTC_LOG"); } catch { otcLog = null; }
  const stakeAmts = (code) => {
    const list = (otcLog && otcLog[code]) || [];
    return [...new Set(list.filter((r) => r.status === "成功" && (r.act === "定投" || r.act === "申购")).map((r) => r.amt))];
  };
  for (const f of funds) {
    const it = last.items[f.code];
    if (!it || !f.nav || !Number.isFinite(f.nav.close) || !Number.isFinite(f.nav.close) || !Number.isFinite(it.qty)) continue;
    const slack = it.val - it.qty * f.nav.close;
    if (diag) lines.push("  ⑤ " + f.code + " " + money(it.val) + " − qty(" + it.qty + ") × nav.close(" + f.nav.close + ") = " + money(slack) + "（= 在途）");
    if (slack < -TOL.navSlack)
      issues.push("⑤ " + f.code + "（" + f.name + "）市值 " + money(it.val) + " 比「份额 × 净值」" + money(it.qty * f.nav.close) +
        " 还小 " + money(-slack) + " → nav.close(" + f.nav.close + " / " + f.nav.closeDate + ") 没跟着 value 更新" +
        "（页面会把净值日显示成旧的；改数据时 value 与 nav 必须一起改）");
    else if (slack > TOL.navSlackMax)
      issues.push("⑤ " + f.code + "（" + f.name + "）推得的「在途」" + money(slack) + " 超过 " + TOL.navSlackMax + " → nav.close 或 qty 可疑");
    else if (slack > TOL.navSlack) {
      const amts = stakeAmts(f.code);
      const okMulti = amts.length > 0 && amts.some((a) => a > 0 && Math.abs(slack / a - Math.round(slack / a)) < 0.01);
      if (!okMulti)
        issues.push("⑤ " + f.code + "（" + f.name + "）推得的「在途」" + money(slack) + " 既不是 0、也不是该只定投额（" +
          (amts.join(" / ") || "无记录") + "）的整数倍 → 多半是 nav.close 没跟着 value 更新（旧净值恰好偏低时就会这样）");
    }
  }

  /* ② flow ↔ ΔΣ成本 + Δ现金 ；③ day ↔ Σ(Δ市值 − Δ成本) */
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1], c = rows[i];
    if (!p.items || !c.items) { if (diag) lines.push("  " + c.d + "   （非完整快照，跳过 ②③）"); continue; }
    const dCost = sumOf(c.items, "cost", () => true) - sumOf(p.items, "cost", () => true);
    const dVal = sumOf(c.items, "val", () => true) - sumOf(p.items, "val", () => true);
    const dCash = Number.isFinite(c.cash) && Number.isFinite(p.cash) ? c.cash - p.cash : null;
    /* 2026-10-09 加：**清仓修正**。某标的从本期 items 里消失（清仓）时，它的成本整块离开 Σ、
       而卖出回款进了现金 → 原式 ΔΣ成本 ＋ Δ现金 会把它当成"外部流出"✗。
       真实语义：成本额 − 卖出净额 ＝ **已实现盈亏**，那一块从来不是资金流，故要减掉：
         flow ＝ ΔΣ成本 ＋ Δ现金 − Σ已实现(清仓)
       首次触发是 2026-10-09（清仓中韩 82,372.10 / 港美 9,306.10，realized −13,217.10 / −5,274.90）：
         不修正残差 **−18,282.00** ✗（判红、挡住写入）；修正后 = **+210.00** ＝ 当日场外定投
         （南方 200 ＋ 华安A/C 各 5）✓✓ —— 与「Δ总资产 ＝ flow ＋ day − 费用」独立吻合（差 0.05 逐只取整）。
       ⚠ realized 取自 POSITIONS.log 的卖出/减仓/清仓行（按快照 items 的 name 匹配本只最近一笔）。
       ⚠ **2026-10-14 补场外那一半**：POSITIONS.log 只装**场内**交割单 → 场外全额清仓（首次即 015884 中欧）
         在那里找不到对应流水。原先的处理是「照实报缺」✗（本期就会命中、把写入挡住）；
         现改为回落到 positions-data.js 的 **OTC_CLEARED** —— 与页面 closedCostGap() 同一份数据、同一口径
         （已实现 ＝ 回款 − 成本）；两处都找不到才报缺，不静默放过 ✗。 */
    let clearRealized = 0; const clearNoFlow = [];
    for (const code of Object.keys(p.items)) {
      if (c.items[code]) continue;                       // 还在本期 items 里 → 不是清仓（减仓由摊薄口径自洽 ✓）
      const nm = (p.items[code] || {}).name || "";
      const e = (model.POSITIONS?.log || [])
        .filter((x) => /卖出|减仓|清仓/.test(String(x.act || "")) && x.sym === nm && Number.isFinite(x.realized))
        .sort((a, b) => (a.d < b.d ? 1 : -1))[0];
      const oc = (otcCleared || []).find((x) => x && x.code === code);
      if (e) clearRealized += e.realized;
      else if (oc) clearRealized += (Number(oc.proceeds) || 0) - (Number(oc.cost) || 0);   // 场外：已实现 ＝ 回款 − 成本
      else clearNoFlow.push(code + "（" + nm + "）");
    }
    const f2 = dCash === null ? null : dCost + dCash - clearRealized;
    if (diag && clearRealized) lines.push("  " + c.d + "  清仓修正 −Σ已实现 " + money(clearRealized) + "（" + (clearNoFlow.length ? "✗ 无法修正：" + clearNoFlow.join("、") : "已全部找到对应流水 ✓") + "）");
    if (clearNoFlow.length) lines.push("② " + c.d + " 有标的从 items 消失但 **log 里找不到对应的卖出流水**：" + clearNoFlow.join("、") +
      " → flow 无法按「ΔΣ成本 ＋ Δ现金 − Σ已实现」修正（场外清仓需手工确认口径）");
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

/* ⑥ 口径单一出处（2026-10-16 加，起因见 positions-logic.js 的文件头）：持仓页那三条判据
   （本期已同步 / 场外当日合计的有效集合 /「组合已到」的日期）**只许定义在 positions-logic.js**：
   每个消费方都必须调 POS_LOGIC，且**不许**再出现判据原文 —— 否则下次又漂，且漂了没人知道 ✗
   （2026-10-16 那一次就是四处各写一份：页面 `>=`、录入器 `==`、门禁两处 `===` ✗）。
   放 cross-check 里：它本来就是「同一份东西在几处各写一遍」的专门门禁 ✓。
   实现注：**先去掉注释再查** —— 本仓库的注释里故意留着旧写法当反例，直接全文匹配会误报 ✗。 */
export function singleSourceIssues(root) {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const read = (f) => readFileSync(new URL(f, root), "utf8");
  const inlineOf = (html) => [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n;\n");
  const issues = [];
  const lib = read("positions-logic.js");
  for (const k of ["synced", "dayVals", "sumDay", "trendLastD"])
    if (!new RegExp("\\b" + k + "\\s*\\(").test(lib)) issues.push("⑥ positions-logic.js 缺 POS_LOGIC." + k + "()");
  const DUP = [
    [/upd\s*\.\s*slice\(0,\s*10\)/, "upd.slice(0, 10)"],
    [/startsWith\(input\.date\)/, "startsWith(input.date)"],
    [/===\s*OC\.updated/, "=== OC.updated"],
    [/(upd\s*>=\s*OTC\.updated|OTC\.updated\s*<=\s*upd)/, "upd >= OTC.updated"],
  ];
  const page = strip(inlineOf(read("positions.html")));
  for (const [re, txt] of DUP)
    if (re.test(page)) issues.push("⑥ positions.html 的内联脚本里又出现了判据原文「" + txt +
      "」：应改调 POS_LOGIC.*（口径只能有一处，见 positions-logic.js ✓）");
  for (const [f, need, label] of [["scripts/apply-screenshot.mjs", /LOGIC\.synced\(/, "upd 判定"],
    ["scripts/dom-check.mjs", /LOGIC\.(sumDay|dayVals|trendLastD)\(/, "场外当日合计 / 组合末日"],
    ["scripts/dom-check.mjs", /LOGIC\.synced\(|LOGIC\.dayVals\(/, "未更新只的判定"]]) {
    if (!need.test(strip(read(f)))) issues.push("⑥ " + f + " 的「" + label + "」没有走 POS_LOGIC（" + need + "）：口径必须从 positions-logic.js 读 ✓");
  }
  return issues;
}

function main() {
  const diag = process.argv.includes("--diag");
  const root = new URL("../", import.meta.url);
  const model = readModel(readFileSync(new URL("data.js", root), "utf8"));
  // ⚠ 2026-09-27 起 SNAPSHOTS / OTC 在 positions-data.js（原先内联在 positions.html）
  const html = readFileSync(new URL("positions-data.js", root), "utf8");
  const { issues, lines } = crossIssues(model, html, diag);
  const src = singleSourceIssues(root);
  if (diag) lines.forEach((l) => console.log("  " + l));
  if (issues.length || src.length) {
    console.error("交叉门禁未通过（同一份数据在几处不一致）：\n" + issues.concat(src).map((s) => "  - " + s).join("\n"));
    process.exitCode = 1;
  } else console.log("交叉一致性：① 快照场外 ↔ OTC.funds · ② flow ↔ Δ成本+Δ现金 · ④ 场内快照 ↔ 报价×份数 · ⑤ 场外市值 ↔ nav.close · ⑥ 三条口径的唯一出处（positions-logic.js）—— 全部通过（③ 当日口径改由渲染层校验，见 dom-check）。");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
