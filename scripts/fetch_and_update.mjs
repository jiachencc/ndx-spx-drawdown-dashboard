#!/usr/bin/env node
"use strict";
/* ============================================================
 * GitHub Actions 每日数据自动更新脚本
 * - 行情源：Yahoo Finance chart API（^NDX / ^GSPC / ^VIX / ^TNX，10 年日 K）
 * - 汇率源：frankfurter.app（USD/CNY）
 * - 恐贪源：CNN dataviz（尽力而为，失败保留旧值）
 * - 只重写 data.js 中 AUTO 字段：date/intraday/ndx/spx/vix/tnx/tnx2/fg/fx/asOf/macroAsOf
 *   putcall / 估值五项 / MONTHLY / MC_MAX / DCA_* / CALENDAR / thresholds 均不触碰（MANUAL）
 * - 退出码：0 有变更提交；42 无变化；1 数据源全挂或写出失败
 * 运行环境：GitHub Actions (Node 20+)。本机因反爬不可直连属预期现象。
 * ============================================================ */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = join(ROOT, "data.js");
const UA = { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36", Accept: "application/json,text/plain,*/*" } };

/* ---------- 网络 ---------- */
async function getJSON(url) {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
  return r.json();
}
/* Yahoo chart：range 内全部日 K；query1/query2 双端点容灾 */
async function yahoo(symbol, range = "10y") {
  const s = encodeURIComponent(symbol);
  let lastErr;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const j = await getJSON(`https://${host}/v8/finance/chart/${s}?range=${range}&interval=1d`);
      const res = j?.chart?.result?.[0];
      const q = res?.indicators?.quote?.[0];
      if (!res || !q || !q.close) throw new Error("chart payload empty");
      return {
        dates: res.timestamp.map(ts => new Date(ts * 1000).toISOString().slice(0, 10)),
        ts: res.timestamp,
        close: q.close, high: q.high, low: q.low,
      };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/* ---------- 指标计算 ---------- */
const fmt2 = n => Math.round(n * 100) / 100;
function sma(arr, n) {
  if (arr.length < n) throw new Error(`bars ${arr.length} < ${n}`);
  return arr.slice(-n).reduce((s, x) => s + x, 0) / n;
}
/* 简易 RSI-14（窗口内单段均值，非 Wilder 递推；对展示级精度足够） */
function rsi(closes) {
  const p = closes.slice(-15);
  let g = 0, l = 0;
  for (let i = 1; i < p.length; i++) {
    const d = p[i] - p[i - 1];
    d > 0 ? g += d : l -= d;
  }
  g /= 14; l /= 14;
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
function metrics({ dates, ts, close, high }) {
  const c = close.filter(Number.isFinite);
  const h = high.filter(Number.isFinite);
  const last = c[c.length - 1];
  const prevClose = c[c.length - 2];
  /* ATH：全区间最高价所在 bar 与末端的交易日距离 */
  let hiI = 0;
  h.forEach((v, i) => { if (v > h[hiI]) hiI = i; });
  const daysAgo = close.length - 1 - hiI;
  /* 去年年末收盘（YTD 基准） */
  const year = Math.max(...dates.map(d => +d.slice(0, 4)));
  let prevYr;
  for (let i = dates.length - 1; i >= 0; i--)
    if (+dates[i].slice(0, 4) === year - 1) { prevYr = close[i]; break; }
  const lastTs = ts[ts.length - 1];
  return {
    last, prevClose,
    chg: fmt2((last / prevClose - 1) * 100),
    ma50: Math.round(sma(c, 50)),
    ma200: Math.round(sma(c, 200)),
    rsi: Math.round(rsi(c) * 10) / 10,
    low52: Math.round(Math.min(...c.slice(-252))),
    ath: h[hiI], days: daysAgo,
    prevYr: Math.round(prevYr),
    usDate: dates[dates.length - 1],
    lastTs,
  };
}

/* ---------- 各源 ---------- */
let okCore = false, okFg = false;
const out = {};
try {
  const [ndxp, spxp, vixp, tnxp] = await Promise.all([
    yahoo("^NDX"), yahoo("^GSPC"), yahoo("^VIX", "5d"), yahoo("^TNX", "5d"),
  ]);
  const n = metrics(ndxp), s = metrics(spxp);
  out.ndx = `  ndx:   { close: ${fmt2(n.last)}, ath: ${fmt2(n.ath)}, days: ${n.days}, chg: ${n.chg}, ma50: ${n.ma50}, ma200: ${n.ma200}, rsi: ${n.rsi}, low52: ${n.low52}, prevYr: ${n.prevYr} }`;
  out.spx = `  spx:   { close: ${fmt2(s.last)}, ath: ${fmt2(s.ath)}, days: ${s.days}, chg: ${s.chg}, ma50: ${s.ma50}, ma200: ${s.ma200}, rsi: ${s.rsi}, low52: ${s.low52}, prevYr: ${s.prevYr} }`;
  /* 时区与盘中判定：显式 DST 规则（3 月第二个周日 ~ 11 月第一个周日为 EDT）；
     手动触发若处于盘中（<16:00 ET），如实标 intraday:true 并记录真实时刻 */
  const yCurMs = n.lastTs * 1000;
  const Y = new Date(yCurMs).getUTCFullYear();
  const nthSun = (m, k) => { const d = new Date(Date.UTC(Y, m, 1)); while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1); d.setUTCDate(d.getUTCDate() + 7 * (k - 1)); return d.getTime(); };
  const isDST = yCurMs >= nthSun(2, 2) && yCurMs < nthSun(10, 1);
  const abbr = isDST ? "EDT" : "EST";
  const offH = isDST ? 4 : 5;
  const nyHM = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(yCurMs);
  const closed = nyHM >= "16:00";          // 收盘价已定格
  const intraday = !closed;
  const etClock = closed ? "16:00" : nyHM;
  const cn = new Date(yCurMs + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 16);
  const local = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
  out.date = `  date: "${n.usDate}"`;
  out.intraday = `  intraday: ${intraday}, // AUTO：${intraday ? "盘中快照" : `美股 ${n.usDate} 收盘`}（${new Date().toISOString().slice(0, 16)}Z 抓取）`;
  out.asOf = `  asOf: { us: "${n.usDate}", et: "${etClock} ${abbr}", cn: "${cn}", tz: "${isDST ? "夏令时" : "冬令时"}(${abbr}·UTC-${offH})", local: "${local}" },`;
  out.vix = `  vix: ${fmt2(vixp.close.filter(Number.isFinite).at(-1))},`;
  out.tnx = `  tnx: ${fmt2(tnxp.close.filter(Number.isFinite).at(-1))},`;
  /* 2 年期：无统一代码，多候选尝试，失败保留旧值 */
  try {
    const t2 = await yahoo("^UST2Y", "5d").catch(() => yahoo("^02Y", "5d"));
    out.tnx2 = `  tnx2: ${fmt2(t2.close.filter(Number.isFinite).at(-1))},`;
  } catch { console.warn("WARN tnx2 failed, keep old"); }
  okCore = true;
} catch (e) { console.error("CORE FAIL:", e.message); }

try {
  /* CNN Fear & Greed（best effort） */
  const j = await getJSON("https://production-dataviz.cnn.com/api/data/v1/fearandgreed/grapher/12mo.json");
  const fgRoot = j?.fear_and_greed ?? j?.fearAndGreed ?? {};
  const score = fgRoot.score ?? fgRoot.previous_close;
  if (Number.isFinite(score)) { out.fg = `  fg: ${Math.round(score)},`; okFg = true; }
} catch (e) { console.warn("WARN fg failed, keep old:", e.message); }

if (okCore) {
  try {
    const fxc = (await getJSON("https://api.frankfurter.app/latest?from=USD&to=CNY")).rates.CNY;
    out.fx = `  fx: ${fmt2(fxc)},`;
  } catch (e) { console.warn("WARN fx failed:", e.message); }
}

/* ---------- 改写 data.js ---------- */
let src = readFileSync(DATA_FILE, "utf8");
const missing = [];
const apply = (re, val, tag) => {
  if (!val) return;
  if (!re.test(src)) { console.error(`ANCHOR MISS [${tag}]`); missing.push(tag); return; }
  src = src.replace(re, val.replace(/\$/g, "$$$$"));
};
if (okCore) {
  apply(/  date: "[^"]+"/, out.date, "date");
  apply(/  intraday: false[^,\n]*,[^\n]*/, out.intraday, "intraday");
  apply(/  ndx:\s*\{[^}]+\}/, out.ndx, "ndx");
  apply(/  spx:\s*\{[^}]+\}/, out.spx, "spx");
  apply(/^  vix: [\d.]+,/m, out.vix, "vix");
  apply(/^  fg: \d+,/m, okFg ? out.fg : null, "fg");
  apply(/^  tnx: [\d.]+,/m, out.tnx, "tnx");
  apply(/^  tnx2: [\d.]+,/m, out.tnx2, "tnx2");
  apply(/^  fx: [\d.]+,/m, out.fx, "fx");
  apply(/  asOf: \{[^}]+\},/, out.asOf, "asOf");
  /* macroAsOf：核心行情已自动刷新 → 视为同步填 null */
  apply(/^  macroAsOf: ("[^"]+"|null),[^\n]*$/m,
    `  macroAsOf: null, // AUTO：宏观随当日收盘已同步`, "macroAsOf");
}
if (missing.length) { console.error("fatal: anchors unresolved:", missing.join(",")); process.exit(1); }
const old = readFileSync(DATA_FILE, "utf8");
if (src === old) { console.log("no change"); process.exit(42); }
writeFileSync(DATA_FILE, src);

/* ---------- 输出摘要 ---------- */
const sum = [];
for (const line of src.split("\n")) if (/^  (date|intraday|ndx|spx|vix|fg|tnx|tnx2|fx|asOf|macroAsOf)/.test(line)) sum.push(line.trim());
console.log("--- updated data.js fields ---\n" + sum.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, "### 数据更新摘要\n```\n" + sum.join("\n") + "\n```\n");
}
console.log(okCore ? (okFg ? "OK core+fg" : "OK core (fg kept old)") : "PARTIAL: core failed, nothing reliable written");
