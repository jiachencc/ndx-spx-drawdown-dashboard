#!/usr/bin/env node
"use strict";
/* Source-aware update transaction. Never run when imported by tests.
 * Daily provenance is independent of the fetch clock. Failed sources retain values.
 * Full historical reconciliation is a publication gate; no private data is logged.
 * Exit 0: changed or no change. Exit 1: validation/core failure; original file untouched. */
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { readModel, validateModel, metrics, monthly, createRecorder, stableBusiness, replaceConst, replaceMember, atomicWrite, auditFiles, isDate } from "./data-quality.mjs";
const ROOT = new URL("../", import.meta.url);
const HEADERS = { "User-Agent": "Mozilla/5.0", Accept: "application/json,text/csv,text/html,*/*" };

export async function get(url, options = {}) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { ...options, headers: { ...HEADERS, ...options.headers }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) { const error = new Error("HTTP " + r.status); error.retry = r.status === 429 || r.status >= 500; throw error; }
      return r;
    } catch (e) {
      last = e;
      if (!e.retry || i === 2) break;
      await new Promise(resolve => setTimeout(resolve, (i + 1) * 1000));
    }
  }
  throw last;
}
const json = async (url, opts) => (await get(url, opts)).json();
let authPromise;
async function yahooAuth() {
  if (!authPromise) authPromise = (async () => {
    let cookie = "", crumb = "";
    try {
      // fc.yahoo.com may intentionally return 404 while setting the auth cookie.
      const r = await fetch("https://fc.yahoo.com", { headers: HEADERS, signal: AbortSignal.timeout(10000) });
      cookie = (r.headers.getSetCookie?.() || []).map(s => s.split(";")[0]).join("; ");
      if (cookie) crumb = (await (await get("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { Cookie: cookie } })).text()).trim();
      if (!/^[\w./=-]+$/.test(crumb)) crumb = "";
    } catch { /* Chart can also work without credentials. */ }
    return { cookie, crumb };
  })();
  return authPromise;
}
async function series(symbol, fallback, range = "10y") {
  const auth = await yahooAuth();
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const q = auth.crumb ? "&crumb=" + encodeURIComponent(auth.crumb) : "";
      const j = await json("https://" + host + "/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=" + range + "&interval=1d" + q, { headers: auth.cookie ? { Cookie: auth.cookie } : {} });
      const r = j?.chart?.result?.[0], quote = r?.indicators?.quote?.[0];
      if (!Array.isArray(r?.timestamp) || !quote?.close) throw new Error("chart payload empty");
      return { dates: r.timestamp.map(ts => new Date(ts * 1000).toISOString().slice(0, 10)), close: quote.close, high: quote.high, low: quote.low, source: "Yahoo " + symbol };
    } catch (e) { console.warn("source warning:", symbol, host, e.message); }
  }
  const text = await (await get("https://stooq.com/q/d/l/?s=" + encodeURIComponent(fallback) + "&i=d")).text();
  if (!/^Date,/.test(text)) throw new Error("stooq data unavailable " + symbol);
  const rows = text.trim().split(/\r?\n/).slice(1).map(r => r.split(","));
  return { dates: rows.map(r => r[0]), close: rows.map(r => +r[4]), high: rows.map(r => +r[2]), low: rows.map(r => +r[3]), source: "Stooq " + fallback };
}
export function sourceDate(value) {
  if (typeof value === "string") { const s = value.slice(0, 10); if (isDate(s)) return s; }
  // Numeric timestamps from providers are converted, not replaced with the fetch clock.
  if (Number.isFinite(value) && value > 0) {
    const d = new Date(value < 1e11 ? value * 1000 : value);
    if (Number.isFinite(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}
function latest(raw) {
  const i = raw.close.findLastIndex(Number.isFinite);
  if (i < 0 || !isDate(raw.dates[i])) throw new Error("latest dated quote missing");
  return { value: raw.close[i], date: raw.dates[i] };
}
const rounded = (n, dp = 2) => +n.toFixed(dp);

export async function main({ root = ROOT, now = new Date(), seriesProvider = series } = {}) {
  const gate = auditFiles(root);
  if (gate.length) throw new Error("Pre-update quality gate failed (original data preserved):\n" + gate.join("\n"));
  const dataFile = fileURLToPath(new URL("data.js", root));
  const oldSrc = readFileSync(dataFile, "utf8"), old = readModel(oldSrc), next = structuredClone(old);
  const rec = createRecorder(old.SOURCE_META, now);
  const d = next.DEFAULT;
  const dayNY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const clockNY = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  function accept(key, value, asOf, source, extra) {
    if (!Number.isFinite(value)) throw new Error(key + ": non-finite value");
    const positive = ["vix", "fx", "putcall", "peFwd", "peTtm", "ndxPeFwd", "cape"].includes(key);
    if (positive && value <= 0) throw new Error(key + ": nonpositive");
    if (["fg", "pePct", "ndxPePct"].includes(key) && (value < 0 || value > 100)) throw new Error(key + ": outside range");
    rec.success(key, asOf, source, extra); d[key] = value;
  }
  async function attempt(keys, provider, task) {
    const saved = keys.map(k => ({ key: k, value: d[k], meta: rec.meta[k] ? structuredClone(rec.meta[k]) : null }));
    try { await task(); }
    catch (e) {
      saved.forEach(s => { if (s.value !== undefined) d[s.key] = s.value; if (s.meta) rec.meta[s.key] = s.meta; else delete rec.meta[s.key]; rec.failure(s.key, provider, e.message); });
      console.warn("retained:", keys.join(","), e.message);
    }
  }
  let core = 0;
  const coreResults = await Promise.allSettled([["ndx", "^NDX", "^ndx"], ["spx", "^GSPC", "^spx"]].map(async ([key, symbol, fallback]) => {
    const raw = await seriesProvider(symbol, fallback), result = metrics(raw);
    if (result.date > dayNY) throw new Error("future US date");
    return { key, raw, result };
  }));
  for (let i = 0; i < coreResults.length; i++) {
    const r = coreResults[i], key = i === 0 ? "ndx" : "spx";
    if (r.status === "rejected") { rec.failure(key, "Yahoo/Stooq", r.reason.message); continue; }
    const { raw, result } = r.value;
    try {
      rec.success(key, result.date, raw.source, { methodology: "10y available high; 52w intraday range; simple-window RSI14" });
      const { date, rows, ...quote } = result; d[key] = quote; core++;
    } catch (e) { rec.failure(key, raw.source, e.message); }
  }
  if (!core) throw new Error("Both core indices unavailable; original file untouched");
  // Mixed dates are never advertised as one fully synchronized snapshot.
  if (core === 2 && rec.meta.ndx.asOf === rec.meta.spx.asOf) {
    const nr = coreResults[0].value.result, sr = coreResults[1].value.result;
    const n = monthly(nr.rows), s = monthly(sr.rows);
    if (n.length && n.length === s.length) next.MONTHLY = n.map((v, i) => ({ m: (i + 1) + "月", ndx: rounded(v, 4), spx: rounded(s[i], 4) }));
    rec.success("monthly", nr.date, "NDX/SPX close-to-close aggregation");
  } else rec.failure("monthly", "NDX/SPX", "Core dates not synchronized; previous monthly table retained");
  const coreDate = rec.meta.ndx?.asOf || old.DEFAULT.date;
  d.date = coreDate;
  d.intraday = coreDate === dayNY && clockNY >= "09:30" && clockNY < "16:00";
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).formatToParts(now).find(p => p.type === "timeZoneName").value;
  d.asOf = { us: coreDate, et: (d.intraday ? clockNY : "16:00") + " " + zone, local: now.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }) };
  d.macroAsOf = null; // Legacy compatibility only: UI reads SOURCE_META, never this global flag.
  await Promise.all([
    ...[["vix", "^VIX", "^vix"], ["tnx", "^TNX", "^tnx"], ["tnx2", "^UST2Y", "^tn2"]].map(([key, symbol, fallback]) => attempt([key], "Yahoo/Stooq", async () => {
      const raw = await seriesProvider(symbol, fallback, "5d"), point = latest(raw);
      accept(key, rounded(point.value, 3), point.date, raw.source);
    })),
    attempt(["fg"], "CNN Fear & Greed", async () => {
      const j = await json("https://production-dataviz.cnn.com/api/data/v1/fearandgreed/grapher/12mo.json");
      const g = j.fear_and_greed || j.fearAndGreed;
      accept("fg", Math.round(g?.score), sourceDate(g?.timestamp || g?.date), "CNN Fear & Greed");
    }),
    attempt(["fx"], "Frankfurter", async () => {
      const j = await json("https://api.frankfurter.app/latest?from=USD&to=CNY");
      accept("fx", rounded(j.rates?.CNY, 4), sourceDate(j.date), "Frankfurter");
    })
  ]);
  for (const [market, keys] of [["sp500", ["peFwd", "peTtm", "pePct"]], ["ndx", ["ndxPeFwd", "ndxPePct"]]]) {
    await attempt(keys, "History of Market " + market, async () => {
      const j = await json("https://historyofmarket.com/api/" + market + "/forward-pe.json");
      const c = j.current, history = (j.forward || []).filter(p => Number.isFinite(p.value));
      const last = history.at(-1);
      // Use an explicitly dated current observation; only use historical last date if value matches.
      const asOf = sourceDate(c?.date || c?.asOf) || (last?.value === c?.forward ? sourceDate(last?.date) : null);
      const percentile = history.length ? Math.round(100 * history.filter(p => p.value <= c.forward).length / history.length) : NaN;
      if (!isDate(asOf) || !Number.isFinite(c?.forward) || !Number.isFinite(percentile)) throw new Error("dated valuation observation missing");
      if (history.some((p, i) => !sourceDate(p.date) || sourceDate(p.date) > asOf || (i && sourceDate(p.date) <= sourceDate(history[i - 1].date)))) throw new Error("valuation history dates invalid or beyond current observation");
      if (market === "sp500") {
        if (!Number.isFinite(c.trailing)) throw new Error("trailing PE missing");
        accept("peFwd", c.forward, asOf, "History of Market sp500"); accept("peTtm", c.trailing, asOf, "History of Market sp500"); accept("pePct", percentile, asOf, "History of Market sp500");
      } else { accept("ndxPeFwd", c.forward, asOf, "History of Market ndx"); accept("ndxPePct", percentile, asOf, "History of Market ndx"); }
    });
  }
  // /sp500/pe.json carries two monthly series: `pe` (trailing; its last point can lag months) and
  // `cape` (Shiller cyclically adjusted). Take `cape` explicitly — the dashboard previously showed
  // the wrong series (pe 27.89 @2026-03-01 instead of cape 41.09 @2026-09-11).
  await attempt(["cape"], "History of Market sp500 (CAPE)", async () => {
    const j = await json("https://historyofmarket.com/api/sp500/pe.json");
    const point = (j.cape || []).filter(p => Number.isFinite(p.value)).at(-1);
    const asOf = sourceDate(point?.date);
    if (!isDate(asOf) || !Number.isFinite(point?.value) || !(point.value > 0)) throw new Error("dated CAPE observation missing");
    accept("cape", point.value, asOf, "History of Market sp500 (CAPE series, CC BY 4.0)");
  });
  await attempt(["putcall"], "CBOE", async () => {
    const text = (await (await get("https://www.cboe.com/markets/us/options/market-statistics/daily?mkt=cone")).text()).replaceAll('\\"', '"');
    const match = text.match(/"name":"TOTAL PUT\/CALL RATIO","value":"([\d.]+)"/);
    const date = text.match(/"(?:tradeDate|trade_date)":"(\d{4}-\d{2}-\d{2})"/);
    if (!match || !date) throw new Error("dated TOTAL PUT/CALL observation unavailable");
    accept("putcall", +match[1], date[1], "CBOE total put/call");
  });
  const etfs = { "159941": "etfNdx", "513650": "etfSpx", "513310": "kr", "513880": "n225", "160644": "hkus" };
  for (const [code, key] of Object.entries(etfs)) {
    let quote;
    await attempt([key], "Tencent daily bars", async () => {
      const sym = (/^(15|16)/.test(code) ? "sz" : "sh") + code;
      const j = await json("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" + sym + ",day,,,270,qfq");
      const b = j.data?.[sym], bars = b?.qfqday || b?.day;
      if (!Array.isArray(bars) || bars.length < 250) throw new Error("ETF bars missing");
      const last = bars.at(-1), prev = bars.at(-2), w = bars.slice(-250);
      if (bars.some((r, i) => !isDate(r[0]) || ![r[2], r[3], r[4]].every(v => Number.isFinite(+v) && +v > 0) || +r[3] < +r[2] || +r[4] > +r[2] || (i && r[0] <= bars[i - 1][0]))) throw new Error("invalid ETF bars");
      const high = w.reduce((a, r) => +r[3] > +a[3] ? r : a, w[0]);
      const year = last[0].slice(0, 4), prevYear = bars.filter(r => r[0].slice(0, 4) < year).at(-1);
      if (!prevYear) throw new Error("ETF previous year close unavailable");
      const q = { close: +last[2], chg: rounded((+last[2] / +prev[2] - 1) * 100), low52: Math.min(...w.map(r => +r[4])), ath: +high[3], athDate: high[0], prevYr: +prevYear[2], priceDate: last[0] };
      rec.success(key, last[0], "Tencent " + sym + " qfq (latest price)"); d[key] = q; quote = q;
    });
    await attempt(["premium:" + code], "Eastmoney NAV + Tencent price", async () => {
      if (!quote) throw new Error("current dated ETF quote unavailable");
      const j = await json("https://api.fund.eastmoney.com/f10/lsjz?fundCode=" + code + "&pageIndex=1&pageSize=8", { headers: { Referer: "https://fundf10.eastmoney.com/" } });
      const nav = j.Data?.LSJZList?.[0];
      if (!nav || !(+nav.DWJZ > 0) || !isDate(nav.FSRQ) || nav.FSRQ > quote.priceDate) throw new Error("NAV date/value invalid");
      const value = { pct: rounded((quote.close / +nav.DWJZ - 1) * 100, 1), nav: +nav.DWJZ, navDate: nav.FSRQ, priceDate: quote.priceDate };
      rec.success("premium:" + code, nav.FSRQ, "Eastmoney NAV + Tencent price", { priceDate: quote.priceDate, basis: "asynchronous price/NAV ratio, not contemporaneous premium" });
      next.POSITIONS.premiums[code] = value; // Merge per code; failed siblings are never removed.
    });
  }
  next.SOURCE_META = rec.meta;
  const candidateErrors = validateModel(next);
  if (candidateErrors.length) throw new Error("Candidate rejected: " + candidateErrors.join("; "));
  // Fetch-only timestamps do not produce daily commits on unchanged source observations.
  const contentOf = model => { const c = structuredClone(model); delete c.DEFAULT.asOf.local; c.SOURCE_META = stableBusiness(c.SOURCE_META); return c; };
  if (JSON.stringify(contentOf(next)) === JSON.stringify(contentOf(old))) { console.log("No business data change; exit 0"); return { changed: false }; }
  let src = replaceConst(oldSrc, "DEFAULT", d);
  // The single stamp comment inside DEFAULT is refreshed here; per-source provenance lives in SOURCE_META.
  src = src.replace(/(\n  intraday: [^\n]*?)\/\/[^\n]*/, "$1// AUTO：美股 " + d.date + " 收盘（" + now.toISOString().slice(0, 16) + "Z 抓取）");
  src = src.replace(/^const MONTHLY = \[[\s\S]*?^\];/m, () => "const MONTHLY = " + JSON.stringify(next.MONTHLY, null, 2) + ";");
  src = replaceMember(src, "premiums", next.POSITIONS.premiums);
  if (!/\/\* AUTO_META_START:[\s\S]*?\/\* AUTO_META_END \*\//.test(src)) throw new Error("provenance anchor missing");
  src = src.replace(/\/\* AUTO_META_START:[\s\S]*?\/\* AUTO_META_END \*\//, () => "/* AUTO_META_START: source dates, not fetch dates. */\nconst SOURCE_META = " + JSON.stringify(rec.meta, null, 2) + ";\n/* AUTO_META_END */");
  const final = readModel(src), errors = validateModel(final);
  if (errors.length) throw new Error("Serialized candidate failed: " + errors.join("; "));
  if (JSON.stringify(final.POSITIONS.hold) !== JSON.stringify(old.POSITIONS.hold) || JSON.stringify(final.POSITIONS.log) !== JSON.stringify(old.POSITIONS.log)) throw new Error("manual holdings changed unexpectedly");
  // Re-check source file and historical audit just before commit; do not overwrite concurrent edits.
  if (readFileSync(dataFile, "utf8") !== oldSrc) throw new Error("data.js changed during fetch; abort");
  const lastGate = auditFiles(root);
  if (lastGate.length) throw new Error("Pre-write audit failed: " + lastGate.join("; "));
  atomicWrite(dataFile, src);
  const lines = Object.entries(rec.meta).map(([k, m]) => k + ": " + m.status + ", source date=" + (m.asOf || "unknown"));
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "### Source status\n\n" + lines.map(s => "- " + s).join("\n") + "\n");
  return { changed: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
