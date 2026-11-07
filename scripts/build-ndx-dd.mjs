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
 *   ③ 序列来自东财「100.NDX · 日线 · 前复权」——
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
    + "?secid=100.NDX&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56"
    + "&klt=101&fqt=1&beg=0&end=20500101&lmt=10000";
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const kl = j && j.data && j.data.klines;
  if (!Array.isArray(kl) || !kl.length) throw new Error("没拿到 klines");
  return kl.map((s) => { const a = s.split(","); return { d: a[0], c: +a[2] }; });
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

const all = await ndxDaily();
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
  source: "东财 100.NDX 日线（前复权）",
  since: SINCE,
  days: S.length,
  thresh: THRESH,
  latest: S.at(-1).c,
  events: ev,
  stats,
};

/* ── 写回 data.js：替换 NDX_DD 整块（没有就插在 DDHIST 之前）── */
const src = readFileSync(DATA, "utf8");
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
