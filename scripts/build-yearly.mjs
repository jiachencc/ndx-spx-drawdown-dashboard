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
async function fredSeries(id) {
  const r = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + id,
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
    const prevOk = prevRows && prevRows.length >= MIN_DAYS;
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
  return {
    n, pos, neg: n - pos,
    winRate: +((pos / n) * 100).toFixed(0),
    cum: +cum.toFixed(2),
    cagr: +((Math.pow(cum, 1 / n) - 1) * 100).toFixed(1),
    avg: +avg.toFixed(1),
    avgDD: +avgDD.toFixed(1),
    avgUp: +avgUp.toFixed(1),
    worstDD: +Math.min(...v.map((x) => x.dd)).toFixed(1),
    bestRun: +Math.max(...v.map((x) => x.runup)).toFixed(1),
  };
}

/* ── 跑 ───────────────────────────────────────────────────────────────── */
const say = (t) => console.log("  " + t);

let ndxRows, ndxSrc;
try {
  ndxRows = await fredSeries("NASDAQ100");
  ndxSrc = "FRED NASDAQ100";
  say("NDX ← FRED · " + ndxRows.length + " 根 · " + ndxRows[0].d + " ~ " + ndxRows[ndxRows.length - 1].d);
} catch (e) {
  ndxRows = await eastmoneySeries("100.NDX100", "19800101");
  ndxSrc = "Eastmoney 100.NDX100";
  console.warn("  ⚠ FRED NDX 失败（" + e.message + "）→ 退回东财（只到 2019-04，历史会短很多）");
}

let spxRows, spxSrc;
try {
  spxRows = await eastmoneySeries("100.SPX", "19800101");
  spxSrc = "Eastmoney 100.SPX";
  say("SPX ← 东财 · " + spxRows.length + " 根 · " + spxRows[0].d + " ~ " + spxRows[spxRows.length - 1].d);
} catch (e) {
  spxRows = await fredSeries("SP500");
  spxSrc = "FRED SP500";
  console.warn("  ⚠ 东财 SPX 失败（" + e.message + "）→ 退回 FRED（只有滚动 10 年）");
}

const ndxAll = yearlyStats(ndxRows);
const spxAll = yearlyStats(spxRows);
const ytdYear = +[ndxRows[ndxRows.length - 1].d, spxRows[spxRows.length - 1].d].sort()[1].slice(0, 4);

/* 已完结年份 → yearly.js；当年 → data.js */
const pick = (arr) => arr.filter((x) => x.complete && x.y < ytdYear && x.yr !== null);
const ndxHist = pick(ndxAll), spxHist = pick(spxAll);
const ndxYtd = ndxAll.find((x) => x.y === ytdYear) || null;
const spxYtd = spxAll.find((x) => x.y === ytdYear) || null;
const asOf = [ndxYtd ? ndxYtd.lastTrade : "?", spxYtd ? spxYtd.lastTrade : "?"].sort()[1];

if (!ndxHist.length || !spxHist.length) throw new Error("历史序列为空，放弃写盘");

const YEARLY_HIST = {
  updated: asOf,
  from: Math.min(ndxHist[0].y, spxHist[0].y),
  to: ytdYear - 1,
  basis: "年度＝年末收盘 ÷ 上年末收盘 − 1；年内最大涨幅＝按时间顺序 max(P_t/前低−1)；"
    + "年内最大回撤＝按时间顺序 max(1−P_t/前高)。两条都**顺序扫描**，不是「最高 ÷ 最低」"
    + "（后者在最高点早于最低点时给出从未发生过的数）。均为**价格回报**，不含股息。",
  sources: { ndx: ndxSrc, spx: spxSrc },
  ndx: ndxHist.map(({ y, yr, runup, dd }) => ({ y, yr, runup, dd })),
  spx: spxHist.map(({ y, yr, runup, dd }) => ({ y, yr, runup, dd })),
  stats: { ndx: summarize(ndxHist), spx: summarize(spxHist) },
};

const YEARLY_YTD = {
  asOf,
  y: ytdYear,
  basis: "当年未走完 → 三列只代表「年初到 " + asOf + "」；已完结年份在 yearly.js",
  ndx: ndxYtd ? { y: ndxYtd.y, yr: ndxYtd.yr, runup: ndxYtd.runup, dd: ndxYtd.dd } : null,
  spx: spxYtd ? { y: spxYtd.y, yr: spxYtd.yr, runup: spxYtd.runup, dd: spxYtd.dd } : null,
};

/* ── 写 yearly.js（历史，低频）────────────────────────────────────────── */
const histBody = "const YEARLY_HIST = " + JSON.stringify(YEARLY_HIST, null, 1) + ";\n";
const histHeader = "/* AUTO（低频）：年度涨跌 · 年内最大涨幅 · 年内最大回撤 —— 已完结年份\n"
  + "   ⚠ **这个文件一年只变一次**（新增一整年后），所以从 data.js 里拆出来 ——\n"
  + "     它占了年度数据的 99% 体积，留在 data.js 会让每日更新产生巨量 diff ✗\n"
  + "   ⚠ 当年（YTD）在 data.js 的 YEARLY_YTD，每日更新 ✓\n"
  + "   ⚠ ②「年内最大涨幅」③「年内最大回撤」都是**顺序扫描**，不是最高÷最低 ✗\n"
  + "   由 scripts/build-yearly.mjs 整块重写 */\n";
try {
  const cur = readFileSync(histFile, "utf8");
  if (cur === histHeader + histBody) {
    say("yearly.js 无变化，跳过写盘");
  } else {
    atomicWrite(histFile, histHeader + histBody);
    say("yearly.js 已写入（" + YEARLY_HIST.from + "~" + YEARLY_HIST.to
      + " · NDX " + YEARLY_HIST.ndx.length + " 行 / SPX " + YEARLY_HIST.spx.length + " 行）");
  }
} catch (e) {
  atomicWrite(histFile, histHeader + histBody);
  say("yearly.js 已创建（" + YEARLY_HIST.from + "~" + YEARLY_HIST.to + "）");
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
  const anchor = "const NDX_DD = {";
  if (!src.includes(anchor)) throw new Error("找不到插入锚点 const NDX_DD");
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
["ndx", "spx"].forEach((k) => {
  const s = YEARLY_HIST.stats[k];
  if (!s) return;
  say("  " + k.toUpperCase() + " 全史 " + s.n + " 年：涨 " + s.pos + " 跌 " + s.neg + " · 胜率 " + s.winRate
    + "% · 累计 " + s.cum + " 倍（年化 " + s.cagr + "%）· 平均 " + pct(s.avg)
    + " · 年内回撤均值 " + pct(s.avgDD) + "（最深 " + pct(s.worstDD) + "）");
});
say("  当年 " + ytdYear + "：" + (YEARLY_YTD.ndx ? "NDX " + pct(YEARLY_YTD.ndx.yr) : "")
  + " · " + (YEARLY_YTD.spx ? "SPX " + pct(YEARLY_YTD.spx.yr) : "") + "（YTD 至 " + asOf + "）");
