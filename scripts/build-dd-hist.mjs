#!/usr/bin/env node
/**
 * build-dd-hist.mjs —— 三指数回撤事件表（DD_HIST：ndx / spx / n225）
 *
 * 用户 2026-11-27：「日经的这种回撤要多久修复？」→「那纳指和标普是不是也可以加？」
 *
 * 来历：这块原本是**单指数**的 NDX_DD（build-ndx-dd.mjs，2026-11-07 为回答
 * 「纳指这波要修多久」而做，东财 100.NDX100 日线）。现在要覆盖三个指数，
 * 两份算法并存必然漂移 ✗ → 合成一块 DD_HIST，NDX_DD 与旧脚本一并退役 ✓
 *
 * ── 为什么换数据源（顺带修掉一个真问题）──────────────────────────────
 *   旧脚本只认东财 K 线；而东财在 GitHub runner 上整批不通（实测 fetch failed /
 *   other side closed），它只能退腾讯「最近 1000 根」＝4 年，事件数从 10 掉到 3，
 *   于是每次 CI 都靠「事件 <10 就拒写」的保护硬撑 → 纳指这块在 CI 里**其实一直没更新过** ✓
 *   现在三个源都在两侧（本机 + runner）实测可用：
 *     · ndx  ← FRED `NASDAQ100`（1986 起，10,307 根）
 *     · spx  ← 腾讯 `usINX` **区间**接口（1983 起 11,053 根；按 3 年一段取，单次上限 1000 根）
 *     · n225 ← FRED `NIKKEI225`（1949 起 19,248 根）
 *
 * ── 口径（页面必须原样写出来，不能让人误读）────────────────────────────
 *   ① 事件定义：从**历史最高点**回撤首次触及 −10%，直到收盘**收复前高**为止；
 *      未收复的那次标 ongoing ✓（可能持续很久，别当成「已修复」✗）
 *   ② 天数一律**交易日**；页面同时给日历日约数（×1.4）✓
 *   ③ 各指数序列与项目 DEFAULT（场内 ETF 价 / 指数点位）**绝对值不同** →
 *      只比**百分比回撤**，不取点位 ✓
 *   ④ 统计起点 per-index：ndx / spx 取 1995（与旧 NDX_DD 一致，便于对照）；
 *      **n225 取 1985** —— 必须含 1989 泡沫那一段（−82%、2024 才收复），
 *      那正是日经「−20% 不是终点」的尾部证据 ✓；排在后面的深度档样本极少，页面会显示 n ✓
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data.js");
const UA = { "User-Agent": "Mozilla/5.0" };
const THRESH = 10;                 // 回撤 ≥ 10% 才算一次事件
const DRY = process.argv.includes("--dry");
const MIN_EVENTS = 6;              // 少于这个数就判定「样本被截断」，保留旧值

/* ── 取数 ─────────────────────────────────────────────────────────── */
async function fredSeries(id) {
  const r = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + id,
    { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("FRED " + id + " HTTP " + r.status);
  const t = await r.text();
  const seen = new Set();
  const out = [];
  t.trim().split("\n").slice(1).forEach((l) => {
    const [d, v] = l.split(",");
    if (!d || !v || v === "." || seen.has(d)) return;
    const c = +v;
    if (!Number.isFinite(c) || c <= 0) return;
    seen.add(d);
    out.push({ d, c });
  });
  out.sort((a, b) => (a.d < b.d ? -1 : 1));
  if (!out.length) throw new Error("FRED " + id + " 无有效行");
  return out;
}

/* 腾讯**区间**接口：用 from,to 指定日期窗口、count 只当窗口内上限（上限 1000，
   传 12000 会返回 {"code":-1,"msg":"limit error"}）→ 3 年一段拼长历史 ✓ */
async function tencentRange(sym, y0, y1) {
  const seen = new Map();
  for (let y = y0; y <= y1; y += 3) {
    const from = y + "-01-01", to = Math.min(y + 2, y1) + "-12-31";
    const u = "https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param="
      + sym + ",day," + from + "," + to + ",1000,qfq";
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.qq.com/" },
      signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error("腾讯 " + sym + " " + from + " HTTP " + r.status);
    const j = await r.json();
    const obj = (j.data || {})[sym] || {};
    const key = Object.keys(obj).find((k) => Array.isArray(obj[k]));
    const arr = key ? obj[key] : [];
    if (!arr.length) throw new Error("腾讯 " + sym + " " + from + "~" + to + " 无数据");
    arr.forEach((x) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(x[0]) && +x[2] > 0) seen.set(x[0], +x[2]);
    });
  }
  return [...seen.entries()].map(([d, c]) => ({ d, c })).sort((a, b) => (a.d < b.d ? -1 : 1));
}

/* 腾讯「最近 N 根」接口（单次 1000 根 ≈ 4 年）—— 只作兜底，事件数会不够，靠 MIN_EVENTS 拦截 */
async function tencentRecent(sym) {
  const u = "https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=" + sym + ",day,,,1000,qfq";
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.qq.com/" },
    signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("腾讯 " + sym + " HTTP " + r.status);
  const j = await r.json();
  const obj = (j.data || {})[sym] || {};
  const key = Object.keys(obj).find((k) => Array.isArray(obj[k]));
  const arr = key ? obj[key] : [];
  if (!arr.length) throw new Error("腾讯 " + sym + " 无数据");
  return arr.map((x) => ({ d: x[0], c: +x[2] }))
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.d) && Number.isFinite(x.c) && x.c > 0);
}

/* ── 算法（与旧 build-ndx-dd.mjs 逐行一致，勿各写一套）──────────────── */
function findEvents(S) {
  const ev = [];
  let peak = S[0].c, peakD = S[0].d, peakIdx = 0;
  let inDD = false, trough = Infinity, troughD = "", troughIdx = 0, maxDD = 0;
  for (let i = 1; i < S.length; i++) {
    const x = S[i];
    if (!inDD) {
      if (x.c > peak) { peak = x.c; peakD = x.d; peakIdx = i; continue; }
      if (x.c / peak - 1 <= -THRESH / 100) {
        inDD = true; maxDD = x.c / peak - 1;
        trough = x.c; troughD = x.d; troughIdx = i;
      }
    } else {
      if (x.c < trough) { trough = x.c; troughD = x.d; troughIdx = i; maxDD = x.c / peak - 1; }
      if (x.c >= peak) {
        ev.push({ peak: peakD, trough: troughD, recover: x.d, dd: +(maxDD * 100).toFixed(2),
          toTrough: troughIdx - peakIdx, toRecover: i - troughIdx, total: i - peakIdx, ongoing: false });
        inDD = false; peak = x.c; peakD = x.d; peakIdx = i;
      }
    }
  }
  if (inDD) {
    ev.push({ peak: peakD, trough: troughD, recover: null, dd: +(maxDD * 100).toFixed(2),
      toTrough: troughIdx - peakIdx, toRecover: null, total: null, ongoing: true,
      /* age ＝ 峰→最新一根的交易日数（页面「已过 N 日」用它，三指数同一口径：
         原来纳指走 DEFAULT.ndx.days、日经/标普无从取，三处会各说各话 ✗） */
      age: S.length - 1 - peakIdx,
      at: +((S.at(-1).c / peak - 1) * 100).toFixed(2),          // 当前仍在跌幅 X%
      rebound: +((S.at(-1).c / trough - 1) * 100).toFixed(2) }); // 已从谷底反弹 X%
  }
  return ev;
}

const q2 = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2); };
const BUCKETS = [
  { k: "d10", label: "−10 ~ −15%", lo: -15, hi: -10 },
  { k: "d15", label: "−15 ~ −20%", lo: -20, hi: -15 },
  { k: "d20", label: "−20 ~ −30%", lo: -30, hi: -20 },
  { k: "d30", label: "≤ −30%", lo: -Infinity, hi: -30 },
];
function statsOf(ev) {
  return BUCKETS.map((b) => {
    const g = ev.filter((e) => !e.ongoing && e.dd <= b.hi && e.dd > b.lo);
    const tot = g.map((e) => e.total);
    return {
      k: b.k, label: b.label, n: g.length,
      medianTotal: tot.length ? med(tot) : null,
      medianToTrough: g.length ? med(g.map((e) => e.toTrough)) : null,
      medianToRecover: g.length ? med(g.map((e) => e.toRecover)) : null,
      p25: tot.length ? q2(tot, 0.25) : null,
      p75: tot.length ? q2(tot, 0.75) : null,
      /* 累计概率：从**高点**起算，N 个交易日内收复的比例（页面给 1/2/3/6 个月四档） */
      within: [21, 42, 63, 126].map((n) => ({ days: n, k: tot.filter((x) => x <= n).length, n: tot.length })),
    };
  });
}

/* ── 三个指数的取数链 ─────────────────────────────────────────────── */
const thisYear = new Date().getFullYear();
const DEFS = [
  {
    k: "ndx", name: "纳指100", since: "1995-01-01", prefer: "FRED NASDAQ100",
    async load() {
      try { return { rows: await fredSeries("NASDAQ100"), source: "FRED NASDAQ100" }; }
      catch (e) {
        const rows = await tencentRecent("usNDX");
        return { rows, source: "Tencent usNDX（仅近 1000 根 · 降级）", degraded: true, err: e.message };
      }
    },
  },
  {
    k: "spx", name: "标普500", since: "1995-01-01", prefer: "Tencent usINX（区间）",
    async load() {
      try { return { rows: await tencentRange("usINX", 1984, thisYear), source: "Tencent usINX（区间）" }; }
      catch (e) {
        const rows = await fredSeries("SP500");
        return { rows, source: "FRED SP500（仅近 10 年 · 降级）", degraded: true, err: e.message };
      }
    },
  },
  {
    k: "n225", name: "日经225", since: "1985-01-01", prefer: "FRED NIKKEI225",
    async load() { return { rows: await fredSeries("NIKKEI225"), source: "FRED NIKKEI225" }; },
  },
];

/* 旧块（含 NDX_DD 迁移期）—— 只用来做「事件数不许腰斩」的保护 */
const src0 = readFileSync(DATA, "utf8");
function oldBlock() {
  const m = /const DD_HIST = \{/.exec(src0);
  if (m) {
    const end = src0.indexOf(";\n\n", m.index);
    try { return JSON.parse(src0.slice(src0.indexOf("{", m.index), end)); } catch (e) { return null; }
  }
  const n = /const NDX_DD = \{/.exec(src0);
  if (n) {
    const end = src0.indexOf(";\n\n", n.index);
    try { return { indices: { ndx: JSON.parse(src0.slice(src0.indexOf("{", n.index), end)) } }; } catch (e) { return null; }
  }
  return null;
}
const OLD = oldBlock();

const indices = {};
for (const def of DEFS) {
  let got;
  try {
    got = await def.load();
  } catch (e) {
    console.log("⚠ " + def.name + " 取数失败（" + e.message + "）→ 沿用旧数据");
    const prev = OLD && OLD.indices && OLD.indices[def.k];
    if (prev) indices[def.k] = prev;
    continue;
  }
  const S = got.rows.filter((x) => x.d >= def.since);
  const ev = findEvents(S);
  const prev = OLD && OLD.indices && OLD.indices[def.k];
  const prevN = prev && Array.isArray(prev.events) ? prev.events.length : 0;
  /* 两道门槛：① 绝对下限 ② 不许比旧数据少 30% 以上（样本被截断的典型症状） */
  if (ev.length < MIN_EVENTS || (prevN >= MIN_EVENTS && ev.length < prevN * 0.7)) {
    console.log("⚠ " + def.name + " 事件 " + prevN + " → " + ev.length + " 次（样本疑似被截断）→ 沿用旧数据");
    if (prev) indices[def.k] = prev;
    continue;
  }
  indices[def.k] = {
    asOf: S.at(-1).d,
    since: def.since,
    source: got.source,
    degraded: !!got.degraded,
    days: S.length,
    latest: S.at(-1).c,
    events: ev,
    stats: statsOf(ev),
  };
  console.log("· " + def.name.padEnd(7) + " ← " + got.source + " · " + S.length + " 根 · "
    + S[0].d + " ~ " + S.at(-1).d + " · 事件 " + ev.length
    + "（进行中 " + ev.filter((e) => e.ongoing).length + "）" + (got.degraded ? " ⚠降级" : ""));
  if (got.err) console.log("    （主源失败：" + got.err + "）");
}

if (!Object.keys(indices).length) { console.error("三个指数都没取到，放弃写盘"); process.exit(1); }

const asOf = Object.values(indices).map((x) => x.asOf).sort().at(-1);
const payload = {
  asOf,
  basis: "事件＝从历史最高点回撤首次触及 −" + THRESH + "%，到收盘收复前高为止（未收复标 ongoing）；天数一律交易日；各指数只比百分比回撤、不取点位",
  thresh: THRESH,
  since: Object.fromEntries(Object.entries(indices).map(([k, v]) => [k, v.since])),
  indices,
};

/* ── 写回 data.js ─────────────────────────────────────────────────── */
const block = "/**\n"
  + " * DD_HIST —— 三指数回撤事件表（AUTO，scripts/build-dd-hist.mjs 写；2026-11-27 由 NDX_DD 升级而来）\n"
  + " * 回答「这种深度的回撤，历史上要多久才收复前高」：ndx / spx / n225 各一套事件 + 分档统计。\n"
  + " * ⚠ 各指数序列与该页 DEFAULT 的**绝对值不同**（复权 / 点位口径）→ 只用百分比回撤，不取点位 ✓\n"
  + " * ⚠ 天数一律**交易日**；页面另给日历日约数（×1.4）✓\n"
  + " * ⚠ n225 的统计起点是 1985（含 1989 泡沫那段 −82%）—— 尾部样本必须留着 ✓\n"
  + " */\n"
  + "const DD_HIST = " + JSON.stringify(payload, null, 0).replace(/"([a-zA-Z0-9]+)":/g, "$1: ")
  + ";\n\n";

/* 定位：优先整块替换 DD_HIST；首次迁移时替换 NDX_DD 那块（连它的注释一起）*/
let next = src0;
const hasHist = src0.includes("const DD_HIST = ");
const hasOld = src0.includes("const NDX_DD = ");
if (hasHist) {
  const start = src0.indexOf("/**\n * DD_HIST");
  const from = start >= 0 ? start : src0.indexOf("const DD_HIST = ");
  const end = src0.indexOf(";\n\n", src0.indexOf("const DD_HIST = ")) + 3;
  next = src0.slice(0, from) + block + src0.slice(end);
  console.log("DD_HIST 已替换");
} else if (hasOld) {
  const start = src0.indexOf("/**\n * NDX_DD");
  const from = start >= 0 ? start : src0.indexOf("const NDX_DD = ");
  const end = src0.indexOf(";\n\n", src0.indexOf("const NDX_DD = ")) + 3;
  next = src0.slice(0, from) + block + src0.slice(end);
  console.log("DD_HIST 已写入（替换旧的 NDX_DD 块）");
} else {
  const at = src0.indexOf("const DDHIST = {");
  if (at < 0) throw new Error("找不到 DDHIST，无法定位插入点");
  next = src0.slice(0, at) + block + src0.slice(at);
  console.log("DD_HIST 已插入（DDHIST 之前）");
}

if (DRY) console.log("（--dry：不写盘）");
else if (next === src0) console.log("data.js: DD_HIST 无变化，跳过写盘");
else { writeFileSync(DATA, next); console.log("data.js: DD_HIST 已写入"); }

/* ── 报告 ─────────────────────────────────────────────────────────── */
for (const [k, v] of Object.entries(indices)) {
  const og = v.events.filter((e) => e.ongoing)[0];
  console.log("\n" + k + " " + v.since + " → " + v.asOf + "（" + v.days + " 个交易日）"
    + (og ? " 进行中：" + og.peak + " 起，最深 " + og.dd + "%，现 " + og.at + "%（反弹 " + og.rebound + "%）" : ""));
  v.stats.forEach((s) => console.log("  " + s.label.padEnd(11) + String(s.n).padStart(3) + " 次"
    + "  峰→收复中位 " + String(s.medianTotal ?? "—").padStart(4)
    + "  区间 " + (s.p25 ?? "—") + "~" + (s.p75 ?? "—")
    + "  6 个月内 " + (s.within[3].n ? s.within[3].k + "/" + s.within[3].n : "—")));
}
