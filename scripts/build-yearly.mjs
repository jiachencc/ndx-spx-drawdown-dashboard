#!/usr/bin/env node
"use strict";
/* 年度涨跌 · 年内最大涨幅 · 年内最大回撤 —— **全历史**
 *
 * 用户：「近 15 年可做动静分离，除了现在 2026 在变化，之前的都是固定数据了，
 *        SPX 和 NDX 都放历史全数据吧」
 *
 * ── 动静分离（本次重构的核心）────────────────────────────────────────────
 *   已完结的年份（1986~2025）**一年只变一次** → 写进独立文件 `yearly.js`
 *     好处：每日更新时它不进 diff（它占了 YEARLY 99% 的体积），
 *           `data.js` 的每日变更只剩 YTD 那几十字节 ✓
 *   当年（2026）每天都在变 → 写进 `data.js` 的 `YEARLY_YTD`
 *   页面把两者拼起来渲染 ✓
 *
 * ── 数据源（都能回到 1986，正好对称）────────────────────────────────────
 *   · NDX ← FRED `NASDAQ100`（10,307 根，1986-01-02 起）
 *     东财 `100.NDX100` 只到 **2019-04-08**（1,921 根）→ 做不了长历史 ✗
 *   · SPX ← 东财 `100.SPX` beg=19800101（**10,186 根，1986-03-17 起**）
 *     FRED `SP500` 只留**滚动 10 年**（2,512 根）→ 不够 ✗
 *   ⚠ 两者在 2,512 个重叠交易日上平均差 0.000%、最大差 0.023% ✓
 *   ⚠ 已核验的历史值（价格回报，不含股息）：
 *       1986 首点 234.67 · 1990 −6.6% · 2008 −38.5% · 2009 +23.5% · 2022 −19.4% ✓
 *       1987 算出 +2.0% —— 这是**价格回报**（含股息的总回报才是 +5.3%），口径一致 ✓
 *
 * ── 三列的算法（顺序敏感，最容易写错）──────────────────────────────────
 *   ① 年度涨跌   = 年末收盘 ÷ 上年末收盘 − 1
 *   ② 年内最大涨幅 = 顺序扫描 max( P_t / min_{s≤t} P_s − 1 )
 *   ③ 年内最大回撤 = 顺序扫描 max( 1 − P_t / max_{s≤t} P_s )
 *   ⚠ ②③ 不是「最高 ÷ 最低」——最高点可能出现在最低点**之前**，
 *     那样算出的是历史上从未发生过的数 ✗
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { atomicWrite } from "./data-quality.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const dataFile = join(ROOT, "data.js");
const histFile = join(ROOT, "yearly.js");
const UA = { "User-Agent": "Mozilla/5.0" };

const MIN_DAYS = 200;        // 少于这么多交易日视为不完整（首年 / 当年）

/* ── 取数 ─────────────────────────────────────────────────────────────── */
async function fredSeries(id, from) {
  /* ⚠ `cosd` 让 FRED 只返回该日之后的行（2026-11-26 加）——
     全量是 10,669 行、只取当年是 233 行，日更时省 97% 流量 ✓
     FRED 不支持增量追加，所以「历史已完整」时只拉当年即可：
     YTD 的三列（年度/年内最高/年内回撤）**只需要当年数据**，
     历史那部分连同它的 stats 都已在 yearly.js 里、不必重算 ✓ */
  const r = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + id
    + (from ? "&cosd=" + from : ""),
    { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(id + " HTTP " + r.status);
  const t = await r.text();
  const seen = new Set();
  const out = [];
  t.trim().split("\n").slice(1).forEach((l) => {
    const [d, v] = l.split(",");
    if (!d || !v || v === "." || seen.has(d)) return;      // FRED 偶有重复行
    const c = +v;
    if (!Number.isFinite(c) || c <= 0) return;
    seen.add(d);
    out.push({ d, c });
  });
  out.sort((a, b) => (a.d < b.d ? -1 : 1));
  if (!out.length) throw new Error(id + " 无有效行");
  return out;
}

/* ⚠ 腾讯美股日线（2026-11-26 加）—— GitHub Actions 的 runner 在海外，
   东财 K 线（push2his.eastmoney.com）整批不通，而腾讯（web.ifzq.gtimg.cn）是通的。
   实测 usINX 与东财 100.SPX 在 1,000 个重叠交易日上**平均差 0.0000%、最大差 0.0005%**，
   且用它算出的 2023~2026 三列与东财**逐位一致** ✓
   ⚠ 只给 **1,000 根（≈4 年）** → 够「增量模式」（只需上年 12 月＋当年），
     但**不够全量**（要 40 年）→ 全量模式仍走东财/FRED，失败就放弃写盘，绝不截断历史 ✗
   ⚠ 字段是数组：`[日期, 开, 收, 高, 低, 量]` —— **收盘在索引 2**（东财的字符串是索引 1） */
async function tencentSeries(sym, limit = 1000) {
  const u = "https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param="
    + sym + ",day,,," + limit + ",qfq";
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.qq.com/" },
    signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("tencent " + sym + " HTTP " + r.status);
  const j = await r.json();
  const obj = (j.data || {})[sym] || {};
  const key = Object.keys(obj).find((k) => Array.isArray(obj[k]));
  const arr = key ? obj[key] : [];
  const out = arr.map((x) => ({ d: x[0], c: +x[2] }))
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.d) && Number.isFinite(x.c) && x.c > 0);
  if (!out.length) throw new Error("tencent " + sym + " 无有效行");
  return out;
}

/* 腾讯**区间**接口（2026-11-27 加）：全量模式下的东财兜底。
   ⚠ 与上面 tencentSeries 的区别：那个用 count 取「最近 N 根」（上限 1,000 ≈ 4 年），
     这个用 `from,to` 指定**日期区间**、count 只当窗口内的上限 →
     逐段取（3 年一段 ≈ 750 根，仍在上限内）就能拼出 40 年 ✓
   ⚠ 实测（2026-11-27，本机）：usINX 给出 **1985-01-17 起 10,546 根**；
     count 传 12,000 会返回 `{"code":-1,"msg":"limit error"}` ✗ → 必须分段，不能一把梭
   ⚠ 它与东财在重叠年份上有 0.07pp 级差异（1991 / 1997 / 2010 的 dd）——
     所以**只用来补缺口**，不覆盖既有年份（见下面 full 模式那段）✓ */
async function tencentRangeSeries(sym, y0, y1) {
  const seen = new Map();
  for (let y = y0; y <= y1; y += 3) {
    const from = y + "-01-01", to = Math.min(y + 2, y1) + "-12-31";
    const u = "https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param="
      + sym + ",day," + from + "," + to + ",1000,qfq";
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.qq.com/" },
      signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error("tencent " + sym + " " + from + " HTTP " + r.status);
    const j = await r.json();
    const obj = (j.data || {})[sym] || {};
    const key = Object.keys(obj).find((k) => Array.isArray(obj[k]));
    const arr = key ? obj[key] : [];
    /* 某一段空 = 数据缺口，直接抛错：宁可整轮不写盘，也不要拼出一份中间缺几年的历史 ✗ */
    if (!arr.length) throw new Error("tencent " + sym + " " + from + "~" + to + " 无数据（区间缺口）");
    arr.forEach((x) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(x[0]) && +x[2] > 0) seen.set(x[0], +x[2]);
    });
  }
  return [...seen.entries()].map(([d, c]) => ({ d, c })).sort((a, b) => (a.d < b.d ? -1 : 1));
}

async function eastmoneySeries(secid, beg) {
  const u = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=" + secid
    + "&fields1=f1,f2&fields2=f51,f53&klt=101&fqt=1&beg=" + beg + "&end=20500101&lmt=20000";
  const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(secid + " HTTP " + r.status);
  const j = await r.json();
  const out = ((j.data && j.data.klines) || [])
    .map((s) => { const a = s.split(","); return { d: a[0], c: +a[1] }; })
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.d) && Number.isFinite(x.c) && x.c > 0);
  if (!out.length) throw new Error(secid + " 无有效行");
  return out;
}

/* ── 三列 ─────────────────────────────────────────────────────────────── */
function yearlyStats(rows) {
  const byYear = {};
  rows.forEach((r) => { const y = r.d.slice(0, 4); (byYear[y] = byYear[y] || []).push(r); });
  const yrs = Object.keys(byYear).sort();
  const out = [];
  yrs.forEach((y, i) => {
    const rs = byYear[y];
    const complete = rs.length >= MIN_DAYS;
    const prevRows = yrs[i - 1] ? byYear[yrs[i - 1]] : null;
    /* ⚠ 上一年**不要求完整**（2026-11-26 修）——
       年度涨跌的分母只是「上年最后一个交易日收盘」，有一行就够 ✓
       原来要求 prevRows.length >= 200，导致增量模式（只拉上年 12 月）
       算出的 yr 全是 null ✗；而全量模式下这条限制也没必要：
       1987 用 1986-12-31 的收盘是**正确**的做法，不该因为 1986 只有 200 天就丢掉一年 ✓ */
    const prevOk = prevRows && prevRows.length > 0;
    let hi = -Infinity, lo = Infinity, mdd = 0, mru = 0;
    rs.forEach((r) => {
      if (r.c > hi) hi = r.c;
      if (r.c < lo) lo = r.c;
      mdd = Math.max(mdd, 1 - r.c / hi);
      mru = Math.max(mru, r.c / lo - 1);
    });
    out.push({
      y: +y,
      complete,
      /* 年度涨跌需要**上一年完整** —— 否则首年会算成「从年中开始」的假值 */
      yr: complete && prevOk ? +((rs[rs.length - 1].c / prevRows[prevRows.length - 1].c - 1) * 100).toFixed(2) : null,
      runup: +((mru * 100).toFixed(2)),
      dd: +((-mdd * 100).toFixed(2)),
      n: rs.length,
      lastTrade: rs[rs.length - 1].d,
      lastClose: rs[rs.length - 1].c,
    });
  });
  return out;
}

function summarize(list) {
  const v = list.filter((x) => x.yr !== null);
  if (!v.length) return null;
  const n = v.length;
  const pos = v.filter((x) => x.yr > 0).length;
  const cum = v.reduce((a, x) => a * (1 + x.yr / 100), 1);
  const avg = v.reduce((a, x) => a + x.yr, 0) / n;
  const avgDD = v.reduce((a, x) => a + x.dd, 0) / n;
  const avgUp = v.reduce((a, x) => a + x.runup, 0) / n;
  /* ⚠ 2026-11-27 加 medDD（中位）：只报均值会把「典型年份跌多深」讲错 ——
     纳指 1987–2025 的均值 −20.2% 里，2000/2001/2002/2008 四年就贡献 −213pp
     （−53.0 / −58.7 / −52.0 / −49.6），剔掉这四年均值只有 −16.4%，
     而**中位**是 −14.6% —— 那才是「平常年份」的深度 ✓
     页面现在两个数并列显示（年均 + 中位），只给均值容易被读成「每年都跌两成」✗ */
  const dds = v.map((x) => x.dd).sort((a, b) => a - b);
  const medDD = dds.length % 2 ? dds[(dds.length - 1) / 2] : (dds[dds.length / 2 - 1] + dds[dds.length / 2]) / 2;
  return {
    n, pos, neg: n - pos,
    winRate: +((pos / n) * 100).toFixed(0),
    cum: +cum.toFixed(2),
    cagr: +((Math.pow(cum, 1 / n) - 1) * 100).toFixed(1),
    avg: +avg.toFixed(1),
    avgDD: +avgDD.toFixed(1),
    medDD: +medDD.toFixed(1),
    avgUp: +avgUp.toFixed(1),
    worstDD: +Math.min(...v.map((x) => x.dd)).toFixed(1),
    bestRun: +Math.max(...v.map((x) => x.runup)).toFixed(1),
  };
}

/* ── 先看历史是否已完整（决定要不要拉全量）───────────────────────────── */
const say = (t) => console.log("  " + t);
/* ⚠ 用**本地年**而不是 UTC 年（2026-11-26 修）——
   跨年边界：北京时间 2027-01-01 03:00 ＝ UTC 2026-12-31 19:00 ＝ 纽约 2026-12-31 14:00，
   此时数据里**已经有 2027-01-01 的 A 股**，但用 UTC/纽约都算成 2026 →
   `needFull = 2025 < 2026-1` 为 false → 走增量 → 2026 那一年**永远不会被归档进 yearly.js** ✗
   （每年丢一整年，且悄无声息）
   → 行情数据按**北京日期**落盘，判据也统一用本地年 ✓ */
const localYear = new Date().getFullYear();
const thisYear = localYear;
let histTo = null, histNN = 0, histNS = 0, histN3 = 0;
try {
  const cur = readFileSync(histFile, "utf8");
  const m = /"to":\s*(\d{4})/.exec(cur);
  if (m) histTo = +m[1];
  /* 旧行数：用来判断「历史是否被截断」（比 from 可靠 ——
     from 取两个指数的 min，NDX 还在 1987 时 SPX 被砍掉一半也看不出来 ✗） */
  const mN = /"ndx":\s*\[([\s\S]*?)\]/.exec(cur);
  const mS = /"spx":\s*\[([\s\S]*?)\]/.exec(cur);
  const m3 = /"n225":\s*\[([\s\S]*?)\]/.exec(cur);
  if (mN) histNN = (mN[1].match(/\{"y":/g) || []).length;
  if (mS) histNS = (mS[1].match(/\{"y":/g) || []).length;
  if (m3) histN3 = (m3[1].match(/\{"y":/g) || []).length;
} catch (e) { /* 文件不存在 → 需要全量 */ }

/* 历史「已完整」= yearly.js 的 to 已经 ≥ 去年（即除当年外的年份都有了） */
/* `--full` 强制全量：数据源修正历史（复权口径调整等）时用 —— 增量模式察觉不到 ✓ */
const forceFull = process.argv.includes("--full");
const needFull = forceFull || histTo === null || histTo < thisYear - 1;
/* ⚠ 增量模式要从**上一年 12 月**起拉（2026-11-26 修）——
   只拉当年会缺「上年末收盘」→ 2026 的年度涨跌算成 null ✗
   多拉一个月就够了（2025-12 的月末收盘就是分母），成本可以忽略 ✓
   ⚠ 多出来的 2025-12 那几天会被 pick() 按 `complete` 滤掉（不足 200 个交易日）✓ */
const fromDay = needFull ? null : (thisYear - 1) + "-12-01";
say(needFull
  ? (forceFull ? "--full 强制全量" : "历史不完整（yearly.js " + (histTo === null ? "缺失" : "只到 " + histTo) + "）→ 拉全量")
  : "历史已完整（yearly.js 到 " + histTo + "）→ 只拉当年 " + thisYear + "，历史不重算");

/* ── 跑 ───────────────────────────────────────────────────────────────── */

let ndxRows, ndxSrc;
try {
  ndxRows = await fredSeries("NASDAQ100", fromDay);
  ndxSrc = "FRED NASDAQ100";
  say("NDX ← FRED · " + ndxRows.length + " 根 · " + ndxRows[0].d + " ~ " + ndxRows[ndxRows.length - 1].d);
} catch (e) {
  /* FRED 失败 → 先试腾讯（CI 里稳定、且给日线）；东财的 NDX 只到 2019-04，放最后 ✓ */
  try {
    ndxRows = await tencentSeries("usNDX");
    ndxSrc = "Tencent usNDX";
    console.warn("  ⚠ FRED NDX 失败（" + e.message + "）→ 改用腾讯 usNDX " + ndxRows.length + " 根");
  } catch (e2) {
    ndxRows = await eastmoneySeries("100.NDX100", fromDay ? fromDay.replace(/-/g, "") : "19800101");
    ndxSrc = "Eastmoney 100.NDX100";
    console.warn("  ⚠ FRED 与腾讯都失败 → 退回东财（只到 2019-04，历史会短很多）");
  }
}

let spxRows, spxSrc;
if (!needFull) {
  /* 增量：只需「上年 12 月 ＋ 当年」≈ 250 根 → 腾讯 1,000 根绰绰有余，
     而且它在 CI 里是通的（东财不通）。先腾讯、再东财、最后 FRED ✓ */
  try {
    spxRows = await tencentSeries("usINX");
    spxSrc = "Tencent usINX";
    say("SPX ← 腾讯 usINX · " + spxRows.length + " 根 · " + spxRows[0].d + " ~ "
      + spxRows[spxRows.length - 1].d);
  } catch (e) {
    try {
      spxRows = await eastmoneySeries("100.SPX", fromDay.replace(/-/g, ""));
      spxSrc = "Eastmoney 100.SPX";
      say("SPX ← 东财 · " + spxRows.length + " 根（腾讯失败：" + e.message + "）");
    } catch (e2) {
      spxRows = await fredSeries("SP500", fromDay);
      spxSrc = "FRED SP500";
      console.warn("  ⚠ 腾讯与东财都失败 → 退回 FRED（" + e2.message + "）");
    }
  }
} else {
  /* 全量：需要 40 年。首选东财（原始源），**不通时退腾讯区间接口**。
     ⚠ 2026-11-27 加兜底：当日实测两个环境东财 K 线都整批不通（`fetch failed` / 空响应），
       而 NDX 走 FRED 正常 —— 此时若照旧直接抛错，`--full` 就永远补不上缺失年份
       （本次跑 --full 正是为了补 SPX 1987，结果卡在这里）。
     ⚠ 兜底**只补缺口**（见下方 merge），既有年份一个数都不改 ——
       两条源在 1991/1997/2010 的 dd 上有 ≤0.07pp 差异，拿它重算整段历史＝悄悄改数 ✗ */
  try {
    spxRows = await eastmoneySeries("100.SPX", "19800101");
    spxSrc = "Eastmoney 100.SPX";
    say("SPX ← 东财 · " + spxRows.length + " 根 · " + spxRows[0].d + " ~ " + spxRows[spxRows.length - 1].d);
  } catch (e) {
    spxRows = await tencentRangeSeries("usINX", 1985, thisYear);
    spxSrc = "Tencent usINX（区间）";
    console.warn("  ⚠ 东财不通（" + e.message + "）→ 改用腾讯区间接口 · " + spxRows.length
      + " 根 · " + spxRows[0].d + " ~ " + spxRows[spxRows.length - 1].d + "（只补缺口 ✓）");
  }
}

/* ── N225（2026-11-28 加，用户「日经加进年度表现」）────────────────────
   FRED `NIKKEI225` 1985 起（10,300+ 根），两个环境都通，不另设兜底：
   缺日经时整轮不写盘，避免页面出现「只有两个 tab」的半截状态 ✓ */
let n225Rows, n225Src;
try {
  n225Rows = await fredSeries("NIKKEI225", fromDay);
  n225Src = "FRED NIKKEI225";
  say("N225 ← FRED · " + n225Rows.length + " 根 · " + n225Rows[0].d + " ~ " + n225Rows[n225Rows.length - 1].d);
} catch (e) {
  throw new Error("N225 取数失败（" + e.message + "）→ 放弃写盘（年度表要三指数齐全）");
}

const ndxAll = yearlyStats(ndxRows);
const spxAll = yearlyStats(spxRows);
const n225All = yearlyStats(n225Rows);

/* ⚠ 增量模式下只拿到了当年的数据 → 算出来的「历史」只有当年那一年，
   若照原逻辑写盘会把 yearly.js 覆盖成一行 ✗ → 历史部分**整块沿用旧文件** ✓ */
let histCarry = null;
if (!needFull) {
  try {
    const cur = readFileSync(histFile, "utf8");
    const m = /const YEARLY_HIST = (\{[\s\S]*?\n\});/.exec(cur);
    if (m) histCarry = JSON.parse(m[1]);
  } catch (e) {
    console.warn("  ⚠ 读不出 yearly.js 的历史块（" + e.message + "）→ 退回全量模式");
    histTo = null;
  }
}
if (!needFull && !histCarry) throw new Error("增量模式但读不到历史块，放弃（避免把 yearly.js 写坏）");
/* ⚠ 三个序列分别取末日，再取**最大**那个的年份 —— 原来两序列用 sort()[1]（＝较大者），
   加到三个后 sort()[1] 会变成中位数，语义就漂了 ✗ */
const ytdYear = +[ndxRows, spxRows, n225Rows].map((a) => a[a.length - 1].d).sort().at(-1).slice(0, 4);

/* 已完结年份 → yearly.js；当年 → data.js */
const pick = (arr) => arr.filter((x) => x.complete && x.y < ytdYear && x.yr !== null);
let ndxHist = pick(ndxAll);
let spxHist = pick(spxAll);
let n225Hist = pick(n225All);

/* ── 历史合并（2026-11-28 统一成一条规则，防止「年份凭空消失」）──────────────
   ① 兜底源（腾讯区间）：重叠年份**保留旧值** —— 两源在 1991/1997/2010 的 dd 上差 ≤0.07pp，
      重算＝把已验证的历史悄悄改掉 ✗
   ② 原始源（东财 / FRED）：重叠年份**用新值**（`--full` 的用途就是修历史），
      但**旧文件里有、新源没有的年份一律补回** ——
      2026-11-28 实测：东财这天通了，于是 SPX 按原始源整段重算 → 它的序列从 1986-03 起、
      1986 不足 200 个交易日、1987 的年度涨跌算不出来 → **1985~1987 整段被吞**（41 行 → 38 行），
      而页面只是「年份少了」，没有任何报错 ✗。这条规则把它补回来 ✓
   ③ 增量模式不走这里（历史整块沿用 histCarry ✓）*/
const oldHist = (() => {
  try { return JSON.parse(/const YEARLY_HIST = (\{[\s\S]*?\n\});/.exec(readFileSync(histFile, "utf8"))[1]); }
  catch (e) { return null; }
})();
const carryMissing = (rows, key) => {
  const old = oldHist && Array.isArray(oldHist[key]) ? oldHist[key] : [];
  if (!old.length) return rows;
  const have = new Set(rows.map((r) => r.y));
  const miss = old.filter((r) => !have.has(r.y));
  if (!miss.length) return rows;
  say("  " + key.toUpperCase() + " 补回 " + miss.length + " 个旧年份（新源没有）："
    + miss.map((r) => r.y).join(" / ") + " —— 不补就是静默丢历史 ✗");
  return rows.concat(miss).sort((a, b) => a.y - b.y);
};
if (needFull) {
  /* 原始源：先补回旧年份，再让重叠年份保留「新值」*/
  if (spxSrc === "Eastmoney 100.SPX") spxHist = carryMissing(spxHist, "spx");
  ndxHist = carryMissing(ndxHist, "ndx");
  n225Hist = carryMissing(n225Hist, "n225");
}
/* ⚠ 2026-11-27：全量模式若 SPX 走了**兜底源**（腾讯区间），只补缺失年份、既有年份原样沿用 ——
   理由见上面 full 模式那段：两条源在 1991/1997/2010 的 dd 上有 ≤0.07pp 差异，
   直接重算＝把已验证的 38 年悄悄改掉 ✗。东财通了（原始源）时照旧整段重算 ✓ */
if (needFull && spxSrc !== "Eastmoney 100.SPX") {
  let old = null;
  try { old = JSON.parse(/const YEARLY_HIST = (\{[\s\S]*?\n\});/.exec(readFileSync(histFile, "utf8"))[1]); }
  catch (e) { /* 没有旧文件 → 无可沿用，按全量结果写 ✓ */ }
  if (old && Array.isArray(old.spx) && old.spx.length) {
    const have = new Map(old.spx.map((x) => [x.y, x]));
    const drift = [];
    spxHist.forEach((r) => {
      const o = have.get(r.y);
      if (!o) return;
      const d = Math.max(Math.abs(r.yr - o.yr), Math.abs(r.dd - o.dd), Math.abs(r.runup - o.runup));
      if (d > 0.1) drift.push(r.y + " 差 " + d.toFixed(2) + "pp");
    });
    const added = spxHist.filter((r) => !have.has(r.y));
    spxHist = old.spx.concat(added).sort((a, b) => a.y - b.y);
    spxSrc = (old.sources && old.sources.spx ? old.sources.spx : "东财")
      + " + Tencent usINX（补 " + (added.length ? added.map((r) => r.y).join(" / ") : "无") + "）";
    say("SPX 兜底源 → 新增 " + (added.length
      ? added.map((r) => r.y + "（年度 " + (r.yr >= 0 ? "+" : "") + r.yr.toFixed(2) + "% · 年内回撤 " + r.dd.toFixed(2) + "%）").join("、")
      : "无（无缺口）") + "；既有 " + old.spx.length + " 年沿用原值 ✓");
    if (drift.length) console.warn("  ⚠ 兜底源与既有年份的差异（>0.1pp；**均未改动**，仅提示）：" + drift.join("、"));
  }
}
const ndxYtd = ndxAll.find((x) => x.y === ytdYear) || null;
const spxYtd = spxAll.find((x) => x.y === ytdYear) || null;
const n225Ytd = n225All.find((x) => x.y === ytdYear) || null;
/* asOf 取三者里**最新**的交易日（原来两序列取 sort()[1]＝较大者，三序列同样要显式取 max）*/
const asOf = [ndxYtd, spxYtd, n225Ytd].map((x) => (x ? x.lastTrade : "")).sort().at(-1) || "?";

/* ⚠ 增量模式下 ndxHist/spxHist 必然为空（只拉了当年，而 pick 会滤掉当年）——
   那不是错误，历史走 histCarry ✓ 只有「全量模式且仍为空」才是真错 ✗ */
if (!histCarry && (!ndxHist.length || !spxHist.length)) throw new Error("历史序列为空，放弃写盘");

/* ⚠ 增量模式**不改 updated**（2026-11-26）——
   `updated` 的含义是「yearly.js 这份历史最后被重算的日子」，
   而增量模式下历史根本没动；每跑一次就刷新它会让这个字段变成
   「脚本最后运行日」，与语义不符 ✗ */
const YEARLY_HIST = histCarry ? Object.assign({}, histCarry) : {
  updated: asOf,
  from: Math.min(ndxHist[0].y, spxHist[0].y, n225Hist[0].y),
  to: ytdYear - 1,
  basis: "年度＝年末收盘 ÷ 上年末收盘 − 1；年内最大涨幅＝按时间顺序 max(P_t/前低−1)；"
    + "年内最大回撤＝按时间顺序 max(1−P_t/前高)。两条都**顺序扫描**，不是「最高 ÷ 最低」"
    + "（后者在最高点早于最低点时给出从未发生过的数）。均为**价格回报**，不含股息。",
  sources: { ndx: ndxSrc, spx: spxSrc, n225: n225Src },
  ndx: ndxHist.map(({ y, yr, runup, dd }) => ({ y, yr, runup, dd })),
  spx: spxHist.map(({ y, yr, runup, dd }) => ({ y, yr, runup, dd })),
  n225: n225Hist.map(({ y, yr, runup, dd }) => ({ y, yr, runup, dd })),
  stats: { ndx: summarize(ndxHist), spx: summarize(spxHist), n225: summarize(n225Hist) },
};

const YEARLY_YTD = {
  asOf,
  y: ytdYear,
  basis: "当年未走完 → 三列只代表「年初到 " + asOf + "」；已完结年份在 yearly.js",
  ndx: ndxYtd ? { y: ndxYtd.y, yr: ndxYtd.yr, runup: ndxYtd.runup, dd: ndxYtd.dd } : null,
  spx: spxYtd ? { y: spxYtd.y, yr: spxYtd.yr, runup: spxYtd.runup, dd: spxYtd.dd } : null,
  n225: n225Ytd ? { y: n225Ytd.y, yr: n225Ytd.yr, runup: n225Ytd.runup, dd: n225Ytd.dd } : null,
};

/* ── 写 yearly.js（历史，低频）────────────────────────────────────────── */
/* ⚠ 保护：全量重建时，历史起点**不许后退**（2026-11-26 加）——
   SPX 全量只有东财给得出 1986；万一它挂了退回 FRED（滚动 10 年）或腾讯（4 年），
   会把 40 年历史**静默截断**成 10 年 / 4 年，而页面只是「年份变少了」，
   没有任何报错 ✗ → 起点比原来晚 2 年以上就拒绝写盘 ✓
   （「晚几天归档」是小问题，「丢 30 年历史」是大问题） */
if (!histCarry) {
  const cut = [];
  if (histNN && YEARLY_HIST.ndx.length < histNN * 0.9) cut.push("NDX " + histNN + "→" + YEARLY_HIST.ndx.length);
  if (histNS && YEARLY_HIST.spx.length < histNS * 0.9) cut.push("SPX " + histNS + "→" + YEARLY_HIST.spx.length);
  if (histN3 && YEARLY_HIST.n225.length < histN3 * 0.9) cut.push("N225 " + histN3 + "→" + YEARLY_HIST.n225.length);
  if (cut.length) {
    throw new Error("历史被截断（" + cut.join(" / ") + "）—— 数据源降级了（"
      + ndxSrc + " / " + spxSrc + " / " + n225Src + "）→ 拒绝写盘，保留旧 yearly.js ✓");
  }
}

const histBody = "const YEARLY_HIST = " + JSON.stringify(YEARLY_HIST, null, 1) + ";\n";
const histHeader = "/* AUTO（低频）：年度涨跌 · 年内最大涨幅 · 年内最大回撤 —— 已完结年份\n"
  + "   ⚠ **这个文件一年只变一次**（新增一整年后），所以从 data.js 里拆出来 ——\n"
  + "     它占了年度数据的 99% 体积，留在 data.js 会让每日更新产生巨量 diff ✗\n"
  + "   ⚠ 当年（YTD）在 data.js 的 YEARLY_YTD，每日更新 ✓\n"
  + "   ⚠ ②「年内最大涨幅」③「年内最大回撤」都是**顺序扫描**，不是最高÷最低 ✗\n"
  + "   由 scripts/build-yearly.mjs 整块重写 */\n";
if (histCarry) {
  say("yearly.js 未改动（增量模式 · 历史沿用 " + histCarry.from + "~" + histCarry.to
    + " · NDX " + histCarry.ndx.length + " 行 / SPX " + histCarry.spx.length + " 行 / N225 "
    + ((histCarry.n225 || []).length) + " 行）");
} else {
  try {
    const cur = readFileSync(histFile, "utf8");
    if (cur === histHeader + histBody) {
      say("yearly.js 无变化，跳过写盘");
    } else {
      atomicWrite(histFile, histHeader + histBody);
      say("yearly.js 已写入（" + YEARLY_HIST.from + "~" + YEARLY_HIST.to
        + " · NDX " + YEARLY_HIST.ndx.length + " 行 / SPX " + YEARLY_HIST.spx.length
        + " 行 / N225 " + YEARLY_HIST.n225.length + " 行）");
    }
  } catch (e) {
    atomicWrite(histFile, histHeader + histBody);
    say("yearly.js 已创建（" + YEARLY_HIST.from + "~" + YEARLY_HIST.to + "）");
  }
}

/* ── 写 data.js（YTD，每日）──────────────────────────────────────────── */
const src = readFileSync(dataFile, "utf8");
const ytdBody = "const YEARLY_YTD = " + JSON.stringify(YEARLY_YTD, null, 1) + ";";
const ytdHeader = "/* AUTO（每日）：当年（" + ytdYear + "）的年度涨跌 / 年内最大涨幅 / 年内最大回撤 ——\n"
  + "   只放**当年**这一行；已完结年份在 yearly.js（那个一年才变一次）✓\n"
  + "   由 scripts/build-yearly.mjs 整块重写 */\n";
let candidate;
if (/^const YEARLY_YTD = \{/m.test(src)) {
  candidate = src.replace(/^const YEARLY_YTD = \{[\s\S]*?^\};/m, () => ytdBody);
} else {
  /* ⚠ 锚点从 `const NDX_DD` 换成 `const DDHIST`（2026-11-26 修）——
     `build-ndx-dd.mjs` 整块替换 NDX_DD 时，替换起点是它的**注释开头**
     （`/**\n * NDX_DD …`），而 YEARLY_YTD 原来正好夹在「注释」与「const」之间
     → 每次跑 build-ndx-dd 都会把 YEARLY_YTD **整块删掉**，页面年度表现直接消失 ✗
     换到 DDHIST 之前（在 NDX_DD 的范围之外）就安全了 ✓ */
  const anchor = "const DDHIST = {";
  if (!src.includes(anchor)) throw new Error("找不到插入锚点 const DDHIST");
  candidate = src.replace(anchor, () => ytdHeader + ytdBody + "\n\n" + anchor);
}
/* 清掉旧版整块 YEARLY（2026-11-26 前的形态，已拆成两个文件） */
candidate = candidate.replace(/^\/\* AUTO：近 15 年年度涨跌[\s\S]*?^const YEARLY = \{[\s\S]*?^\};\n\n/m, "");

if (candidate === src) {
  say("data.js: YEARLY_YTD 无变化，跳过写盘");
} else {
  atomicWrite(dataFile, candidate);
  say("data.js: YEARLY_YTD 已写入（" + asOf + " · NDX " + JSON.stringify(YEARLY_YTD.ndx || {}).slice(0, 40) + "…）");
}

/* ── 报告 ─────────────────────────────────────────────────────────────── */
const pct = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + "%";
["ndx", "spx", "n225"].forEach((k) => {
  const s = YEARLY_HIST.stats[k];
  if (!s) return;
  say("  " + k.toUpperCase() + " 全史 " + s.n + " 年：涨 " + s.pos + " 跌 " + s.neg + " · 胜率 " + s.winRate
    + "% · 累计 " + s.cum + " 倍（年化 " + s.cagr + "%）· 平均 " + pct(s.avg)
    + " · 年内回撤均值 " + pct(s.avgDD) + "（最深 " + pct(s.worstDD) + "）");
});
say("  当年 " + ytdYear + "：" + (YEARLY_YTD.ndx ? "NDX " + pct(YEARLY_YTD.ndx.yr) : "")
  + " · " + (YEARLY_YTD.spx ? "SPX " + pct(YEARLY_YTD.spx.yr) : "")
  + " · " + (YEARLY_YTD.n225 ? "N225 " + pct(YEARLY_YTD.n225.yr) : "") + "（YTD 至 " + asOf + "）");
