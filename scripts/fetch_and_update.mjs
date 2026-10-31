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
/* 新浪 gb_$ndx 的报价时间戳是**北京时间**（例「2026-10-17 05:30:00」= 美东 10-16 17:30）。
   `sourceHealth` 用**美东**日期判新鲜度 → 直接 slice(0,10) 会得到「明天」，被判定「未核验」✗。
   2026-10-17 实测：crosscheck 每天其实都跑成功，却常年显示未核验（假警告）。
   这里换算成美东日期再存；时间戳没有时区，按 +08:00 解析。 */
function sinaTimestampToET(s) {
  const m = String(s || "").match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (!m) return "";
  const t = Date.parse(m[1] + "T" + m[2] + "+08:00");
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(t));
}

/* retries 可覆盖（2026-10-17 加）：Yahoo 现在按 IP 限流（429），默认 3 次重试 × 2 个 host
   会白跑 6 次、多等十几秒；对「已知不可靠、且有兜底」的源传 retries:1 立刻转向下一个。 */
export async function get(url, options = {}) {
  const { retries = 3, timeout = 15000, ...init } = options;
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { ...HEADERS, ...init.headers }, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) { const error = new Error("HTTP " + r.status); error.retry = r.status === 429 || r.status >= 500; throw error; }
      return r;
    } catch (e) {
      last = e;
      if (!e.retry || i === retries - 1) break;
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
/* 腾讯美股指数兜底（2026-09-27 加）—— 起因：Yahoo ^NDX/^GSPC 全 403（两个 host 都一样）、
   stooq 兜底被 JS 挑战页拦住（返回 HTML 而非 CSV）→ 定时任务连续失败，主看板数据会停在 09-25。
   这条与项目里**已有**的场内 ETF 日K 走同一个接口（web.ifzq.gtimg.cn/appstock/app/usfqkline/get），
   已逐点核对与 Yahoo 口径一致：
     2026-09-22 高 30770.63 = DEFAULT.ndx.ath、收 30732.40 = RECENT 区间最高
     2026-09-25 收 30608.13 = DEFAULT.ndx.close ✓（新浪 gb_$ndx 30608.1343 第三方互证）
   ⚠ 必须让用户看得见的差别，所以 source 名里明写（数据健康区会显示）：
     · 腾讯只给到 **1000 根（≈4 年）**，Yahoo 是 10y → ath / athDate / days 是「≈4 年最高」而非「10 年最高」；
     · 因此它是**兜底**而不是替换（项目原则：宁可给降级口径并明示，也不保留过期的数）——
       Yahoo 恢复后自动回到 Yahoo，无需改代码。
   ⚠ 只覆盖这两个核心指数：VIX / TNX 没有验证过的腾讯代码，拿不到就照旧 retained 并在健康区明示。 */
const TENCENT_US = { "^NDX": "usNDX", "^GSPC": "usINX" };
export async function tencentSeries(symbol) {
  const code = TENCENT_US[symbol];
  if (!code) throw new Error("no verified Tencent code for " + symbol);
  const j = await json("https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=" + code + ",day,,,1000,qfq");
  const b = j.data?.[code], bars = b?.qfqday || b?.day;
  if (!Array.isArray(bars) || bars.length < 260) throw new Error("Tencent bars missing");
  // 与 ETF 那段同一套形状校验（[日期, 开, 收, 高, 低]，收/高/低必须自洽且日期严格递增）。
  if (bars.some((r, i) => !isDate(r[0]) || ![r[2], r[3], r[4]].every(v => Number.isFinite(+v) && +v > 0) || +r[3] < +r[2] || +r[4] > +r[2] || (i && r[0] <= bars[i - 1][0]))) throw new Error("invalid Tencent bars");
  return {
    dates: bars.map(r => r[0]), close: bars.map(r => +r[2]), high: bars.map(r => +r[3]), low: bars.map(r => +r[4]),
    source: "Tencent " + code + " qfq (≈4y window, not 10y)",
  };
}
/* Yahoo 单次尝试（2026-10-17 改）：此前对 query1 / query2 各重试 3 次 ——
   实测两个 host 同时 429，一次日更的 10 个请求里 9 个白跑（占全部请求约 30%）。
   现在只试 query1 一次，失败立刻交给腾讯；Yahoo 恢复时仍会自动回到它。 */
async function yahooQuote(symbol, range = "10y", retries = 1) {
  const auth = await yahooAuth();
  const q = auth.crumb ? "&crumb=" + encodeURIComponent(auth.crumb) : "";
  const j = await json("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=" + range + "&interval=1d" + q,
    { headers: auth.cookie ? { Cookie: auth.cookie } : {}, retries });
  const r = j?.chart?.result?.[0], quote = r?.indicators?.quote?.[0];
  if (!Array.isArray(r?.timestamp) || !quote?.close) throw new Error("chart payload empty");
  return { dates: r.timestamp.map(ts => new Date(ts * 1000).toISOString().slice(0, 10)), close: quote.close, high: quote.high, low: quote.low, source: "Yahoo " + symbol };
}
export async function series(symbol, _fallback, range = "10y") {
  try { return await yahooQuote(symbol, range); }
  catch (e) { console.warn("source warning:", symbol, "yahoo", e.message); }
  /* stooq 已于 2026-10-17 移除：它改成了 Cloudflare JS 挑战（返回 HTML 而不是 CSV），
     本机与 CI 都过不去，每次还白花 1 个请求 + 1 次重试；留着只让日志更吵。 */
  try { return await tencentSeries(symbol); }
  // 错误信息保持**短**：它会经 SOURCE_META.error 显示到页面上（`sourceHealth.text` 限 48 字符），
  // 冗长的句子会把窄屏标签撑爆；每个源具体的失败原因已经由上面的 console.warn 写进日志。
  catch { throw new Error("no index provider available"); }
}
/* ===== 官方 CSV 源（2026-10-17 加） =====
   CBOE（官方指数）：VIX_History.csv 1990 至今、SPX_History.csv 1975 至今，收盘后当天即更新
   （实测 10-16 收盘 VIX 19.99 / SPX 7659.44 都已在文件末尾）→ 比 Yahoo ^VIX 更权威，也不吃 429。
   FRED（圣路易斯联储）：DGS10 / DGS2 / VIXCLS，CSV 直出、无需 key，但按 T+1 发布。
   两者都只取**最后一行带日期的有效值**，日期自己校验，绝不拿抓取时钟冒充来源日期。 */
async function cboeCsv(name) {
  const text = await (await get("https://cdn.cboe.com/api/global/us_indices/daily_prices/" + name + "_History.csv", { retries: 2 })).text();
  const lines = text.trim().split(/\r?\n/);
  if (!/^DATE/i.test(lines[0] || "")) throw new Error("CBOE non-CSV payload");
  const head = lines[0].split(",").map(s => s.replace(/^"?|"?$/g, "").trim().toUpperCase());
  const col = head.indexOf("CLOSE") >= 0 ? head.indexOf("CLOSE") : head.length - 1;
  for (let i = lines.length - 1; i > 0; i--) {
    const cells = lines[i].split(",");
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((cells[0] || "").trim());
    const v = +cells[col];
    if (m && Number.isFinite(v) && v > 0) return { value: v, date: m[3] + "-" + m[1] + "-" + m[2] };
  }
  throw new Error("no dated CBOE close");
}
async function fredSeries(id) {
  const text = (await (await get("https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + id, { retries: 1 })).text()).replace(/^\uFEFF/, "");
  const lines = text.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i > 0; i--) {
    const [date, val] = lines[i].split(",");
    const v = +val;
    if (isDate(date) && Number.isFinite(v) && v > 0) return { value: v, date };
  }
  throw new Error("no dated FRED observation");
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
    if (["pePct", "ndxPePct"].includes(key) && (value < 0 || value > 100)) throw new Error(key + ": outside range");
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
  /* 近 12 个月日线（2026-09-27 加，同日由「近 1 个月」扩为 1M/3M/6M 可切、默认 3M；2026-10-03 再加 12M 档）：
     raw 本来就是 10 年日线，这里只留最后 RECENT_N 根 —— **零额外请求**。
     页面按档位从尾部切片（1M=22 / 3M=65 / 6M=130 / 12M=252），统计条与参考线都跟着切出来的区间重算；
     口径与 DEFAULT.ndx / spx.close 同源（同一份 raw 的收盘价）。
     ⚠ 252 根 ≈ 12 个月：够看全年走势；再长就与「回撤深度尺 / 历史回撤表」重复了，故封顶于此。 */
  /* ⚠ 2026-10-24 加 RECENT_STORE：**存 452 根、只画 252 根**。
     起因：页面上的 MA200 改成按收盘滚动算的**曲线**（原来画的是假平线），可是 MA200 需要 200 根预热 ——
     只存 252 根时，任何窗口都只有最后 53 个点算得出 MA200 ✗（3M/6M 都只能画出一小段）。
     现在多存 200 根纯预热（+≈8KB/两只），页面仍按档位从尾部切 ≤252 根 → 图与统计口径**一点没变** ✓。 */
  const RECENT_N = 252;        // 页面最多画多少根（1M/3M/6M/12M 的上限）
  const RECENT_STORE = 452;    // 实际存多少根 = 252 + MA200 的 200 根预热
  const recent = {};
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
      /* methodology 必须跟着实际用的源走：走腾讯兜底时 ath 只是「≈4 年最高」，
         若还写 10y 就等于在溯源里说假话（2026-09-27 同步加）。 */
      rec.success(key, result.date, raw.source, { methodology: /^Tencent/.test(raw.source)
        ? "ATH from a ≈4-year Tencent window (Yahoo unavailable), NOT a 10-year high; 52w intraday range; simple-window RSI14"
        : "10y available high; 52w intraday range; simple-window RSI14" });
      const { date, rows, ...quote } = result; d[key] = quote; core++;
      recent[key] = {
        asOf: result.date,
        pts: raw.dates.map((dt, i2) => ({ d: dt, c: raw.close[i2] }))
          .filter((x) => isDate(x.d) && Number.isFinite(x.c)).slice(-RECENT_STORE),
      };
    } catch (e) { rec.failure(key, raw.source, e.message); }
  }
  /* ── 日经225 日线（2026-10-31 加）────────────────────────────────────────
     用途只有一个：页面上「日经225ETF华安」那 12 笔买入的**指数坐标**（现在只认得 NDX / SPX）。
     ⚠ 与 ndx/spx **不同源**：Yahoo 的 ^N225 常年不稳，这里直接用东财 K 线（本仓库其余 A 股/ETF 行情同源）；
       而且它的用途是「历史买入日的点位」——日期固定、永不变化，抓不到时沿用旧值也**不会失真** ✓
     ⚠ 键名用 nikkei 而不是 n225 —— data.js 里 DEFAULT.n225 是**场内 ETF 报价**（513880），同名会读错 ✗ */
  if (core === 2) await attempt(["nikkei"], "Eastmoney 100.N225", async () => {
    const res = await get("https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=100.N225&fields1=f1,f2"
      + "&fields2=f51,f53&klt=101&fqt=0&beg=0&end=20500101", { headers: { "User-Agent": "Mozilla/5.0" } });
    const j = await res.json();
    const pts = ((j && j.data && j.data.klines) || [])
      .map((s) => { const [dd, cc] = s.split(","); return { d: dd, c: +cc }; })
      .filter((x) => isDate(x.d) && Number.isFinite(x.c) && x.c > 0).slice(-RECENT_STORE);
    if (pts.length < 60) throw new Error("N225 样本不足 " + pts.length);
    recent.nikkei = { asOf: pts[pts.length - 1].d, pts };
    rec.success("nikkei", pts[pts.length - 1].d, "Eastmoney 100.N225");
  });

  if (!core) throw new Error("Both core indices unavailable; original file untouched");
  /* 近 1 个月日线：只在两条核心指数**都成功**时整体替换 —— 一条失败就保留旧值，绝不写半份。 */
  if (core === 2) {
    next.RECENT = { asOf: recent.ndx.asOf === recent.spx.asOf ? recent.ndx.asOf : null, ndx: recent.ndx, spx: recent.spx };
    /* 日经是**可选**项：抓不到就沿用旧值（它的用途是历史买入日点位，旧值同样正确 ✓） */
    const prevNik = old.RECENT && old.RECENT.nikkei;
    if (recent.nikkei) next.RECENT.nikkei = recent.nikkei;
    else if (prevNik) next.RECENT.nikkei = prevNik;
  }
  // Independent cross-check of the two core closes. Non-blocking by design: a mismatch is
  // information to surface, not a reason to publish stale numbers instead.
  if (core === 2) await attempt(["crosscheck"], "Sina + CBOE SPX", async () => {
    const res = await get("https://hq.sinajs.cn/list=gb_$ndx,gb_$inx", { headers: { Referer: "https://finance.sina.com.cn" } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    let text; try { text = new TextDecoder("gbk").decode(bytes); } catch { text = new TextDecoder().decode(bytes); }
    const grab = sym => {
      const head = "hq_str_" + sym + "=\"", at = text.indexOf(head);
      if (at < 0) return null;
      const body = text.slice(at + head.length), parts = body.slice(0, body.indexOf("\"")).split(",");
      return { close: parseFloat(parts[1]), date: sinaTimestampToET(parts[3]) };
    };
    const ndx = grab("gb_$ndx"), spx = grab("gb_$inx");
    if (!ndx || !spx || !isDate(ndx.date) || !isDate(spx.date)) throw new Error("Sina quote unavailable");
    const devs = [["NDX(Sina)", d.ndx.close / ndx.close - 1], ["SPX(Sina)", d.spx.close / spx.close - 1]].map(([k, v]) => [k, v * 100]);
    const notes = [];
    /* CBOE 官方 SPX CSV（1975 至今）作为第二把尺子：只在**与本次行情同日**时参与比较 ——
       拿不同日期的收盘互比没有意义。它失败不阻断（新浪仍是必需的那条）。 */
    try {
      const c = await cboeCsv("SPX");
      const sameDay = c.date === rec.meta.spx?.asOf;
      if (sameDay) devs.push(["SPX(CBOE)", (d.spx.close / c.value - 1) * 100]);
      else notes.push("CBOE 日期 " + c.date + " ≠ 行情日 " + (rec.meta.spx?.asOf || "?"));
    } catch { notes.push("CBOE 不可用"); }
    const worst = devs.reduce((a, x) => Math.abs(x[1]) > Math.abs(a[1]) ? x : a);
    if (!Number.isFinite(worst[1])) throw new Error("cross-check parse failed");
    if (Math.abs(worst[1]) > 0.5) throw new Error(worst[0] + " close differs " + worst[1].toFixed(2) + "%");
    rec.success("crosscheck", ndx.date, "Sina gb_$ndx / gb_$inx + CBOE SPX_History.csv", {
      deltaPct: rounded(worst[1], 3),
      compared: devs.map(x => x[0] + " " + x[1].toFixed(2) + "%").join(", ") + (notes.length ? " · " + notes.join(" · ") : ""),
    });
  });
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
    /* VIX：CBOE 官方 CSV 优先（当天更新、不受 429 影响），Yahoo ^VIX 兜底。
       2026-10-17 起不再走 series()：腾讯没有可信的 VIX 代码（usVIX 停在 04-15 的 21.67）。 */
    attempt(["vix"], "CBOE VIX / Yahoo", async () => {
      try {
        const p = await cboeCsv("VIX");
        accept("vix", rounded(p.value, 3), p.date, "CBOE VIX_History.csv (official)");
      } catch (e) {
        console.warn("source warning: VIX CBOE", e.message);
        const raw = await yahooQuote("^VIX", "5d"), point = latest(raw);
        accept("vix", rounded(point.value, 3), point.date, raw.source);
      }
    }),
    /* 10Y：Yahoo ^TNX 优先，FRED DGS10 兜底（T+1 发布，但稳定、无需 key）——
       本机实测 Yahoo 全 429；没有兜底时 tnx 会天天 retained（页面只能标陈旧）。 */
    attempt(["tnx"], "Yahoo ^TNX / FRED DGS10", async () => {
      try {
        const raw = await yahooQuote("^TNX", "5d"), point = latest(raw);
        accept("tnx", rounded(point.value, 3), point.date, raw.source);
      } catch (e) {
        console.warn("source warning: TNX Yahoo", e.message);
        const p = await fredSeries("DGS10");
        accept("tnx", rounded(p.value, 3), p.date, "FRED DGS10 (T+1)");
      }
    }),
    /* 2Y：财政部官方曲线优先（当天），FRED DGS2 兜底（T+1）。
       ⚠ 财政部站点本机实测 30~60s 全超时，所以这里把超时压到 8s、不重试，失败立刻转向 FRED。 */
    attempt(["tnx2"], "US Treasury / FRED DGS2", async () => {
      try {
        const year = dayNY.slice(0, 4);
        const csv = (await (await get("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/" + year
          + "/all?type=daily_treasury_yield_curve&field_tdr_date_value=" + year + "&page&_format=csv", { retries: 1, timeout: 8000 })).text()).replace(/^\uFEFF/, "");
        const lines = csv.trim().split(/\r?\n/);
        const cols = lines[0].split(",").map(s => s.replace(/^"|"$/g, "").trim());
        const col = cols.indexOf("2 Yr");
        if (col < 0) throw new Error("2 Yr column missing");
        const row = lines.slice(1).map(l => l.split(",")).find(c => c.length > col && /^\d{2}\/\d{2}\/\d{4}$/.test((c[0] || "").trim()));
        if (!row || !(+row[col] > 0)) throw new Error("dated 2Y observation missing");
        const [mm, dd, yyyy] = row[0].trim().split("/");
        accept("tnx2", rounded(+row[col], 3), yyyy + "-" + mm + "-" + dd, "US Treasury par yield curve (US government work)");
      } catch (e) {
        console.warn("source warning: TNX2 Treasury", e.message);
        const p = await fredSeries("DGS2");
        accept("tnx2", rounded(p.value, 3), p.date, "FRED DGS2 (T+1)");
      }
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
  await attempt(["cape"], "History of Market / multpl.com", async () => {
    try {
      const j = await json("https://historyofmarket.com/api/sp500/pe.json");
      const point = (j.cape || []).filter(p => Number.isFinite(p.value)).at(-1);
      const asOf = sourceDate(point?.date);
      if (!isDate(asOf) || !Number.isFinite(point?.value) || !(point.value > 0)) throw new Error("dated CAPE observation missing");
      accept("cape", point.value, asOf, "History of Market sp500 (CAPE series, CC BY 4.0)");
    } catch (e) {
      console.warn("source warning: CAPE", e.message);
      /* multpl.com 兜底（2026-10-17 加）：HTML 月度表，首行就是最新值。
         ⚠ 与 historyofmarket 的口径不完全一致（实测同日 40.54 vs 41.87，差约 3%），
         所以 source 名里明写 fallback —— 不让两个口径在溯源里悄悄混成一个。 */
      const text = await (await get("https://www.multpl.com/shiller-pe/table/by-month", { retries: 1 })).text();
      const m = text.match(/<td>\s*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*<\/td>\s*<td>[^<]*?([\d.]+)\s*<\/td>/);
      if (!m) throw new Error("multpl CAPE parse failed");
      const t = Date.parse(m[1] + " UTC");
      if (!Number.isFinite(t)) throw new Error("multpl date invalid");
      accept("cape", +m[2], new Date(t).toISOString().slice(0, 10), "multpl.com Shiller PE (fallback, different methodology)");
    }
  });
  await attempt(["putcall"], "CBOE", async () => {
    const text = (await (await get("https://www.cboe.com/markets/us/options/market-statistics/daily?mkt=cone")).text()).replaceAll('\\"', '"');
    const match = text.match(/"name":"TOTAL PUT\/CALL RATIO","value":"([\d.]+)"/);
    // CBOE 页面改版（Next.js RSC）：日期字段由 tradeDate 改为 selectedDate，两个都认，防再改版。
    const date = text.match(/"(?:tradeDate|trade_date|selectedDate)":"(\d{4}-\d{2}-\d{2})"/);
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
  /* 近 1 个月日线：与 MONTHLY 同款整体重写（data.js 里那块带注释的空占位会被换成真实数据）。 */
  src = src.replace(/^const RECENT = \{[\s\S]*?^\};/m, () => "const RECENT = " + JSON.stringify(next.RECENT, null, 2) + ";");
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
