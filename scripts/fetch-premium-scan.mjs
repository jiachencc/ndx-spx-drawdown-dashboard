#!/usr/bin/env node
"use strict";
/* 纳指类 ETF 的溢价扫描（PREM_SCAN）—— 2026-10-28 加
 *
 * 回答的问题：「同一赛道有 10 只 ETF，我该用哪只买？」
 *   · 页面原来只在**每张持仓卡**上有溢价胶囊（自己那只）＋ 「工具」里的标的替换回测（过去换了会怎样）
 *     —— 缺的是「**现在**，同类里谁更便宜」
 *
 * 口径（每一条都写在输出里，因为这里最容易糊）：
 *   · 溢价(t) ＝ 收盘价(t) ÷ **前一交易日**单位净值 − 1
 *     为什么不用当日净值：QDII 的净值当晚才出、收盘那一刻你只知道昨晚那档。
 *     ⚠ 若某天缺「前一交易日」净值，**整天跳过**，绝不拿更早的凑 ——
 *       2026-10-28 初版就是拿「最近一档」去比，10 只全部虚高 3pp、分位齐刷刷 95~100% ✗
 *   · 分位 ＝ 该溢价在**本窗口**（约 160 个交易日）里的百分位
 *   · 规模/成交额取腾讯行情（亿），只作流动性参考
 *
 * 数据源：东财日K（fqt=0 不复权）＋ 东财 f10 单位净值（**每页只给 20 条，必须翻页**）
 * 写盘：只重写 data.js 的 `const PREM_SCAN = {...};`（AUTO），失败不动原文件
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { atomicWrite } from "./data-quality.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const dataFile = join(ROOT, "data.js");
const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://fundf10.eastmoney.com/" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 赛道：同花顺「纳指100」分组里规模较大、日常能成交的 10 只（2026-10-28 核对过代码） */
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
const LOOKBACK = 170;          // 约 160 个交易日
const NAV_PAGES = 10;          // 每页 20 条 → 200 个净值日

async function kline(code, market) {
  const d = new Date(Date.now() - LOOKBACK * 1.7 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${market}.${code}`
    + `&fields1=f1,f2&fields2=f51,f53&klt=101&fqt=0&beg=${d}&end=20500101`;
  const j = await (await fetch(url, { headers: UA })).json();
  return ((j.data && j.data.klines) || [])
    .map((s) => { const [dd, c] = s.split(","); return { d: dd, c: +c }; })
    .filter((x) => x.c > 0);
}
async function navs(code) {
  const all = [];
  for (let i = 1; i <= NAV_PAGES; i++) {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${i}&pageSize=20`;
    const j = await (await fetch(url, { headers: UA })).json();
    const list = (j.Data && j.Data.LSJZList) || [];
    if (!list.length) break;
    all.push(...list.map((x) => ({ d: x.FSRQ, v: +x.DWJZ })));
    await sleep(90);
  }
  return all.filter((x) => x.v > 0).sort((a, b) => a.d.localeCompare(b.d));
}
async function quotes(codes) {
  const q = codes.map(([c, , m]) => (m ? "sh" : "sz") + c).join(",");
  const r = await fetch(`https://qt.gtimg.cn/q=${q}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const buf = new Uint8Array(await r.arrayBuffer());
  let txt;
  try { txt = new TextDecoder("gbk").decode(buf); } catch { txt = new TextDecoder().decode(buf); }
  const out = {};
  txt.split(";\n").forEach((line) => {
    const m = line.match(/v_\w+(\d{6})="([^"]*)"/);
    if (!m) return;
    const f = m[2].split("~");
    out[m[1]] = { turnover: +f[37] / 10000, scale: +f[45] };   // 成交额万→亿、总市值亿
  });
  return out;
}
const med = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

const Q = await quotes(UNIVERSE);
const items = [];
for (const [code, name, market] of UNIVERSE) {
  await sleep(120);
  let ks = [], ns = [];
  try { ks = await kline(code, market); } catch (e) { console.warn("  " + code + " K线失败：" + e.message); continue; }
  try { ns = await navs(code); } catch (e) { console.warn("  " + code + " 净值失败：" + e.message); continue; }
  const navMap = new Map(ns.map((x) => [x.d, x.v]));
  const rows = [];
  for (let i = 1; i < ks.length; i++) {
    const prevNav = navMap.get(ks[i - 1].d);          // ★ 必须是前一交易日，缺就跳过
    if (!prevNav) continue;
    rows.push({ d: ks[i].d, c: ks[i].c, navPrev: prevNav });
  }
  if (rows.length < 30) { console.warn("  " + code + " 干净样本不足 " + rows.length); continue; }
  const prem = rows.map((r) => (r.c / r.navPrev - 1) * 100);
  const sorted = [...prem].sort((a, b) => a - b);
  const cur = prem.at(-1);
  items.push({
    code, name,
    cur: +cur.toFixed(2),
    date: rows.at(-1).d,
    q: Math.round((sorted.filter((v) => v <= cur).length / sorted.length) * 100),
    med: +med(prem).toFixed(2),
    min: +Math.min(...prem).toFixed(2),
    max: +Math.max(...prem).toFixed(2),
    days: rows.length,
    scale: Q[code] ? +Q[code].scale.toFixed(0) : null,
    turnover: Q[code] ? +Q[code].turnover.toFixed(2) : null,
  });
}
if (!items.length) throw new Error("一只都没拉到，放弃写盘");

const asOf = items.map((x) => x.date).sort().at(-1);
const PREM_SCAN = {
  asOf,
  basis: "当日收盘 ÷ 前一交易日单位净值 − 1；缺前一交易日净值的那天整天跳过（不拿更早的凑）",
  window: Math.min(...items.map((x) => x.days)) + " 个交易日",
  items,
};

const src = readFileSync(dataFile, "utf8");
const body = "const PREM_SCAN = " + JSON.stringify(PREM_SCAN, null, 1) + ";";
const header = "/* AUTO：纳指类 ETF 溢价扫描（2026-10-28 加）—— 由 scripts/fetch-premium-scan.mjs 整块重写。\n"
  + "   回答「同一赛道 10 只，现在该用哪只买」；口径见脚本头部：收盘 ÷ **前一交易日**净值 − 1。\n"
  + "   ⚠ 分位是「本窗口（约 160 个交易日）内的百分位」，不是历史全生命周期的。 */\n";
let candidate;
if (/^const PREM_SCAN = \{/m.test(src)) {
  candidate = src.replace(/^const PREM_SCAN = \{[\s\S]*?^\};/m, () => body);   // 不带末尾换行，保证幂等
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

console.log(`data.js: PREM_SCAN 已更新（${items.length} 只，截至 ${asOf}）`);
items.slice().sort((a, b) => a.cur - b.cur).forEach((x) => {
  console.log("  " + x.code + " " + x.name.padEnd(16) + x.cur.toFixed(2) + "%  分位 " + String(x.q).padStart(3)
    + "%  中位 " + x.med.toFixed(2) + "%  区间 " + x.min.toFixed(1) + "~" + x.max.toFixed(1)
    + "%  规模 " + x.scale + "亿  成交 " + x.turnover + "亿");
});
