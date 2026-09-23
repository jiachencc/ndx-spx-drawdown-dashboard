#!/usr/bin/env node
/* 截图录入器（2026-09-23 加）：把「一张截图里读到的数字」一次性写进数据文件，
   自动推导所有能推导的量、自动生成注释里的合计、跑门禁、失败自动回滚。

   为什么需要（2026-09-23 实操复盘）：那一天是
     · 145 个手输数字（场外 8×7 + 快照 13×4 + 溢价 5×4 + 合计/ACCT_STATS）
     · 20 次定点文本替换，其中 1 次锚点失配（上一次编辑在同一行插了注释）→ 重新读文件再来
     · 摩根 20:26 才到 → 合计与注释里的数字要跟着改 4 处（注释里的数字**没有任何门禁能校验**）
   本脚本把这四类成本压掉：数字只出现在输入 JSON 里一处，其余全部推导；改动全部定点替换，保留既有注释。

   用法：
     node scripts/apply-screenshot.mjs day.json            干跑：只打印将要做哪些改动
     node scripts/apply-screenshot.mjs day.json --write    落盘 + 跑门禁（不通过自动回滚）
     node scripts/apply-screenshot.mjs day.json --write --allow-partial   允许场外只更新一部分

   输入（只写「读了什么」，不写任何能算出来的东西）：
   {
     "date": "2026-09-24",                       // 快照日 = 场内报价日
     "cash": 0,                                  // 各渠道可用资金合计
     "otc": [ { "code": "021000", "value": 24096.85, "pnl": 896.85, "day": 36.60, "qty": 9996.56,
                "upd": "2026-09-24 20:12", "navClose": 2.4103, "navDate": "2026-09-23" } ],
     "etf": { "etfNdx": { "close": 1.712, "chg": 0.42 }, "etfSpx": 2.030, "kr": 4.900, "n225": 2.150, "hkus": 1.990 },
     "hold": [ { "code": "159941", "qty": 82100, "cost": 1.5921 } ],     // 份数/成本变了才写（App 读数）
     "trades": [ { "d": "2026-09-24", "act": "买入", "sym": "纳指ETF广发", "qty": 1000, "cost": 1.700,
                   "realized": null, "note": "平安证券 09-24 成交…" } ],
     "pending": [ { "code": "021000", "amount": 400 } ],                 // 在途（市值已含、份额未含）
     "acct": { "updated": "2026-09-24", "pnl": 3500.00, "pnlPct": -9.80 },
     "day": 1234.56,                             // 可选：当日盈亏（不填则用「场内 Δ市值−Δ成本 + Σ场外 day」推）
     "note": "当日事件说明（可选，附在快照注释里）"
   }
   `etf` 的值可写成数字（close，chg 由文件里的旧 close 推）或 { close, chg }（chg 由 App 读取，
   复跑/补录时用它才能保持幂等 —— 只有数字时 chg 会被推成 0）。

   推导并写入：rate = pnl ÷ (value − pnl)；DEFAULT 的 chg / priceDate / ath / low52；
   快照 items（场内 val = close×份数、cost = 成本价×份数；场外取 App 读数）、pl = Σ、
   day、flow = ΔΣ成本 + Δ现金，以及注释里的全部合计文字。

   两条硬规则（对应 2026-09-23 踩过的两个坑）：
   · 场外没凑齐（少于全部只数）且没加 --allow-partial → 拒绝写快照（否则旧值会被冻进历史）
   · 快照日必须晚于最新一期（历史不许改）
   ⚠ 仍需人工补的：ACCT_STATS.monthly[当月]（App 对账单读数）、AUTO 的 premiums（见 handoff.md SOP 第 6 步）。 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { readModel } from "./data-quality.mjs";

const argv = process.argv.slice(2);
const inputPath = argv.find((a) => !a.startsWith("--"));
const WRITE = argv.includes("--write");
const ALLOW_PARTIAL = argv.includes("--allow-partial");
if (!inputPath) {
  console.error("用法：node scripts/apply-screenshot.mjs <day.json> [--write] [--allow-partial]");
  process.exit(2);
}
const ROOT = new URL("../", import.meta.url);
const DATA_PATH = new URL("data.js", ROOT), POS_PATH = new URL("positions.html", ROOT);
const ETF_KEYS = { etfNdx: "ndx", etfSpx: "spx", kr: "kr", n225: "n225", hkus: "hkus" };
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/* ---------- 读输入 + 校验 ---------- */
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const errors = [];
if (!isDate(input.date)) errors.push("date 缺失或格式不对");
if (!Number.isFinite(input.cash)) errors.push("cash 缺失（各渠道可用资金合计）");
if (!input.otc?.length) errors.push("otc 为空（至少要有一只场外读数）");
for (const f of input.otc || []) {
  if (!/^\d{6}$/.test(f.code || "")) errors.push("otc.code 非法：" + f.code);
  for (const k of ["value", "pnl", "day", "qty"]) if (!Number.isFinite(f[k])) errors.push(f.code + " 缺 " + k);
  if (!Number.isFinite(f.navClose) || !isDate(f.navDate)) errors.push(f.code + " 缺 navClose/navDate");
  /* upd 必须是本期日期：页面按它判「已同步」，日期不对就会显示「N 只未更新」、
     并把该只的当日收益从合计里剔除（2026-09-23 自检时正是这样被 dom-check 抓到的 —— 沿用上期 upd 即翻车）。 */
  if (!f.upd) f.upd = input.date + " 20:00";
  else if (!String(f.upd).startsWith(input.date))
    errors.push(f.code + " 的 upd（" + f.upd + "）不是本期 " + input.date + " 的时间：页面会当它没更新，当日合计会少算这一只");
}
for (const [k, e] of Object.entries(input.etf || {})) {
  if (!(k in ETF_KEYS)) errors.push("etf 多出未知键：" + k);
  const close = typeof e === "object" ? e.close : e;
  if (!Number.isFinite(close)) errors.push("etf." + k + " 的 close 非法");
}
for (const k of Object.keys(ETF_KEYS)) if (!(k in (input.etf || {}))) errors.push("etf 缺 " + k);
for (const e of input.trades || []) {
  if (!isDate(e.d)) errors.push("trade 缺 d");
  if (!Number.isInteger(e.qty) || !Number.isFinite(e.cost)) errors.push("trade 缺 qty/cost");
  if (/卖出|减仓|清仓/.test(String(e.act)) && !Number.isFinite(e.realized)) errors.push("卖出行 " + e.d + " " + e.act + " 必须带 realized（门禁强制）");
}
const dataSrc0 = readFileSync(DATA_PATH, "utf8"), posSrc0 = readFileSync(POS_PATH, "utf8");
const model = readModel(dataSrc0);
const evalBlock = (src, re, expr) => {
  const m = src.match(re);
  if (!m) throw new Error("找不到块：" + expr);
  const ctx = vm.createContext({});
  vm.runInContext(m[0] + "\nthis.x = " + expr + ";", ctx, { timeout: 500 });
  return ctx.x;
};
const otcNow = evalBlock(posSrc0, /^const OTC = \{[\s\S]*?^\};/m, "OTC");
const rows = evalBlock(posSrc0, /^const SNAPSHOTS = \[[\s\S]*?^\];/m, "SNAPSHOTS");
const last = rows.filter((r) => r.items).at(-1);
if (!last) errors.push("没有可参照的上一期完整快照");
else if (input.date <= rows.at(-1).d) errors.push("date " + input.date + " 不晚于最新快照 " + rows.at(-1).d + "（历史不许改）");
const missing = (otcNow.funds || []).filter((f) => !input.otc.some((x) => x.code === f.code));
if (missing.length && !ALLOW_PARTIAL) errors.push("场外只给了 " + input.otc.length + "/" + otcNow.funds.length + " 只（缺 " + missing.map((f) => f.code).join("/") + "）：未凑齐不写快照，否则旧值会被冻进历史；确实要写就加 --allow-partial");
if (errors.length) { console.error("输入有问题：\n" + errors.map((s) => "  - " + s).join("\n")); process.exit(1); }

/* ---------- 推导 ---------- */
const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100, r3 = (x) => Math.round(x * 1000) / 1000;
const num = (v, dp = 2) => { const s = (+v).toFixed(dp); return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s; };
const holdByCode = (code) => model.POSITIONS.hold.find((p) => p.code === code);
const holdByIdx = (idx) => model.POSITIONS.hold.find((p) => p.idx === idx);
const nextHold = (code) => { const p = holdByCode(code); const u = (input.hold || []).find((h) => h.code === code); return u ? { ...p, qty: u.qty, cost: u.cost, idxAtCost: u.cost } : p; };
const prev = last.items;
const pv = (c) => (prev[c] ? prev[c].val : 0), pc = (c) => (prev[c] ? prev[c].cost : 0);

const items = {}; const tips = [];
const holdCodes = new Set(model.POSITIONS.hold.map((p) => p.code));
let dCost = 0, dVal = 0;
for (const [key, idx] of Object.entries(ETF_KEYS)) {
  const p = nextHold(holdByIdx(idx).code);
  const close = typeof input.etf[key] === "object" ? input.etf[key].close : input.etf[key];
  const cost = r2(p.qty * p.cost), val = r2(p.qty * close);
  items[p.code] = { name: p.sym, qty: p.qty, cost, val, pl: r2(val - cost) };
  dCost += cost - pc(p.code); dVal += val - pv(p.code);
  if (!prev[p.code]) tips.push(p.code + " 是本期新建仓，其 Δ 会计入当日（当日会偏大，需人工核对）");
}
for (const f of input.otc) {
  const known = otcNow.funds.find((x) => x.code === f.code);
  const name = (prev[f.code] || {}).name || String(known.name).replace(/[（(].*$/, "").slice(0, 8);
  if (!(prev[f.code] || {}).name) tips.push("快照短名 " + f.code + " 由基金名截取（上一期快照没有它，建议核对）");
  const cost = r2(f.value - f.pnl);
  items[f.code] = { name, qty: f.qty, cost, val: r2(f.value), pl: r2(f.pnl) };
  dCost += cost - pc(f.code); dVal += r2(f.value) - pv(f.code);
}
const sumBy = (pick, field) => r2(Object.entries(items).filter(([c]) => pick(c)).reduce((a, [, it]) => a + it[field], 0));
const pl = sumBy(() => true, "pl");
const dayOtc = r2(input.otc.reduce((a, f) => a + f.day, 0));
const dayIn = r2(dVal - dCost);
const day = Number.isFinite(input.day) ? r2(input.day) : r2(dayIn + dayOtc);
const dCash = r2(input.cash - last.cash);
const flow = r2(dCost + dCash);
const totalVal = sumBy(() => true, "val");
const inVal = sumBy((c) => holdCodes.has(c), "val"), otcVal = sumBy((c) => !holdCodes.has(c), "val");

/* ---------- 改文本（全部定点替换，保留既有注释） ---------- */
const changes = [];
let hardFail = false;
/* 定点替换。两个坑（2026-09-23 干跑抓到）：
   ① 替换串里要用 $1/$2 回填捕获组 → 必须走**字符串式** replace；用 () => repl 会把 $1 原样写进文件。
   ② 判定「有没有变化」要比较替换**后**的整串，不能拿匹配到的片段和替换串比（$1 未展开，永远不相等）。 */
const sub1 = (src, re, repl, label) => {
  const m = src.match(re);
  if (!m) { changes.push("✗ 找不到锚点：" + label); hardFail = true; return src; }
  const out = src.replace(re, repl);
  if (out === src) return src;
  /* 标签里把 $1/$2 展开成真实文本，否则读起来是 `→ $12026-09-24$2`，看不出改成了什么 */
  const shown = repl.replace(/\$(\d)/g, (_, i) => (m[+i] === undefined ? "" : m[+i]));
  changes.push("· " + label + "：" + m[0].trim().replace(/\s+/g, " ").slice(0, 70) + " → " + shown.trim().replace(/\s+/g, " ").slice(0, 70));
  return out;
};
let dataSrc = dataSrc0, posSrc = posSrc0;
/* DEFAULT：五只场内报价。chg 优先用输入给的（App 读到的），否则由文件里的旧 close 推。
   ⚠ 键与 `{` 之间是对齐空格（`kr:   { close: …`），所以用 \s* 而不是一个空格 —— 初版写死一个空格，
     etfNdx/etfSpx（单个空格）能匹配、kr/n225/hkus（三个空格）整条找不到锚点。 */
for (const key of Object.keys(ETF_KEYS)) {
  const close = typeof input.etf[key] === "object" ? input.etf[key].close : input.etf[key];
  const given = typeof input.etf[key] === "object" ? input.etf[key].chg : undefined;
  const chg = Number.isFinite(given) ? r3(given) : r3((close / model.DEFAULT[key].close - 1) * 100);
  dataSrc = sub1(dataSrc, new RegExp("(" + key + ":\\s*\\{ close: )[-0-9.]+(, chg: )[-0-9.]+", "m"),
    "$1" + num(close, 3) + "$2" + num(chg, 3), key + " close/chg");
  dataSrc = sub1(dataSrc, new RegExp("(" + key + ":\\s*\\{[^\\n]*priceDate: \")[\\d-]+(\")", "m"), "$1" + input.date + "$2", key + " priceDate");
  if (close > model.DEFAULT[key].ath) {
    dataSrc = sub1(dataSrc, new RegExp("(" + key + ":\\s*\\{[^\\n]*ath: )[-0-9.]+", "m"), "$1" + num(close, 3), key + " ath（创新高）");
    dataSrc = sub1(dataSrc, new RegExp("(" + key + ":\\s*\\{[^\\n]*athDate: \")[\\d-]+(\")", "m"), "$1" + input.date + "$2", key + " athDate");
  }
  if (close < model.DEFAULT[key].low52) dataSrc = sub1(dataSrc, new RegExp("(" + key + ":\\s*\\{[^\\n]*low52: )[-0-9.]+", "m"), "$1" + num(close, 3), key + " low52（创新低）");
}
/* 持仓份数/成本（cost 与 idxAtCost 必须一起改：门禁强制两者相等） */
for (const h of input.hold || []) {
  dataSrc = sub1(dataSrc, new RegExp("(code: \"" + h.code + "\"[^\\n]*?qty: )\\d+", "m"), "$1" + h.qty, h.code + " qty");
  dataSrc = sub1(dataSrc, new RegExp("(code: \"" + h.code + "\"[^\\n]*?cost: )[-0-9.]+(, idxAtCost: )[-0-9.]+", "m"),
    "$1" + num(h.cost, 10) + "$2" + num(h.cost, 10), h.code + " cost/idxAtCost");
}
/* 流水：插到 log: [ 之后（新的在最上面） */
if ((input.trades || []).length) {
  const lines = input.trades.map((e) => "    { d: \"" + e.d + "\", act: \"" + e.act + "\", sym: \"" + (e.sym || "") + "\", qty: " + e.qty +
    ", cost: " + num(e.cost, 3) + (Number.isFinite(e.realized) ? ", realized: " + num(e.realized, 2) : "") +
    (e.note ? ", note: \"" + String(e.note).replace(/"/g, "'") + "\"" : "") + " },").join("\n");
  dataSrc = sub1(dataSrc, /(^  log: \[\n)/m, "$1" + lines + "\n", "流水 " + input.trades.length + " 笔插到 log 顶部");
}
/* ACCT_STATS */
dataSrc = sub1(dataSrc, /(const ACCT_STATS = \{\n  updated: ")[\d-]+(")/m, "$1" + (input.acct?.updated || input.date) + "$2", "ACCT_STATS.updated");
for (const k of ["pnl", "pnlPct"]) if (Number.isFinite(input.acct?.[k]))
  dataSrc = sub1(dataSrc, new RegExp("(^  " + k + ": )[-0-9.]+", "m"), "$1" + num(input.acct[k], 2), "ACCT_STATS." + k);
/* OTC：updated / cash */
posSrc = sub1(posSrc, /(const OTC = \{\n  updated: ")[\d-]+(")/m, "$1" + input.date + "$2", "OTC.updated");
posSrc = sub1(posSrc, /(\n  cash: )[-0-9.]+/m, "$1" + num(input.cash, 2), "OTC.cash");
/* OTC：逐只场外（从 code: 起到下一条之前；只动字段值，注释一行不碰） */
for (const f of input.otc) {
  const at = posSrc.indexOf('code: "' + f.code + '"');
  if (at < 0) { changes.push("✗ OTC.funds 里找不到 " + f.code); hardFail = true; continue; }
  const nextEntry = posSrc.indexOf("\n    { name: ", at);
  const arrEnd = posSrc.indexOf("\n  ],", at);
  const end = nextEntry < 0 || (arrEnd >= 0 && arrEnd < nextEntry) ? arrEnd : nextEntry;
  const seg = posSrc.slice(at, end);
  const before = seg;
  const out = seg
    .replace(/(\bvalue: )[-0-9.]+/, "$1" + num(f.value, 2))
    .replace(/(\bday: )(null|[-0-9.]+)/, "$1" + num(f.day, 2))
    .replace(/(\bpnl: )[-0-9.]+/, "$1" + num(f.pnl, 2))
    .replace(/(\brate: )[-0-9.]+/, "$1" + r2((f.pnl / (f.value - f.pnl)) * 100).toFixed(2))
    .replace(/(\bupd: ")[^"]*(")/, "$1" + (f.upd || input.date + " 20:00") + "$2")
    .replace(/(nav: \{ close: )[-0-9.]+/, "$1" + num(f.navClose, 4))
    .replace(/(nav: \{ close: [-0-9.]+, closeDate: ")[\d-]+(")/, "$1" + f.navDate + "$2");
  if (out !== before) changes.push("· OTC " + f.code + "：value " + num(f.value, 2) + " / day " + num(f.day, 2) + " / pnl " + num(f.pnl, 2) +
    " / rate " + r2((f.pnl / (f.value - f.pnl)) * 100).toFixed(2) + " / upd " + (f.upd || input.date + " 20:00") + " / nav " + num(f.navClose, 4) + "@" + f.navDate);
  posSrc = posSrc.slice(0, at) + out + posSrc.slice(at + seg.length);
}
/* 快照：追加一期（含自动生成的注释合计） */
const noteHead = "⚠ 本页" + (missing.length ? "仅 " + input.otc.length + "/" + otcNow.funds.length + " 只（其余沿用旧值）" : input.otc.length + "/" + otcNow.funds.length + " 全覆盖") +
  "；总资产 " + num(r2(totalVal + input.cash), 2) + " = 场内 " + num(inVal, 2) + " + 场外 " + num(otcVal, 2) + " + 现金 " + num(input.cash, 2) +
  "；累计浮盈亏 " + num(pl, 2) + "；当日 " + num(day, 2) + "（场内 " + num(dayIn, 2) + " + 场外 " + num(dayOtc, 2) + "）" +
  "；flow " + num(flow, 2) + " = Δ成本 " + num(dCost, 2) + " + Δ现金 " + num(dCash, 2) +
  ((input.pending || []).length ? "；在途 " + input.pending.map((p) => p.code + " " + p.amount).join("、") + "（市值已含、份额未含）" : "");
const period = "  { d: \"" + input.date + "\", cash: " + num(input.cash, 2) + ", pl: " + num(pl, 2) +
  ", day: " + num(day, 2) + ", flow: " + num(flow, 2) + ",\n" +
  "    /* " + [noteHead, input.note].filter(Boolean).join("。") + " */\n" +
  "    items: {\n" + Object.entries(items).map(([c, it]) =>
    "        " + JSON.stringify(c) + ": { name: " + JSON.stringify(it.name) + ", qty: " + num(it.qty, 2) + ", cost: " + num(it.cost, 2) +
    ", val: " + num(it.val, 2) + ", pl: " + num(it.pl, 2) + " },").join("\n") + "\n    } },\n";
{
  const block = posSrc.match(/^const SNAPSHOTS = \[[\s\S]*?^\];/m);
  if (!block) { changes.push("✗ 找不到 SNAPSHOTS 块"); hardFail = true; }
  else {
    const at = block[0].lastIndexOf("\n];");
    posSrc = posSrc.replace(block[0], () => block[0].slice(0, at) + "\n" + period + block[0].slice(at + 1));
    changes.push("· SNAPSHOTS 追加 " + input.date + " 期（items " + Object.keys(items).length + " 只 · pl " + num(pl, 2) + " · day " + num(day, 2) + " · flow " + num(flow, 2) + "）");
  }
}
for (const t of tips) changes.push("· 提示：" + t);

/* ---------- 输出 ---------- */
console.log("【" + (WRITE ? "落盘" : "干跑") + "】" + input.date + "  ｜ 场外 " + input.otc.length + "/" + otcNow.funds.length + " 只 ｜ 流水 " + (input.trades || []).length + " 笔 ｜ 改动 " + changes.filter((c) => c.startsWith("· ")).length + " 处");
for (const c of changes) console.log("  " + c);
if (hardFail) { console.error("\n✗ 有锚点没找到 → 未写盘。请检查对应字段是否被改过名/删过。"); process.exit(1); }
if (!WRITE) { console.log("\n（干跑：未写盘。确认无误后加 --write 落盘并跑门禁）"); process.exit(0); }

const backup = { data: dataSrc0, pos: posSrc0 };
writeFileSync(DATA_PATH, dataSrc); writeFileSync(POS_PATH, posSrc);
const tryRun = (file, args) => { try { execFileSync("node", [file, ...args], { stdio: "pipe" }); return null; } catch (e) { return String(e.stdout || "") + String(e.stderr || ""); } };
const bad = [];
const g1 = tryRun("scripts/check-data.mjs", []); if (g1) bad.push("check-data：\n" + g1.trim());
const g2 = tryRun("scripts/dom-check.mjs", []); if (g2) bad.push("dom-check：\n" + g2.trim().split("\n").filter((l) => l.includes("✗")).slice(0, 6).join("\n"));
if (bad.length) {
  writeFileSync(DATA_PATH, backup.data); writeFileSync(POS_PATH, backup.pos);
  console.error("\n✗ 门禁未通过 → 已回滚（两个文件均已还原）：\n" + bad.join("\n"));
  process.exit(1);
}
console.log("\n✓ 已落盘，门禁通过（check-data 含交叉一致性 ✓ · dom-check ✓）");
console.log("  仍需人工的两件：ACCT_STATS.monthly[当月]（若 App 给了新值）· AUTO 的 premiums（见 handoff.md SOP 第 6 步）");
