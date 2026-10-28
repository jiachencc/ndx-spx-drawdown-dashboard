#!/usr/bin/env node
"use strict";
/* 回撤历史对照（DDHIST）—— 2026-10-24 加
 *
 * 为什么单独做一块：
 *   1. `index.html` 的「历史回撤对照」表是**手写**的，其中「2025 技术性回调 −13.7% / ~70 天」
 *      与数据不符（实际 −22.93% / 34 个交易日 ✗）—— 手写数一旦过期就没人发现。
 *   2. `positions.html` 要加一张「今年这几次跌 · 历史坐标」，若各自再写一份，就是两页两个口径。
 *   → 一次算好，两页共读 ✓。
 *
 * 口径（每一处都写清，因为这里最容易糊）：
 *   · **事件**（峰 → 谷、跌幅、用时、收复）＝ `RECENT` 的**真实指数收盘**，带日期，覆盖 2025-01 起；
 *     RECENT 之外（2000/2008 那些）本仓库没有日线，表里继续人工列，本块不碰 ✓。
 *   · **分布与排名**（近 10 年多少次 ≥10%、这次排第几）＝ `DCA_NDX` 这条**十年代理序列**
 *     （QQQ 缩放，2016-08 → 2026-08，无日期）。它只用来回答「多常见 / 排第几」，
 *     所以**不需要日期**；深度与真实 NDX 差 ≤0.5pp，排名时把 ±0.5pp 视为同一段（见 sameEvent）。
 *   · **条件统计**（跨过 −7% 之后最终跌多深）同样来自代理序列 —— 这是「历史上类似起点后来怎样」的
 *     条件分布，不是预测 ✓。
 *
 * 写盘：只重写 data.js 的 `const DDHIST = {...};` 整块（AUTO），失败则不动原文件。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import vm from "node:vm";
import { atomicWrite, isDate } from "./data-quality.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const dataFile = join(ROOT, "data.js");
const YEAR_THRESHOLD = -5;    // 「大的回撤」起点：≥5% 才进事件表（与页面回撤深度尺一致）
const SAME_EVENT = 0.5;       // 代理序列与真实指数的深度差，视为同一段
const COND_THR = -7;          // 条件统计的起点门槛

const src = readFileSync(dataFile, "utf8");
const ctx = vm.createContext({});
vm.runInContext(src + "\nthis.RECENT=RECENT;this.DN=DCA_NDX;this.DS=DCA_SPX;this.META=DCA_META;", ctx, { timeout: 8000 });

const R = ctx.RECENT, DN = ctx.DN, DS = ctx.DS, META = ctx.META;
if (!R || !R.ndx || !Array.isArray(R.ndx.pts)) throw new Error("RECENT.ndx 缺失");
if (!Array.isArray(DN) || DN.length < 500) throw new Error("DCA_NDX 缺失或过短");

/* 交易日差（含端点相减 = 中间隔了几个交易日） */
const tdays = (a, b) => a - b;

/* ── 1. RECENT 里的事件（真实收盘，带日期）────────────────────────────── */
/* ⚠ 口径选择（2026-10-24，来回改过三次才定）：
   若按**纯 zigzag**（峰→谷→收复）切，2026 年 3 月那次会被并进「2025-10 起的大跌」里
   （那一段 −12.12%、横跨 103 个交易日），于是「今年 3 月那次」在表里根本不会单独出现 ✗ ——
   而用户与页面其它地方说的都是**年内口径**（DEFAULT.ndx.ddYtd 也是这么算的）。
   → 这里按**年内口径**切：谷底所在年份内、谷底之前的最高收盘作为这段的起点。
     另外把「跨年口径」（从上一段谷底之后的最高点算起）也一并存下来，
     在提示里给出，免得把 2025-10 起的慢性下跌算漏 ✓。 */
/* 标准 zigzag（阈值 3%）：只有「反弹/回落 ≥3%」才算拐点，否则一路上的小波动都会被当成谷底 ✗ */
function zigzagTroughs(pts, bounce = 3) {
  const out = [];
  let dir = -1, ext = pts[0], extI = 0;
  for (let i = 1; i < pts.length; i++) {
    const c = pts[i].c;
    if (dir < 0) {
      if (c < ext.c) { ext = pts[i]; extI = i; }
      else if ((c / ext.c - 1) * 100 >= bounce) { out.push({ i: extI, d: ext.d, c: ext.c }); dir = 1; ext = pts[i]; extI = i; }
    } else {
      if (c > ext.c) { ext = pts[i]; extI = i; }
      else if ((c / ext.c - 1) * 100 <= -bounce) { dir = -1; ext = pts[i]; extI = i; }
    }
  }
  if (dir < 0) out.push({ i: extI, d: ext.d, c: ext.c });     // 还在跌 → 进行中
  return out;
}
function episodesWithDates(pts, minDepth) {
  const trs = zigzagTroughs(pts);
  const byYearPeak = new Map();     // 同一次下跌里可能有多个「≥3% 反弹后的小谷」→ 按起点去重、留最深 ✓
  trs.forEach((tr, k) => {
    const year = pts[tr.i].d.slice(0, 4);
    let yi = -1;
    for (let i = 0; i <= tr.i; i++) {
      if (pts[i].d.slice(0, 4) !== year) continue;
      if (yi < 0 || pts[i].c > pts[yi].c) yi = i;
    }
    if (yi < 0 || yi >= tr.i) return;
    const ddY = (tr.c / pts[yi].c - 1) * 100;
    if (ddY > minDepth) return;
    const prev = byYearPeak.get(yi);
    if (prev && prev.dd <= ddY) return;                        // 已有一条更深的同起点事件
    /* 跨年口径＝从**到谷底为止的历史最高收盘**量（最大回撤口径）。
       3 月那次就是它体现价值的地方：年内看起来 −11.8%（起于 1-28），
       但历史高点在 2025-10-29，从那儿量是 −12.12%、103 个交易日 —— 慢性下跌不能被漏掉 ✓ */
    let xi = 0;
    for (let i = 0; i <= tr.i; i++) if (pts[i].c > pts[xi].c) xi = i;
    let rec = null;
    for (let i = tr.i + 1; i < pts.length; i++) if (pts[i].c >= pts[yi].c) { rec = i; break; }
    byYearPeak.set(yi, {
      peak: pts[yi].d, peakC: pts[yi].c, trough: tr.d, troughC: tr.c,
      dd: +ddY.toFixed(2), days: tr.i - yi,
      crossPeak: pts[xi].d, crossDd: +((tr.c / pts[xi].c - 1) * 100).toFixed(2), crossDays: tr.i - xi,
      recover: rec !== null ? pts[rec].d : null, recDays: rec !== null ? rec - tr.i : null,
      /* ⚠ 「进行中」的判据是**还没收复**，不是「谷底就在最后一个点上」（2026-10-26 修）：
         RECENT 里一旦落了新的一天（哪怕只是短暂反弹），谷底就不再是末点，原来那条判断会把
         "还没收复"的事件标成已完成、并在日志里印出「收复 null（null 日）」✗ */
      ongoing: rec === null,
    });
  });
  return [...byYearPeak.values()].sort((a, b) => a.trough.localeCompare(b.trough));
}

/* ── 2. 代理序列的分布（无日期，只看深度）──────────────────────────────── */
function depths(cs, minDepth) {
  const out = [];
  let peak = cs[0], trough = cs[0], inDD = false;
  for (let i = 1; i < cs.length; i++) {
    if (cs[i] >= peak) {
      if (inDD) { const d = (trough / peak - 1) * 100; if (d <= minDepth) out.push(+d.toFixed(2)); }
      inDD = false; peak = trough = cs[i];
    } else { inDD = true; if (cs[i] < trough) trough = cs[i]; }
  }
  if (inDD) { const d = (trough / peak - 1) * 100; if (d <= minDepth) out.push(+d.toFixed(2)); }
  return out;
}

/* 条件统计：跨过 thr 的那些段，最终跌多深、以及从跨过到见底要几个交易日 */
function conditional(cs, thr) {
  const rows = [];
  let peak = cs[0], trough = cs[0], ti = 0, inDD = false, cross = -1;
  for (let i = 1; i < cs.length; i++) {
    if (cs[i] >= peak) {
      if (inDD && cross >= 0) {
        const d = (trough / peak - 1) * 100;
        if (d <= thr) rows.push({ dd: +d.toFixed(2), toTrough: ti - cross, recoverIn: i - ti });
      }
      inDD = false; peak = trough = cs[i]; ti = i; cross = -1;
    } else {
      inDD = true;
      if (cs[i] < trough) { trough = cs[i]; ti = i; }
      if (cross < 0 && (cs[i] / peak - 1) * 100 <= thr) cross = i;
    }
  }
  if (inDD && cross >= 0) {
    const d = (trough / peak - 1) * 100;
    if (d <= thr) rows.push({ dd: +d.toFixed(2), toTrough: ti - cross, recoverIn: null });
  }
  return rows;
}
const median = (a) => {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
};

const dist10 = depths(DN, -10);
const dist5 = depths(DN, -5);
const condRows = conditional(DN, COND_THR);

/* ── 3. 组装事件 ─────────────────────────────────────────────────────── */
const ndxEps = episodesWithDates(R.ndx.pts, YEAR_THRESHOLD);
const spxPts = (R.spx && R.spx.pts) || [];
const spxDdBetween = (from, to) => {
  const sub = spxPts.filter((p) => p.d >= from && p.d <= to);
  if (sub.length < 2) return null;
  let pk = sub[0].c, best = 0;
  sub.forEach((p) => { if (p.c > pk) pk = p.c; best = Math.min(best, (p.c / pk - 1) * 100); });
  return +best.toFixed(2);
};

const events = ndxEps.map((e) => {
  /* 排名：代理序列里「比它更深」的段数 +1。
     ⚠ 同一段在代理里的深度会差 ≤0.5pp（例：3 月在真实序列 −11.80、代理 −12.19），
       不排除的话会把自己算成「更深」的一段 ✗ → 用 SAME_EVENT 容差把它剔掉。 */
  const deeper = dist5.filter((d) => d < e.dd - SAME_EVENT).length;
  return {
    y: +e.trough.slice(0, 4),
    peak: e.peak, trough: e.trough,
    peakC: Math.round(e.peakC), troughC: Math.round(e.troughC),
    dd: e.dd, days: e.days,
    crossPeak: e.crossPeak, crossDd: e.crossDd, crossDays: e.crossDays,
    recover: e.recover, recDays: e.recDays,
    spx: spxDdBetween(e.peak, e.trough),
    deeper, rank: deeper + 1, rankOf: dist5.length,
    ongoing: e.ongoing,
    /* 进行中的那一段：再给出「谷底之后反弹了多少」（2026-10-28 加）——
       卡片上那行写的是**最大回撤**（峰→谷，10-23 的 −7.26%），而市场已经反弹了 2%+，
       不写清楚会让人以为"现在还跌 7.26%"✗。这里只给比值（收盘/收盘），不引入第二套口径 ✓。 */
    ...(e.ongoing ? {
      curDate: R.ndx.pts.at(-1).d,                       // ⚠ 这里只有 ndx（配置的六个周期都按 NDX 口径），没有 recentKey ✗
      rebound: +(((R.ndx.pts.at(-1).c / e.troughC) - 1) * 100).toFixed(2),
    } : {}),
  };
});

/* 月份标号（给卡片用）：用谷底所在月 → 「3 月」「7 月」「10 月」 */
events.forEach((e) => { e.label = (+e.trough.slice(5, 7)) + " 月"; });

const DDHIST = {
  asOf: R.asOf || (R.ndx && R.ndx.asOf) || null,
  basis: "事件＝RECENT 真实指数收盘（2025-01 起）；分布/条件统计＝近 10 年代理序列（"
    + (META && META.start) + " → " + (META && META.end) + "）",
  events,
  dist: { total: depths(DN, 0).length, n5: dist5.length, n10: dist10.length, n15: depths(DN, -15).length, n20: depths(DN, -20).length },
  /* 「典型回撤深度」＝近 10 年 **≥3% 的回撤段** 深度的中位数（＝ index.html 那条中位数游标）。
     为什么取 3% 而不是 0%：把日常噪音也算进去时中位只有 −0.85%，当不了"典型"✗（153 段里一多半是噪声）。
     取 3% 后 n=30、中位 ≈ −7.2%，与页面原来手写的 −7.50 基本吻合 —— 那个数大概率就是这么来的，
     只是当时没写清阈值，也没人能复现 ✓。 */
  median: { thr: -3, n: depths(DN, -3).length, med: +median(depths(DN, -3)).toFixed(2) },
  cond: {
    thr: COND_THR,
    n: condRows.length,
    deep: condRows.filter((r) => r.dd <= -10).length,
    pct: condRows.length ? Math.round(condRows.filter((r) => r.dd <= -10).length / condRows.length * 100) : null,
    medDepth: condRows.length ? +median(condRows.map((r) => r.dd)).toFixed(1) : null,
    medToTrough: condRows.length ? median(condRows.map((r) => r.toTrough)) : null,
  },
};

/* ── 4. 写盘（只换 DDHIST 整块；没有就插在 HOLD_HIST 之前）──────────────── */
const body = "const DDHIST = " + JSON.stringify(DDHIST, null, 1) + ";";
const header = "/* AUTO：回撤历史对照（2026-10-24 加）—— 由 scripts/build-ddhist.mjs 整块重写。\n"
  + "   事件来自 RECENT（真实收盘、带日期）；分布与条件统计来自十年代理序列（无日期，只用深度）。\n"
  + "   ⚠ 别再手写「2025 那次是 −13.7%」这种数：index.html 那张表已经因此错过一次（实际 −22.93%）。 */\n";
let candidate;
if (/^const DDHIST = \{/m.test(src)) {
  /* ⚠ 替换时**不带末尾换行**（正则也不吃它）—— 否则每跑一次就少/多一个空行，
     文件天天变、git 天天脏 ✗（2026-10-24 第一版就这么错的：连跑两次都说「已更新」） */
  candidate = src.replace(/^const DDHIST = \{[\s\S]*?^\};/m, () => body);
} else {
  const anchor = "const HOLD_HIST = {";
  if (!src.includes(anchor)) throw new Error("找不到插入锚点 const HOLD_HIST");
  candidate = src.replace(anchor, () => header + body + "\n\n" + anchor);
}
/* 内容没变就**不写盘、也不报错**（dd 这一步会跟着 daily.mjs 每天跑，行情没动时不该让整条链红 ✗） */
if (candidate === src) {
  console.log("data.js: DDHIST 无变化（" + events.length + " 段事件），跳过写盘");
  process.exit(0);
}
atomicWrite(dataFile, candidate);

console.log("data.js: DDHIST 已更新（" + events.length + " 段 ≥" + Math.abs(YEAR_THRESHOLD) + "% · 近 10 年 ≥10% "
  + dist10.length + " 次 · 条件统计 " + condRows.length + " 段）");
events.forEach((e) => console.log("  " + e.y + " " + e.label.padEnd(4) + e.peak + " → " + e.trough
  + "  " + e.dd.toFixed(2) + "%  " + e.days + " 日  "
  + (e.ongoing ? "进行中" : "收复 " + e.recover + "（" + e.recDays + " 日）")
  + "  第 " + e.rank + "/" + e.rankOf + " 深"));
