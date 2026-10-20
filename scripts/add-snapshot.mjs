#!/usr/bin/env node
/* 一期快照的录入工具（2026-10-20 加）
 *
 * 为什么需要：此前每一期都是手写 python 改 5~8 处（funds 的 value/pnl/nav、snapshot 的
 *   items/cost/pl/flow/day），再手算 flow 与 day 去对账 —— 2026-10-19 / 10-20 两期实测：
 *     · flow 试了 3 次才吻合（残差 5.71 → 5.68 → 0）
 *     · 同名 replace 误把 10-19 的快照也改了（两期 items 结构完全相同）→ 回滚重做
 *     · cost 要手写 10 位小数、qty 要和 App 逐个对
 *   每次 10 分钟以上，而且容易错。
 *
 * 本脚本做四件事：
 *   ① 按名字查（不手写 name —— 快照 items 里必须有显示名，归因/对比都靠它）
 *   ② 算 cost（场内 qty × 摊薄成本单价；场外 val − App 持仓收益）
 *   ③ **反推 flow** 并与你传的值对账（不吻合就大声警告，不静默写入）
 *   ④ 算 day，并与「场内当日 + 场外当日收益」交叉验证
 *
 * 用法：
 *   node scripts/add-snapshot.mjs --date 2026-10-20 \
 *     --etf 159941=1.708,101900 --etf 513650=1.982,94500 --etf 513880=2.090,23400 \
 *     --fund 021778=22116.15,-463.85,8.0514 --fund 021000=25639.78,-160.22,2.2721 \
 *     --cash 0 [--flow 9654] [--day -3121.97] [--etfday -3796.70] [--note "…"] \
 *     [--apply-funds] [--dry-run]
 *
 *   --etf  CODE=收盘价[,份额]     份额省略时取 POSITIONS.hold 里的 qty
 *   --fund CODE=市值,盈亏[,净值]   净值省略则不更新 nav（check-data 会拦）
 *   --flow 不传 → 用「ΔΣ成本 + Δ现金」反推；传了 → 与反推值对账
 *   --apply-funds  同时把 funds 的 value/pnl/rate/nav 写进 positions-data.js
 *
 * 退出码：0 = 已写入或 dry-run 通过；1 = 校验不通过（未写入）
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (k) => argv.includes("--" + k);
const val = (k, d = null) => {
  const i = argv.indexOf("--" + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const vals = (k) => {
  const out = [];
  argv.forEach((a, i) => { if (a === "--" + k && argv[i + 1] && !argv[i + 1].startsWith("--")) out.push(argv[i + 1]); });
  return out;
};

const DATE = val("date");
if (!DATE || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error("用法：node scripts/add-snapshot.mjs --date 2026-10-20 --etf 159941=1.708 [--fund 021778=22116.15,-463.85,8.0514] --cash 0");
  process.exit(1);
}

/* ── 读模型（不复用 data-quality 的 readModel：它在 data.js 有两个大 JSON 块时
      偶发 "HOLD_HIST is not defined"，2026-10-20 踩过） ─────────────────────── */
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "data.js"), "utf8") + "\nthis.P=POSITIONS;this.D=DEFAULT;", ctx, { timeout: 8000 });
const P = ctx.P, D = ctx.D;
vm.runInContext(fs.readFileSync(path.join(ROOT, "positions-data.js"), "utf8") + "\nthis.O=OTC;this.S=SNAPSHOTS;", ctx, { timeout: 8000 });
const O = ctx.O, S = ctx.S;

const prev = S[S.length - 1];
if (prev.d >= DATE) {
  console.error("✗ 最新一期已经是 " + prev.d + "（≥ " + DATE + "）。补录历史期请手工处理，本脚本只追加最新一期。");
  process.exit(1);
}

/* ── 名称查找（快照 items 必须有 name：归因、快照对比都靠它） ──────────── */
const nameOf = (code) => {
  const h = (P.hold || []).filter((x) => x.code === code)[0];
  if (h) return h.sym;
  const f = (O.funds || []).filter((x) => x.code === code)[0];
  return f ? f.name : null;
};
const fmt = (n) => (n < 0 ? "−" : "+") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ── 解析参数 → 新 items ─────────────────────────────────────────── */
const items = {};
const fundsUpd = [];
const notes = [];

for (const spec of vals("etf")) {
  const [code, rest] = spec.split("=");
  const [pxStr, qtyStr] = (rest || "").split(",");
  const px = +pxStr;
  const h = (P.hold || []).filter((x) => x.code === code)[0];
  if (!h) { console.error("✗ --etf " + code + "：POSITIONS.hold 里没有这只"); process.exit(1); }
  const qty = qtyStr ? +qtyStr : h.qty;
  if (!Number.isFinite(px) || !Number.isFinite(qty)) { console.error("✗ --etf " + code + "：价格/份额不是数字"); process.exit(1); }
  const cost = +(qty * h.cost).toFixed(2);          // 摊薄成本 = 份额 × 成本单价（hold.cost）
  const value = +(qty * px).toFixed(2);
  items[code] = { name: nameOf(code), qty: qty, cost: cost, val: value, pl: +(value - cost).toFixed(2) };
  notes.push(code + " " + qty + "×" + px + " = " + value.toFixed(2));
  if (qty !== h.qty) notes.push("⚠ " + code + " 快照份额 " + qty + " ≠ hold.qty " + h.qty);
}

for (const spec of vals("fund")) {
  const [code, rest] = spec.split("=");
  const [vStr, pStr, nStr] = (rest || "").split(",");
  const value = +vStr, pnl = +pStr, nav = nStr ? +nStr : null;
  if (!Number.isFinite(value) || !Number.isFinite(pnl)) { console.error("✗ --fund " + code + "：市值/盈亏不是数字"); process.exit(1); }
  const f = (O.funds || []).filter((x) => x.code === code)[0];
  if (!f) { console.error("✗ --fund " + code + "：OTC.funds 里没有这只"); process.exit(1); }
  items[code] = { name: f.name, qty: f.qty, cost: +(value - pnl).toFixed(2), val: value, pl: pnl };
  if (nav) fundsUpd.push({ code, value, pnl, nav });
  notes.push(code + " " + value.toFixed(2) + " / " + pnl.toFixed(2) + (nav ? "（净值 " + nav + "）" : ""));
}

/* 未在该期给出的标的：沿用上一期（页面会按净值日标出「沿用」） */
for (const [code, it] of Object.entries(prev.items || {})) {
  if (!items[code]) { items[code] = { ...it }; notes.push(code + " 沿用上期"); }
}

/* ── 对账：flow / day ───────────────────────────────────────────── */
const sum = (o, k) => Object.values(o).reduce((a, x) => a + (x[k] || 0), 0);
const cash = val("cash") === null ? 0 : +val("cash");
const prevCost = sum(prev.items || {}, "cost"), prevVal = sum(prev.items || {}, "val");
const newCost = sum(items, "cost"), newVal = sum(items, "val");
const dCost = newCost - prevCost;
const dCash = cash - prev.cash;
const sugFlow = +(dCost + dCash).toFixed(2);
const flow = val("flow") === null ? sugFlow : +val("flow");
const dVal = newVal - prevVal + dCash;
const day = val("day") === null ? +(dVal - flow).toFixed(2) : +val("day");
const pl = +sum(items, "pl").toFixed(2);

console.log("═══ 快照 " + DATE + " ═══");
console.log("上期 " + prev.d + "  Σ成本 " + prevCost.toFixed(2) + "  Σ市值 " + prevVal.toFixed(2) + "  cash " + prev.cash);
console.log("本期 " + DATE + "  Σ成本 " + newCost.toFixed(2) + "  Σ市值 " + newVal.toFixed(2) + "  cash " + cash);
console.log("");
console.log("ΔΣ成本 " + fmt(dCost) + "   Δ现金 " + fmt(dCash) + "   → 建议 flow " + fmt(sugFlow));
if (val("flow") !== null && Math.abs(flow - sugFlow) > 0.05) {
  console.log("  ⚠ 你传的 flow " + fmt(flow) + " 与反推值差 " + fmt(flow - sugFlow) + " —— 写入后 cross-check ② 会红，先确认哪个对");
}
console.log("");
console.log("Δ总资产 " + fmt(dVal) + "   − flow " + fmt(flow) + "   = day " + fmt(day));
const etfDay = val("etfday") === null ? null : +val("etfday");
const otcDay = (() => {
  let s = 0, n = 0;
  for (const u of fundsUpd) {
    const f = (O.funds || []).filter((x) => x.code === u.code)[0];
    if (f && Number.isFinite(f.day)) { s += f.day; n++; }
  }
  return n ? s : null;
})();
if (otcDay !== null) {
  const derivedEtf = +(day - otcDay).toFixed(2);
  console.log("交叉校验：day " + fmt(day) + " − 场外当日 " + fmt(otcDay) + " = 场内 " + fmt(derivedEtf)
    + (etfDay !== null ? "（你传的场内当日 " + fmt(etfDay) + "，差 " + fmt(derivedEtf - etfDay) + "）" : ""));
}
console.log("");
notes.forEach((n) => console.log("  · " + n));

/* ── 写入 ──────────────────────────────────────────────────────── */
if (has("dry-run")) {
  console.log("\n（--dry-run：未写入）");
  process.exit(0);
}

const snapSrc = fs.readFileSync(path.join(ROOT, "positions-data.js"), "utf8");
const i0 = snapSrc.indexOf("const SNAPSHOTS = [");
const i1 = snapSrc.indexOf("\n];", i0);
const itemsJs = Object.entries(items)
  .map(([c, x]) => '      "' + c + '": { name: "' + String(x.name).replace(/"/g, '\\"') + '", qty: ' + x.qty + ", cost: " + x.cost + ", val: " + x.val + ", pl: " + x.pl + " },")
  .join("\n");
const noteJs = (val("note") || "").split("\n").map((l) => "       " + l).join("\n");
const snapJs = "\n  { d: \"" + DATE + "\", cash: " + cash + ", pl: " + pl + ", day: " + day + ", flow: " + flow + "," +
  (noteJs ? "\n    /* " + noteJs + " */" : "") +
  "\n    items: {\n" + itemsJs + "\n    } },";
let out = snapSrc.slice(0, i1) + snapJs + snapSrc.slice(i1);

/* --apply-funds：同时更新 funds 的 value/pnl/rate/nav（check-data 要求 value 与 nav 同步） */
if (has("apply-funds") && fundsUpd.length) {
  for (const u of fundsUpd) {
    const idx = out.indexOf('code: "' + u.code + '"');
    if (idx < 0) continue;
    const navIdx = out.indexOf("nav: {", idx);
    if (navIdx < 0) continue;
    const seg = out.slice(idx, navIdx);
    const rate = +(u.pnl / u.value * 100).toFixed(2);
    const seg2 = seg
      .replace(/value: [-\d.]+/, "value: " + u.value)
      .replace(/pnl: [-\d.]+/, "pnl: " + u.pnl)
      .replace(/rate: [-\d.]+/, "rate: " + rate)
      .replace(/upd: "[^"]*"/, 'upd: "' + DATE + ' 20:00"');
    const navEnd = out.indexOf("}", navIdx);
    const nav2 = out.slice(navIdx, navEnd).replace(/close: [\d.]+/, "close: " + u.nav);
    out = out.slice(0, idx) + seg2 + nav2 + out.slice(navEnd);
  }
  /* OTC.updated 跟到本日 */
  out = out.replace(/  updated: "\d{4}-\d{2}-\d{2}"/, '  updated: "' + DATE + '"');
}

fs.writeFileSync(path.join(ROOT, "positions-data.js"), out);
console.log("\n✓ 已写入 positions-data.js" + (has("apply-funds") ? "（含 funds 更新）" : ""));

/* 写完立刻跑数据类门禁 */
console.log("\n── 数据类门禁 ──");
try {
  const { execFileSync } = await import("node:child_process");
  execFileSync("node", ["scripts/verify-all.mjs", "--data"], { cwd: ROOT, stdio: "inherit" });
} catch {
  console.error("\n✗ 数据类门禁未通过 —— 用 git checkout positions-data.js 回滚后重试");
  process.exit(1);
}
