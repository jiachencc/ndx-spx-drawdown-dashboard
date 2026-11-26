#!/usr/bin/env node
/**
 * build-ndx-dd.mjs —— 纳指回撤事件表（NDX_DD）
 *
 * 用户 2026-11-07：「通过历史数据，预估纳指目前的跌幅需要多久修复？」
 *  → 需要一个「当前回撤 vs 历史同档」的对照，数据必须是**真实长历史**、
 *    不能只用 DDHIST 那 5 个近期事件（2025-01 起，样本太小 ✗）
 *
 * 做法：抓东财 NDX 日线（1991 至今，8,800+ 个交易日）→ 识别「从 ATH 回撤 ≥10%」
 *      的完整事件 → 存成常量，页面据此算「同类跌幅历史上多久收复」✓
 *
 * ⚠ 口径（页面要原样写出来，不能让人误读）：
 *   ① 事件定义：从**历史最高点**回撤首次触及 −10%，直到收盘**收复前高**为止；
 *      未收复的那次标 ongoing ✓（可能持续很久，别当成"已修复"✗）
 *   ② 天数一律**交易日**（不是日历日）；页面同时给日历日约数（×1.4）✓
 *   ③ 序列来自东财「100.NDX100 · 日线 · 前复权」（⚠ 2026-11-22 前误用 100.NDX，那是纳斯达克综合）——
 *      它的**绝对值与项目 DEFAULT.ndx 不同**（复权口径差异，ATH 27,599.89 vs 31,361.37），
 *      但**百分比回撤**可比 ✓ 页面只用百分比，不用绝对点位 ✓
 *   ④ 1995 年前的数据留在原始序列里但不参与统计（早期数据质量不稳 + 样本够用 ✓）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data.js");
const UA = { "User-Agent": "Mozilla/5.0" };
const THRESH = 10;          // 回撤 ≥ 10% 才算一次事件
const SINCE = "1995-01-01"; // 统计起点

async function ndxDaily() {
  const url = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
    /* ⚠ 2026-11-22 修：`100.NDX` 在东财返回的是**纳斯达克综合指数（IXIC）**，不是纳斯达克100 ✗
       —— 实测（11-20）：东财 100.NDX 收 22,617.73 / 高 23,837.76 / 低 22,513.01，
       与新浪 gb_$ixic 的 22,617.7330 / 23,837.7641 / 22,513.0127 **逐位一致**；
       而同日真正的 NDX 收盘是 25,028.98（Yahoo + 新浪双源吻合）。
       后果：整条序列都是 IXIC → 「本次回撤」算成 −18.05%（真实 −19.85%），
       恰好跨过 −20% 档位边界，把「还需要修多久」的答案从 131 日变成 176 日 ✗
       正确码：`100.NDX100`（实测末根 25,028.98，与双源一致 ✓） */
    + "?secid=100.NDX100&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56"
    + "&klt=101&fqt=1&beg=0&end=20500101&lmt=10000";
  /* ⚠ 2026-11-25 加腾讯兜底（GitHub Actions 的 runner 在海外，东财 K 线接口整批抓不到，
     实测 `TypeError: fetch failed` / `SocketError: other side closed`，CI 直接崩在这步 ✗）
     ⚠ 但腾讯美股只给 **1000 根（≈4 年，2022-11 起）**，而本脚本的统计起点是 1995 ——
       降级后「历史 10 次深跌」会缩成 2~3 次，**必须让用户看得见**，所以：
       · 返回值和 source 一起给出，main 里把 source 写进 NDX_DD
       · 页面「数据健康」区会显示实际来源 ✓（降级要明示，不能假装满血）*/
  const TENCENT_US = "https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=usNDX,day,,,1000,qfq";
  const fetchTencent = async () => {
    const r2 = await fetch(TENCENT_US, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (!r2.ok) throw new Error("HTTP " + r2.status);
    const j2 = await r2.json();
    const d2 = (j2.data || {}).usNDX || {};
    const arr = d2.qfqday || d2.day || [];
    if (!Array.isArray(arr) || !arr.length) throw new Error("腾讯没给 klines");
    return arr.map((x) => ({ d: x[0], c: +x[2] }))
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.d) && Number.isFinite(x.c) && x.c > 0);
  };
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const kl = j && j.data && j.data.klines;
    if (!Array.isArray(kl) || !kl.length) throw new Error("没拿到 klines");
    return { rows: kl.map((s) => { const a = s.split(","); return { d: a[0], c: +a[2] }; }), source: "eastmoney" };
  } catch (e) {
    const rows = await fetchTencent();
    console.log("  ⚠ 东财不可用（" + e.message + "）→ 改用腾讯 " + rows.length + " 根"
      + "（" + rows[0].d + " 起，样本缩水，非满血口径）");
    return { rows, source: "tencent-1000" };
  }
}

/** 识别回撤事件：从 ATH 首次触及 −THRESH%，到收盘重回前高（或一直到序列末还没回） */
function events(S) {
  const ev = [];
  let peak = S[0].c, peakD = S[0].d, peakIdx = 0;
  let inDD = false, trough = Infinity, troughD = "", troughIdx = 0, maxDD = 0;

  for (let i = 1; i < S.length; i++) {
    const x = S[i];
    if (!inDD) {
      if (x.c > peak) { peak = x.c; peakD = x.d; peakIdx = i; continue; }
      const dd = x.c / peak - 1;
      if (dd <= -THRESH / 100) {
        inDD = true; maxDD = dd; trough = x.c; troughD = x.d; troughIdx = i;
      }
    } else {
      const dd = x.c / peak - 1;
      if (x.c < trough) { trough = x.c; troughD = x.d; troughIdx = i; maxDD = dd; }
      if (x.c >= peak) {
        ev.push({
          peak: peakD, trough: troughD, recover: x.d,
          dd: +(maxDD * 100).toFixed(2),
          toTrough: troughIdx - peakIdx,
          toRecover: i - troughIdx,
          total: i - peakIdx,
          ongoing: false,
        });
        inDD = false; peak = x.c; peakD = x.d; peakIdx = i;
      }
    }
  }
  if (inDD) {
    ev.push({
      peak: peakD, trough: troughD, recover: null,
      dd: +(maxDD * 100).toFixed(2),
      toTrough: troughIdx - peakIdx,
      toRecover: null, total: null,
      ongoing: true,
      at: +(S.at(-1).c / peak - 1) * 100,     // 当前仍在跌幅 X%
      rebound: +(S.at(-1).c / trough - 1) * 100, // 已从谷底反弹 X%
    });
  }
  return ev;
}

const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2); };

const ndxRes = await ndxDaily();
const all = ndxRes.rows;
const S = all.filter((x) => x.d >= SINCE);
const ev = events(S);

/* 分档：按跌幅深度 —— 页面按「当前跌幅落在哪档」去取对应统计 ✓ */
const BUCKETS = [
  { k: "d10", label: "−10 ~ −15%", lo: -15, hi: -10 },
  { k: "d15", label: "−15 ~ −20%", lo: -20, hi: -15 },
  { k: "d20", label: "−20 ~ −30%", lo: -30, hi: -20 },
  { k: "d30", label: "≤ −30%",     lo: -Infinity, hi: -30 },
];
const stats = BUCKETS.map((b) => {
  const g = ev.filter((e) => !e.ongoing && e.dd <= b.hi && e.dd > b.lo);
  const tot = g.map((e) => e.total);
  return {
    k: b.k, label: b.label,
    n: g.length,
    medianTotal: tot.length ? med(tot) : null,
    medianToTrough: g.length ? med(g.map((e) => e.toTrough)) : null,
    medianToRecover: g.length ? med(g.map((e) => e.toRecover)) : null,
    p25: tot.length ? q(tot, 0.25) : null,
    p75: tot.length ? q(tot, 0.75) : null,
    /* 累计概率：从**高点**起算，N 个交易日内收复的比例 ✓（页面给 1/2/3/6 个月四档）*/
    within: [21, 42, 63, 126].map((n) => ({
      days: n,
      k: tot.filter((x) => x <= n).length,
      n: tot.length,
    })),
  };
});

const payload = {
  asOf: S.at(-1).d,
  /* ⚠ 原来这里有两个 `source:`（前者被后者覆盖）——
     现在合成一句，降级时能在页面上看出来 ✓ */
  source: "东财 100.NDX100 日线（前复权）",
  since: SINCE,
  degraded: ndxRes.source !== "eastmoney",
  days: S.length,
  thresh: THRESH,
  latest: S.at(-1).c,
  events: ev,
  stats,
};

/* ── 写回 data.js：替换 NDX_DD 整块（没有就插在 DDHIST 之前）── */
const src = readFileSync(DATA, "utf8");

/* ⚠ 降级时**放弃写盘**（2026-11-26 加）——
   东财 K 线在 GitHub runner 上不通时会退到腾讯，而腾讯美股只给 1,000 根（≈4 年），
   于是「纳指 30 年 ≥10% 回撤约 20 次」会缩成 3 次 ✗
   实测 CI 里 check-data 直接报「NDX_DD: events 少于 10 次」→ 整条流水线红 ✗
   → 新事件数比旧数据少 30% 以上就**不写**，保留上一版满血数据 ✓
     （「今天没更新」远比「把 20 次的历史换成 3 次」安全） */
const oldEvN = (() => {
  const m = /const NDX_DD = \{[\s\S]*?"?events"?:\s*\[/.exec(src) || /events:\s*\[/.exec(src);
  if (!m) return 0;
  const seg = src.slice(m.index);
  return (seg.match(/\{"?start"?|start:/g) || []).length;
})();
if (oldEvN >= 10 && ev.length < oldEvN * 0.7) {
  console.log("⚠ 降级到 " + ndxRes.source + "（样本缩水）：事件 " + oldEvN + " → " + ev.length
    + " 次 → **放弃写盘**，保留旧的满血 NDX_DD ✓");
  process.exit(0);
}
const block = "/**\n * NDX_DD —— 纳指回撤事件表（AUTO，scripts/build-ndx-dd.mjs 写）\n"
  + " * 用户 2026-11-07：「预估纳指目前的跌幅需要多久修复？」→ 需要真实长历史，\n"
  + " * 而 DDHIST 只有 5 个近期事件（2025-01 起）样本太小 ✗ 故单开这一块 ✓\n"
  + " * ⚠ 绝对值与 DEFAULT.ndx 不同（复权口径差异）→ **只用百分比回撤**，不取点位 ✓\n"
  + " * ⚠ 天数一律**交易日**；页面另给日历日约数（×1.4）✓\n"
  + " */\nconst NDX_DD = " + JSON.stringify({ ...payload, events: ev.map((e) => ({ ...e })) }, null, 0)
    .replace(/"([a-zA-Z]+)":/g, "$1: ")   // 去掉键的引号，与其他常量风格一致
  + ";\n\n";

let next;
if (src.includes("const NDX_DD = ")) {
  const i = src.indexOf("/**\n * NDX_DD");
  const start = i >= 0 ? i : src.indexOf("const NDX_DD = ");
  const end = src.indexOf(";\n\n", src.indexOf("const NDX_DD = ")) + 3;
  next = src.slice(0, start) + block + src.slice(end);
  console.log("NDX_DD 已替换");
} else {
  const at = src.indexOf("const DDHIST = {");
  if (at < 0) throw new Error("找不到 DDHIST，无法定位插入点");
  next = src.slice(0, at) + block + src.slice(at);
  console.log("NDX_DD 已插入（DHIST 之前）");
}

/* ⚠ 内容没变就别写（否则 daily 每天都会产生一个无意义 diff ✗，与其它 AUTO 块的行为不一致）*/
if (next === src) {
  console.log("data.js: NDX_DD 无变化，跳过写盘");
} else {
  writeFileSync(DATA, next);
}

console.log("纳指 " + payload.since + " → " + payload.asOf + "（" + payload.days + " 个交易日）");
console.log("回撤 ≥" + THRESH + "% 事件 " + ev.length + " 次（进行中 " + ev.filter((e) => e.ongoing).length + " 次）");
stats.forEach((s) => {
  console.log("  " + s.label.padEnd(11) + " " + String(s.n).padStart(2) + " 次"
    + "  峰→收复中位 " + String(s.medianTotal ?? "—").padStart(4) + " 日"
    + "  区间 " + (s.p25 ?? "—") + "~" + (s.p75 ?? "—")
    + "  3个月内 " + (s.within[2].n ? (s.within[2].k + "/" + s.within[2].n) : "—"));
});
