#!/usr/bin/env node
"use strict";
/* 纳指类 ETF 的溢价扫描（PREM_SCAN）—— 2026-10-28 加，同日升级为「全历史分位」
 *
 * 回答两个问题：
 *   ① 「同一赛道 10 只，我该用哪只买？」（横向比较）
 *   ② 「现在这个溢价，在历史上算什么位置？」（纵向分位）
 *
 * 口径（每一条都写进块的 basis，因为这里最容易糊）：
 *   · 溢价(t) ＝ 收盘价(t) ÷ **前一交易日**单位净值 − 1
 *     为什么不用当日净值：QDII 的净值当晚才出、收盘那一刻你只知道昨晚那档。
 *     ⚠ 若某天缺「前一交易日」净值，**整天跳过**，绝不拿更早的凑 ——
 *       初版拿「最近一档」去比，10 只全部虚高 3pp、分位齐刷刷 95~100% ✗
 *   · 分位分三档：近 3 月（63 日）/ 近 1 年（252 日）/ **全历史**（上市至今）
 *     主口径用**全历史**：本窗口只有 189 天时，「中位 +7.1%」是这轮特殊期算出来的，
 *     拿它做溢价回归的敏感性会把风险低估一半 ✗（真实全史中位只有 +0.4%）
 *   · 脏点：|溢价| > 30% 一律剔除（已发现 513100 在 2022-01-14 有一条 −80% —— 净值/价格错位）
 *
 * 数据源（2026-10-28 换源，快 100 倍）：
 *   · 净值：`fund.eastmoney.com/pingzhongdata/{code}.js` —— **一个请求给全部净值历史**（2737 点）
 *     （f10/lsjz 那个接口每页只给 20 条，全历史要翻 137 页 ✗）
 *   · 日K：东财 push2his，`beg=0` 拿全历史
 *   · 规模/成交额：腾讯行情（亿），只作流动性参考
 *
 * 写盘：只重写 data.js 的 `const PREM_SCAN = {...};`（AUTO），失败不动原文件
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { atomicWrite } from "./data-quality.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const dataFile = join(ROOT, "data.js");
const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://fund.eastmoney.com/" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UNIVERSE = [
  ["159941", "纳指ETF广发", 0],
  ["513100", "纳指ETF国泰", 1],
  ["513300", "纳斯达克ETF华夏", 1],
  ["159632", "纳斯达克ETF华安", 0],
  ["159501", "纳指ETF嘉实", 0],
  ["159659", "纳斯达克100ETF招商", 0],
  ["159513", "纳斯达克100ETF大成", 0],
  ["513110", "纳指ETF华泰柏瑞", 1],
  ["159660", "纳指ETF汇添富", 0],
  ["513390", "纳指100ETF博时", 1],
];
const DROP = 30;        // |溢价| > 30% 视为脏点（净值/价格错位）
/* 走势图窗口（2026-10-28 定稿：260 天）：
   · 每条线都要存（用户要「10 只放一起画 + 可单选」），只存中位不够 ✗
   · 页面只提供 1M / 3M / 1Y 三档 → 存 252 就够；多存 8 天是给 1Y 档的边界留余量
   · 一度试过 756 天（3 年）：用户看过之后说「3 年意义不大」→ 去掉。原因是全史里
     2023–2024 的溢价长期贴着 0~5%，把 2025-10 之后的台阶压成一条细线，反而不如 1Y 清楚 ✓ */
const CHART_N = 260;

const d8 = (ts) => new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);   // 时间戳按 +08:00 取日期

async function navAll(code) {
  const r = await fetch(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, { headers: UA });
  const s = await r.text();
  const m = s.match(/var Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return [];
  return JSON.parse(m[1]).map((p) => ({ d: d8(p.x), v: +p.y })).filter((x) => x.v > 0).sort((a, b) => a.d.localeCompare(b.d));
}
async function kAll(code, market) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${market}.${code}`
    + `&fields1=f1,f2&fields2=f51,f53&klt=101&fqt=0&beg=0&end=20500101`;
  const j = await (await fetch(url, { headers: UA })).json();
  return ((j.data && j.data.klines) || [])
    .map((s) => { const [d, c] = s.split(","); return { d, c: +c }; })
    .filter((x) => x.c > 0);
}
async function quotes(codes) {
  const q = codes.map(([c, , m]) => (m ? "sh" : "sz") + c).join(",");
  const r = await fetch(`https://qt.gtimg.cn/q=${q}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const buf = new Uint8Array(await r.arrayBuffer());
  let txt; try { txt = new TextDecoder("gbk").decode(buf); } catch { txt = new TextDecoder().decode(buf); }
  const out = {};
  txt.split(";\n").forEach((line) => {
    const m = line.match(/v_\w+(\d{6})="([^"]*)"/);
    if (!m) return;
    const f = m[2].split("~");
    out[m[1]] = { turnover: +f[37] / 10000, scale: +f[45] };
  });
  return out;
}
const med = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const qOf = (arr, v) => Math.round((arr.filter((x) => x <= v).length / arr.length) * 100);

const Q = await quotes(UNIVERSE);
const items = [];
const byDate = new Map();          // 日期 → [各只溢价]，用于算「板块中位」那根线
for (const [code, name, market] of UNIVERSE) {
  await sleep(120);
  let ns = [], ks = [];
  try { ns = await navAll(code); } catch (e) { console.warn("  " + code + " 净值失败：" + e.message); continue; }
  try { ks = await kAll(code, market); } catch (e) { console.warn("  " + code + " K线失败：" + e.message); continue; }
  const navMap = new Map(ns.map((x) => [x.d, x.v]));
  const rows = [];
  let dropped = 0;
  for (let i = 1; i < ks.length; i++) {
    const prevNav = navMap.get(ks[i - 1].d);           // ★ 必须是前一交易日
    if (!prevNav) continue;
    const p = (ks[i].c / prevNav - 1) * 100;
    if (Math.abs(p) > DROP) { dropped++; continue; }
    rows.push({ d: ks[i].d, p });
  }
  if (rows.length < 60) { console.warn("  " + code + " 干净样本不足 " + rows.length); continue; }
  rows.forEach((r) => { if (!byDate.has(r.d)) byDate.set(r.d, []); byDate.get(r.d).push(r.p); });

  /* 统计量先不算 —— 要等「公共日」定下来再算（见下方 AS_OF），否则各只的 cur 会落在不同的日期上 ✗ */
  items.push({
    code, name, rows, dropped,
    scale: Q[code] ? +Q[code].scale.toFixed(0) : null,
    turnover: Q[code] ? +Q[code].turnover.toFixed(2) : null,
  });
}
if (!items.length) throw new Error("一只都没拉到，放弃写盘");

/* ── 公共日（2026-10-28 修）──────────────────────────────────────────────
 * QDII 的净值 T+1 才公布，所以「各只最新一天」天然会差 1~2 天：
 *   10-28 那天实测 7 只停在 10-27、3 只已到 10-28 —— 若直接并排，13.40%(10-27)
 *   会和 17.74%(10-28) 被当成同一时刻比较 ✗，而这张卡的全部意义就是横向比。
 * 所以取**所有只都有数据的那天**（最保守）作为 asOf，各只都截到这一天再算分位/中位。
 * 代价：个别只的新一天先不用（次日就追平），换来的是「同一张表里的数可比」✓ */
const asOf = items.map((x) => x.rows.at(-1).d).sort().at(0);
const asOfMax = items.map((x) => x.rows.at(-1).d).sort().at(-1);
items.forEach((it) => {
  it.rows = it.rows.filter((r) => r.d <= asOf);
  const prem = it.rows.map((r) => r.p);
  const cur = prem.at(-1);
  Object.assign(it, {
    cur: +cur.toFixed(2),
    date: it.rows.at(-1).d,
    q3: qOf(prem.slice(-63), cur),
    q1: qOf(prem.slice(-252), cur),
    qA: qOf(prem, cur),
    med: +med(prem).toFixed(2),
    min: +Math.min(...prem).toFixed(2),
    max: +Math.max(...prem).toFixed(2),
    days: it.rows.length,
    from: it.rows[0].d,
  });
});

/* 走势图：**所有 10 条都存** ＋ 一条板块中位（2026-10-28 改，用户要「全部一起画 + 可单选」）。
   存储用「共用日期轴 + 每只一个数组」而不是 [{d,p}]：756 天 × 10 只，后者要多带 10 遍日期（+50KB ✗）。
   缺值记 null（某些 ETF 上市晚 / 某天净值没对齐），画图时跳过 ✓ */
const mine = items.find((x) => x.code === "159941") || items[0];
const axis = mine.rows.slice(-CHART_N).map((r) => r.d);   // 只画近 CHART_N 天（全史另有分位/中位负责）
const pos = new Map(axis.map((d, i) => [d, i]));
const series = {};
items.forEach((it) => {
  const arr = new Array(axis.length).fill(null);
  it.rows.forEach((r) => { const i = pos.get(r.d); if (i !== undefined) arr[i] = +r.p.toFixed(1); });
  series[it.code] = arr;
});
const medArr = axis.map((d) => {
  const a = byDate.get(d) || [];
  return a.length >= 5 ? +med(a).toFixed(1) : null;
});
const chart = { code: mine.code, name: mine.name, from: axis[0], dates: axis, med: medArr, series };

const PREM_SCAN = {
  asOf,
  asOfMax,          // 个别只更新到哪天（页面据此提示「另有 N 只已到 X」）
  basis: "当日收盘 ÷ 前一交易日单位净值 − 1；缺前一交易日净值的那天整天跳过；|溢价| > 30% 的脏点剔除",
  window: { d3: 63, d1: 252, all: "上市至今" },
  chart,
  items,
};

/* 写盘前把 series 从 items 里摘掉（那是给 chart 用的中间量，不进块，省 12KB） */
PREM_SCAN.items.forEach((x) => { delete x.rows; });   // rows 是中间量（带完整序列），不进块

const src = readFileSync(dataFile, "utf8");
const body = "const PREM_SCAN = " + JSON.stringify(PREM_SCAN, null, 1) + ";";
const header = "/* AUTO：纳指类 ETF 溢价扫描（2026-10-28 加）—— 由 scripts/fetch-premium-scan.mjs 整块重写。\n"
  + "   ① 横向：同赛道 10 只谁更便宜（cur / scale / turnover）\n"
  + "   ② 纵向：当前溢价在 3 月 / 1 年 / **全历史** 里的分位（q3 / q1 / qA）＋ 全史中位 med\n"
  + "   ⚠ 主口径是**全历史**分位：本窗口只有 189 天时算出的「中位 +7.1%」是这轮特殊期的产物，\n"
  + "     拿它做溢价回归的敏感性会把风险低估一半（全史中位其实只有 +0.4%）✗\n"
  + "   ⚠ chart.pts 是「这只 / 板块中位」的近 252 日序列，只给走势图画线用。 */\n";
let candidate;
if (/^const PREM_SCAN = \{/m.test(src)) {
  candidate = src.replace(/^const PREM_SCAN = \{[\s\S]*?^\};/m, () => body);
} else {
  const anchor = "const DDHIST = {";
  if (!src.includes(anchor)) throw new Error("找不到插入锚点 const DDHIST");
  candidate = src.replace(anchor, () => header + body + "\n\n" + anchor);
}
if (candidate === src) {
  console.log("data.js: PREM_SCAN 无变化（" + items.length + " 只），跳过写盘");
  process.exit(0);
}
atomicWrite(dataFile, candidate);

console.log(`data.js: PREM_SCAN 已更新（${items.length} 只，截至 ${asOf}；走势图 ${chart.dates.length} 天 × ${items.length} 条）`);
items.slice().sort((a, b) => a.cur - b.cur).forEach((x) => {
  console.log("  " + x.code + " " + x.name.padEnd(16) + x.cur.toFixed(2) + "%  分位 3月" + String(x.q3).padStart(3)
    + " / 1年" + String(x.q1).padStart(3) + " / 全史" + String(x.qA).padStart(3)
    + "  全史 " + x.min.toFixed(1) + "~" + x.max.toFixed(1) + "%（中位 " + x.med.toFixed(2) + "%，" + x.days + " 日"
    + (x.dropped ? "，剔脏 " + x.dropped : "") + "）");
});
