#!/usr/bin/env node
/* 场外基金的「净值区间」与「买点」刷新（2026-09-27 加）
 *
 * 为什么需要：
 *   体检的「买点」项要的是**每一笔申购时的净值**，而 OTC_LOG 里只记了金额（日期 + 金额 + 状态）；
 *   东财历史净值接口（api.fund.eastmoney.com/f10/lsjz）能按基金代码 + 日期区间拿到逐日净值，
 *   于是「申购日 → 当天净值」可以自动补齐，不用人工抄。顺带把 nav.hi / nav.lo（52 周区间）
 *   从人工维护改成自动计算 —— 之前那两个数是截图时手填的。
 *
 * 口径（与页面一致，别在这里另立一套）：
 *   · 52 周区间 = 最近 52 周内的净值最大 / 最小（DWJZ 单位净值，与 OTC.funds[].nav.close 同口径）
 *   · 某笔申购的净值 = 该申购日**或之前最近一个交易日**的净值（申购按当日净值确认，遇非交易日顺延）
 *   · 买点分位 = (该笔净值 − lo) / (hi − lo) × 100；多笔取平均 → 写进 nav.buyPct
 *   · 没有 OTC_LOG 的基金（支付宝渠道那两只）**不算 buyPct** —— 缺的是申购日期，不是净值
 *
 * 用法：node scripts/refresh-otc.mjs          只打印（dry-run）
 *      node scripts/refresh-otc.mjs --write  写回 positions.html
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "positions.html");
const WRITE = process.argv.includes("--write");
const H = { "User-Agent": "Mozilla/5.0", Referer: "https://fundf10.eastmoney.com/" };
const WEEKS52_MS = 364 * 86400000;

let src = readFileSync(FILE, "utf8");   // 循环里要逐只替换后累积，所以是 let
const ctx = vm.createContext({});
vm.runInContext(src.match(/^const OTC = \{[\s\S]*?^\};/m)[0] + "\nthis.O = OTC;", ctx);
vm.runInContext(src.match(/^const OTC_LOG = \{[\s\S]*?^\};/m)[0] + "\nthis.L = OTC_LOG;", ctx);
const OTC = ctx.O, OTC_LOG = ctx.L;

const iso = (d) => d.toISOString().slice(0, 10);

/* 逐页拉取（实测：该接口 pageSize **上限 20**，给再大也只回 20 条；startDate/endDate 也会被忽略，
   所以只能靠 pageIndex 翻页，用日期判断何时停）。一只基金一年约 250 个交易日 → 13~14 页。 */
async function navSeries(code, from, to) {
  const out = [];
  for (let pi = 1; pi <= 16; pi++) {
    const url = "https://api.fund.eastmoney.com/f10/lsjz?fundCode=" + code + "&pageIndex=" + pi + "&pageSize=20";
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const list = (j.Data && j.Data.LSJZList) || [];
    if (!list.length) break;
    let past = false;                       // 本页已翻到窗口之外 → 可以停
    for (const x of list) {
      const d = x.FSRQ, v = Number(x.DWJZ);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(v) || v <= 0) continue;
      if (d < from) { past = true; continue; }
      if (d > to) continue;
      out.push({ d, v });
    }
    if (past) break;
  }
  return out;
}

const today = new Date();
const from = iso(new Date(today.getTime() - WEEKS52_MS)), to = iso(today);
console.log("窗口 " + from + " → " + to + (WRITE ? "（写回）" : "（dry-run）") + "\n");

let out = "", changed = 0;
for (const f of OTC.funds) {
  const code = f.code;
  let series = [];
  try { series = await navSeries(code, from, to); } catch (e) { console.log(code.padEnd(7) + " 抓取失败：" + e.message); continue; }
  if (series.length < 20) { console.log(code.padEnd(7) + " 净值样本不足（" + series.length + " 条），跳过"); continue; }
  const ups = series.map((x) => x.v);
  const hi = Math.max(...ups), lo = Math.min(...ups);
  const hiDate = (series.find((x) => x.v === hi) || {}).d;   // ⚠ hi 改了就必须同步 hiDate，否则页面上的"高点日期"与新区间对不上
  const log = OTC_LOG[code] || [];
  /* 每笔申购取「该日或之前最近一个交易日」的净值 —— 遇非交易日（周末/节假日）顺延到前一日 */
  const sorted = series.slice().sort((a, b) => (a.d < b.d ? 1 : -1));   // 新 → 旧
  const pcts = [];
  for (const e of log) {
    const hit = sorted.find((x) => x.d <= e.d);
    if (hit) pcts.push((hit.v - lo) / (hi - lo) * 100);
  }
  const buyPct = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
  const old = (f.nav && (f.nav.hi + "/" + f.nav.lo)) || "—";
  console.log(code.padEnd(7) + (f.name || "").slice(0, 14).padEnd(15) +
    " 样本 " + String(series.length).padStart(3) + " 条 · " + series.at(-1).d + "~" + series[0].d +
    " · hi/lo " + hi.toFixed(4) + "/" + lo.toFixed(4) + "（原 " + old + "）" +
    " · 申购 " + String(log.length).padStart(3) + " 笔 → 买点 " + (buyPct === null ? "（无记录，不算）" : buyPct + "%"));
  /* 写回：只替换该只的 hi / lo / buyPct 三个数，其余字段一字不动 */
  if (!WRITE) continue;
  const before = src;
  /* ⚠ positions.html 里是 **JS 对象字面量**（code: "023402"，键不带引号），不是 JSON ——
     第一版按 JSON 写正则（"code": …）结果一处都没匹配上，白跑一轮。 */
  const re = new RegExp("(\\bcode:\\s*\"" + code + "\"[\\s\\S]{0,600}?\\bnav:\\s*\\{)([^}]*)(\\})");
  const m = src.match(re);
  if (!m) { console.log("      ⚠ 未定位到 nav 块，跳过写入"); continue; }
  let body = m[2]
    .replace(/\bhi:\s*[\d.]+/, "hi: " + hi)
    .replace(/\blo:\s*[\d.]+/, "lo: " + lo)
    .replace(/,\s*buyPct:\s*[\d.]+/, "")
    .replace(/,\s*buyPct:\s*null/, "");
  if (hiDate) body = /\bhiDate:/.test(body) ? body.replace(/\bhiDate:\s*"[^"]*"/, 'hiDate: "' + hiDate + '"') : body;
  if (buyPct !== null) body = body.replace(/\s*\}\s*$/, "") + ", buyPct: " + buyPct;   // 顺手去掉 lo 后面遗留的空格
  const after = src.replace(re, "$1" + body + "$3");
  if (after !== before) { src = after; changed++; }
}
if (WRITE) {
  if (changed) { writeFileSync(FILE, src); console.log("\n已写回 " + changed + " 只（hi / lo / buyPct）"); }
  else console.log("\n没有需要改动的（或没定位到 nav 块）");
}
