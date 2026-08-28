#!/usr/bin/env node
"use strict";
/* ============================================================
 * GitHub Actions 每日数据自动更新脚本
 * 行情链路（三层容灾）：
 *   1) Yahoo chart + Cookie/crumb 凭证（fc.yahoo.com → getcrumb）
 *   2) 429/401 指数退避重试（query1/query2 双端点）
 *   3) stooq CSV 全历史兜底（^ndx/^spx/^vix/^tnx）
 * 其余：frankfurter.app 汇率；CNN dataviz 恐贪（best-effort）。
 * 只重写 data.js 的 AUTO 字段；MANUAL 区（putcall/估值/CALENDAR/MONTHLY/DCA/thresholds）不触碰。
 * 退出码：0 有变更；42 无变化；1 锚点缺失或 NDx/SPx 双双失败。
 * 注意：本机（国内网络）无法直连以上数据源，属预期；本脚本设计运行于 GitHub Actions。
 * ============================================================ */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = join(ROOT, "data.js");
const H = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "application/json,text/csv,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

/* ---------- 网络层：429/401 退避重试 ---------- */
const sleep = ms => new Promise(s => setTimeout(s, ms));
async function get(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: H });
      if (r.status === 429 || r.status === 401) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
      return r;
    } catch (e) {
      err = e;
      if (!/^HTTP (429|401)$/.test(e.message)) break;   // 非限流错误不重试
      await sleep(1500 * (i + 1));
    }
  }
  throw err;
}
const getJSON = async (url, opt) => (await get(url, opt?.tries)).json();

/* ---------- Yahoo：cookie + crumb ---------- */
let jar = "", crumb = "";
async function yahooAuth() {
  if (crumb) return;
  try {
    const r = await fetch("https://fc.yahoo.com", { headers: H });
    const sc = r.headers.get("set-cookie");
    if (sc) jar = sc.split(/\n/).map(s => s.split(";")[0]).join("; ");
  } catch { /* fc.yahoo.com 偶发不可达，继续尝试无凭证请求 */ }
  try {
    crumb = await (await get("https://query1.finance.yahoo.com/v1/test/getcrumb")).text();
  } catch { /* 无 crumb 也可能放行 */ }
}
async function yahoo(symbol, range = "10y") {
  await yahooAuth();
  const s = encodeURIComponent(symbol);
  let lastErr;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const q = crumb ? `&crumb=${encodeURIComponent(crumb)}` : "";
        const ck = jar ? { Cookie: jar } : {};
        const r = await fetch(`https://${host}/v8/finance/chart/${s}?range=${range}&interval=1d${q}`, { headers: { ...H, ...ck } });
        if (r.status === 429 || r.status === 401) throw new Error(`HTTP ${r.status}`);
        if (!r.ok) throw new Error(`HTTP ${r.status} @ ${host}`);
        const res = (await r.json())?.chart?.result?.[0];
        const quote = res?.indicators?.quote?.[0];
        if (!res || !quote?.close) throw new Error("chart payload empty");
        return {
          dates: res.timestamp.map(ts => new Date(ts * 1000).toISOString().slice(0, 10)),
          ts: res.timestamp,
          close: quote.close, high: quote.high, low: quote.low,
        };
      } catch (e) {
        lastErr = e;
        if (/^HTTP (429|401)$/.test(e.message)) await sleep(2000 * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

/* ---------- stooq CSV 兜底（全历史日 K：Date,Open,High,Low,Close,Volume） ---------- */
async function stooq(sym) {
  const r = await get(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`);
  const t = await r.text();
  if (!/^Date/i.test(t)) throw new Error("stooq blocked: " + t.slice(0, 60));
  const rows = t.trim().split("\n").slice(1);
  const pick = i => rows.map(l => +l.split(",")[i]);
  return {
    dates: rows.map(l => l.split(",")[0]),
    ts: null,                                            // 无时间戳，metrics 内用收盘时刻近似
    close: pick(4), high: pick(2), low: pick(3),
  };
}
/* 主链路：Yahoo 失败转 stooq */
async function series(ySym, sSym, range = "10y") {
  try {
    return await yahoo(ySym, range);
  } catch (e) {
    console.warn(`WARN yahoo ${ySym}: ${e.message} → fallback stooq`);
    return stooq(sSym);
  }
}

/* ---------- 指标计算 ---------- */
const fmt2 = n => Math.round(n * 100) / 100;
function sma(arr, n) {
  if (arr.length < n) throw new Error(`bars ${arr.length} < ${n}`);
  return arr.slice(-n).reduce((s, x) => s + x, 0) / n;
}
/* 简易 RSI-14（窗口内单段均值，非 Wilder 递推；展示级精度足够） */
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
function metrics(d) {
  const c = d.close.filter(Number.isFinite);
  const h = d.high.filter(Number.isFinite);
  if (c.length < 260) throw new Error(`insufficient bars: ${c.length}`);
  const last = c[c.length - 1], prevClose = c[c.length - 2];
  let hiI = 0;
  h.forEach((v, i) => { if (v > h[hiI]) hiI = i; });
  const year = Math.max(...d.dates.map(x => +x.slice(0, 4)));
  let prevYr;
  for (let i = d.dates.length - 1; i >= 0; i--)
    if (+d.dates[i].slice(0, 4) === year - 1) { prevYr = d.close[i]; break; }
  /* stooq 无时间戳：以该日 20:00Z（≈16:00 EDT 收盘）近似 */
  const lastTs = d.ts ? d.ts[d.ts.length - 1] * 1000 : Date.parse(d.dates[d.dates.length - 1] + "T20:00:00Z");
  return {
    last, prevClose,
    chg: fmt2((last / prevClose - 1) * 100),
    ma50: Math.round(sma(c, 50)),
    ma200: Math.round(sma(c, 200)),
    rsi: Math.round(rsi(c) * 10) / 10,
    low52: Math.round(Math.min(...c.slice(-252))),
    ath: h[hiI], days: c.length - 1 - hiI,
    prevYr: Math.round(prevYr),
    usDate: d.dates[d.dates.length - 1],
    lastTs,
  };
}

/* ---------- 抓取 ---------- */
const F = {};          // 各字段产物
let okCore = false, okVix = false, okTnx = false, okFg = false, okFx = false;
try {
  const [ndxD, spxD] = await Promise.all([series("^NDX", "^ndx"), series("^GSPC", "^spx")]);
  const n = metrics(ndxD), sp = metrics(spxD);
  F.ndx = `  ndx:   { close: ${fmt2(n.last)}, ath: ${fmt2(n.ath)}, days: ${n.days}, chg: ${n.chg}, ma50: ${n.ma50}, ma200: ${n.ma200}, rsi: ${n.rsi}, low52: ${n.low52}, prevYr: ${n.prevYr} }`;
  F.spx = `  spx:   { close: ${fmt2(sp.last)}, ath: ${fmt2(sp.ath)}, days: ${sp.days}, chg: ${sp.chg}, ma50: ${sp.ma50}, ma200: ${sp.ma200}, rsi: ${sp.rsi}, low52: ${sp.low52}, prevYr: ${sp.prevYr} }`;
  F.date = `  date: "${n.usDate}"`;
  okCore = true;

  /* 时区与盘中判定：Yahoo 日线 bar 的 timestamp 是开盘时刻(09:30 ET)而非收盘，
     故以「bar 日期==运行日 且 运行时刻<16:00 ET」判定盘中；收盘时刻按 DST 推算 */
  const dstOf = ms => {
    const Y = new Date(ms).getUTCFullYear();
    const nthSun = (m, k) => { const d = new Date(Date.UTC(Y, m, 1)); while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1); d.setUTCDate(d.getUTCDate() + 7 * (k - 1)); return d.getTime(); };
    return ms >= nthSun(2, 2) && ms < nthSun(10, 1);
  };
  const nowMs = Date.now();
  const nowNyHM = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(nowMs);
  const todayNy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(nowMs);
  const intraday = n.usDate === todayNy && nowNyHM < "16:00";
  const abbr = dstOf(nowMs) ? "EDT" : "EST";
  const shanghai = ms => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
  F.intraday = `  intraday: ${intraday}, // AUTO：${intraday ? "盘中快照" : `美股 ${n.usDate} 收盘`}（${new Date(nowMs).toISOString().slice(0, 16)}Z 抓取）`;
  F.asOf = `  asOf: { us: "${n.usDate}", et: "${intraday ? nowNyHM : "16:00"} ${abbr}", local: "${shanghai(nowMs)}" },`;

  /* 月度涨跌幅：从日 K 按自然月聚合（月末收盘环比，当月为至今），自动写回 MONTHLY */
  const monthlyOf = (d, year) => {
    const lastByM = new Map();
    let base = null;
    for (let i = 0; i < d.dates.length; i++) {
      if (!Number.isFinite(d.close[i])) continue;
      const y = +d.dates[i].slice(0, 4), m = +d.dates[i].slice(5, 7);
      if (y === year - 1) base = d.close[i];          // 升序遍历，最后一次出现即去年末收盘
      if (y === year) lastByM.set(m, d.close[i]);
    }
    const out = [];
    let prev = base;
    for (let m = 1; m <= 12; m++) {
      if (!lastByM.has(m) || !prev) break;
      out.push(Math.round((lastByM.get(m) / prev - 1) * 1000) / 10);
      prev = lastByM.get(m);
    }
    return out;
  };
  const yNow = +n.usDate.slice(0, 4);
  const mN = monthlyOf(ndxD, yNow), mS = monthlyOf(spxD, yNow);
  if (mN.length >= 2 && mN.length === mS.length) {
    const rows = mN.map((v, i) => `  { m: "${i + 1}月", ndx: ${v}, spx: ${mS[i]} },`);
    F.monthly = `/* AUTO：月度涨跌幅(%，ETF 总回报近似=价格口径，月末收盘环比，当月为至今)由脚本从日K自动计算，勿手改 */\nconst MONTHLY = [\n${rows.join("\n")}\n];`;
  }

  /* VIX / TNX：best-effort（失败保留旧值，不影响核心） */
  try { F.vix = `  vix: ${fmt2((await series("^VIX", "^vix", "5d")).close.filter(Number.isFinite).at(-1))},`; okVix = true; }
  catch (e) { console.warn("WARN vix:", e.message); }
  try { F.tnx = `  tnx: ${fmt2((await series("^TNX", "^tnx", "5d")).close.filter(Number.isFinite).at(-1))},`; okTnx = true; }
  catch (e) { console.warn("WARN tnx:", e.message); }
  try { F.tnx2 = `  tnx2: ${fmt2((await series("^UST2Y", "^tn2", "5d")).close.filter(Number.isFinite).at(-1))},`; }
  catch (e) { console.warn("WARN tnx2:", e.message); }
} catch (e) { console.error("CORE FAIL:", e.message); }

try {
  /* CNN Fear & Greed（best-effort） */
  const j = await getJSON("https://production-dataviz.cnn.com/api/data/v1/fearandgreed/grapher/12mo.json");
  const g = j?.fear_and_greed ?? j?.fearAndGreed ?? {};
  const score = g.score ?? g.previous_close;
  if (Number.isFinite(score)) { F.fg = `  fg: ${Math.round(score)},`; okFg = true; }
} catch (e) { console.warn("WARN fg:", e.message); }

if (okCore) {
  try {
    const fxc = (await getJSON("https://api.frankfurter.app/latest?from=USD&to=CNY")).rates.CNY;
    F.fx = `  fx: ${fmt2(fxc)},`; okFx = true;
  } catch (e) { console.warn("WARN fx:", e.message); }
}

/* ---------- 估值 + Put/Call（best-effort，失败保留旧值） ----------
   来源：historyofmarket.com 开放 JSON（CC BY 4.0）/ CBOE 公开每日统计页 */
let peFwdV, peTtmV, pePctV, capeV, pcV;
try {
  const fp = await getJSON("https://historyofmarket.com/api/sp500/forward-pe.json");
  const c = fp.current;
  if (Number.isFinite(c?.trailing) && Number.isFinite(c?.forward)) {
    peFwdV = c.forward; peTtmV = c.trailing;
    const hist = (fp.forward || []).map(x => x?.value).filter(Number.isFinite);
    if (hist.length) pePctV = Math.round(100 * hist.filter(v => v <= peFwdV).length / hist.length);
  }
} catch (e) { console.warn("WARN pe:", e.message); }
try {
  const cp = await getJSON("https://historyofmarket.com/api/sp500/pe.json");
  const last = (cp.pe || []).at(-1);
  if (Number.isFinite(last?.value)) capeV = last.value; /* 周频，日更时数值常不变属正常 */
} catch (e) { console.warn("WARN cape:", e.message); }
try {
  const res = await get("https://www.cboe.com/markets/us/options/market-statistics/daily?mkt=cone");
  const s = (await res.text()).replaceAll('\\"', '"');
  const m = s.match(/"name":"TOTAL PUT\/CALL RATIO","value":"([\d.]+)"/)
         || s.match(/TOTAL PUT\/CALL RATIO[^0-9]{0,60}([\d]\.\d+)/);
  if (m) pcV = parseFloat(m[1]);
} catch (e) { console.warn("WARN putcall:", e.message); }

/* ---------- 改写 data.js ---------- */
let src = readFileSync(DATA_FILE, "utf8");
const missing = [];
const apply = (re, val, tag) => {
  if (!val) return;
  if (!re.test(src)) { console.error(`ANCHOR MISS [${tag}]`); missing.push(tag); return; }
  src = src.replace(re, val.replace(/\$/g, "$$$$"));
};
if (okCore) {
  apply(/  date: "[^"]+"/, F.date, "date");
  apply(/  intraday: (true|false),[^\n]*/, F.intraday, "intraday");
  apply(/  ndx:\s*\{[^}]+\}/, F.ndx, "ndx");
  apply(/  spx:\s*\{[^}]+\}/, F.spx, "spx");
  apply(/^  vix: [\d.]+,/m, F.vix, "vix");
  apply(/^  fg: \d+,/m, okFg ? F.fg : null, "fg");
  apply(/^  tnx: [\d.]+,/m, F.tnx, "tnx");
  apply(/^  tnx2: [\d.]+,/m, F.tnx2, "tnx2");
  apply(/^  fx: [\d.]+,/m, F.fx, "fx");
  apply(/  asOf: \{[^}]+\},/, F.asOf, "asOf");
  if (peFwdV) {
    const capeOld = parseFloat(src.match(/cape: ([\d.]+)/)?.[1]);
    const pctOld = parseInt(src.match(/pePct: (\d+)/)?.[1], 10);
    const cape = Number.isFinite(capeV) ? capeV : capeOld;
    const pct = Number.isFinite(pePctV) ? pePctV : pctOld;
    F.peLine = `  peFwd: ${peFwdV.toFixed(1)}, peTtm: ${peTtmV.toFixed(1)}, cape: ${cape.toFixed(1)}, pePct: ${pct}, // AUTO：S&P500 估值（historyofmarket.com, CC BY 4.0）`;
    apply(/^  peFwd: [^\n]*$/m, F.peLine, "pe");
  }
  if (pcV) apply(/^  putcall: [\d.]+,[^\n]*$/m, `  putcall: ${pcV}, // AUTO：CBOE 全品类总 Put/Call`, "putcall");
  apply(/\/\* [^\n]*月度涨跌幅[^\n]*\*\/\nconst MONTHLY = \[[\s\S]*?\];/, F.monthly, "monthly");
  /* 宏观（vix/tnx/fx）全部随行情刷新 → 置 null 视为同步；任一失败则不动该行，旧快照日期继续如实展示 */
  if (okVix && okTnx && okFx) {
    apply(/^  macroAsOf: ("[^"]+"|null),[^\n]*$/m,
      `  macroAsOf: null, // AUTO：宏观随当日收盘已同步`, "macroAsOf");
  }
}
if (missing.length) { console.error("fatal: anchors unresolved:", missing.join(",")); process.exit(1); }
if (!okCore) { console.error("core (NDX/SPX) unavailable, data.js untouched"); process.exit(1); }

const old = readFileSync(DATA_FILE, "utf8");
if (src === old) { console.log("no change"); process.exit(42); }
writeFileSync(DATA_FILE, src);

/* ---------- 摘要 ---------- */
const sum = [];
for (const line of src.split("\n"))
  if (/^  (date|intraday|ndx|spx|vix|fg|tnx|tnx2|fx|asOf|macroAsOf|putcall|peFwd|epsGrowth)/.test(line)) sum.push(line.trim());
console.log("--- data.js AUTO fields ---\n" + sum.join("\n"));
console.log(`status: core=${okCore} vix=${okVix} tnx=${okTnx} fx=${okFx} fg=${okFg} pe=${peFwdV ? "ok" : "keep"} cape=${Number.isFinite(capeV) ? "ok" : "keep"} pc=${pcV ?? "keep"}`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, "### 数据更新摘要\n```\n" + sum.join("\n") + "\n```\n");
