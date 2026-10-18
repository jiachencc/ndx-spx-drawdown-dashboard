#!/usr/bin/env node
/* 各标的持有收益序列（2026-10-18 加）—— 写 data.js 的 HOLD_HIST
 *
 * 解决什么：持仓页原来只有「资产走势」（账户总量）与「快照对比」（逐期 diff），
 *   看不到**单只标的自己的浮盈曲线** —— App 也只给当日/累计，不给过程。
 *   清仓标的尤其重要：只记得「亏了 13,157」，看不到「不清会亏更多」。
 *
 * 口径：
 *   · 份额/成本从 POSITIONS.log 逐笔重建（买入加、卖出减，摊薄成本）
 *   · 价格用腾讯前复权日K（与页面其他 ETF 报价同一接口）
 *   · 每日浮盈 = (收盘价 − 当时摊薄成本) × 当时份额
 *   · 已清仓的：曲线在清仓日归零并终止，另记 realized 与「若持有至今」
 *
 * 失败保留旧值：先 validateModel 再原子写，任何一步不过就不写。
 * 请求量：5 只 × 1 次（约 100KB）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDate, readModel, validateModel, atomicWrite } from "./data-quality.mjs";

const ROOT = new URL("../", import.meta.url);
const UA = "Mozilla/5.0";
/* 标的清单（MANUAL：加新标的只改这里）。name 必须与 POSITIONS.log 的 sym 完全一致。 */
const MAP = [
  { name: "纳指ETF广发", code: "159941", idx: "ndx" },
  { name: "标普500ETF南方", code: "513650", idx: "spx" },
  { name: "日经225ETF华安", code: "513880", idx: "n225" },
  { name: "港美互联网LOF", code: "160644", idx: "hkus" },
  { name: "中韩半导体ETF华泰", code: "513310", idx: "kr" },
];
const sym = (c) => (/^(15|16)/.test(c) ? "sz" : "sh") + c;

async function bars(code) {
  const s = sym(code);
  const r = await fetch("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" + s + ",day,,,320,qfq",
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(s + " HTTP " + r.status);
  const j = await r.json();
  const b = j.data?.[s], list = b?.qfqday || b?.day;
  if (!Array.isArray(list) || list.length < 20) throw new Error(s + " bars missing");
  const out = list.map((x) => ({ d: x[0], c: +x[2] })).filter((x) => isDate(x.d) && Number.isFinite(x.c) && x.c > 0);
  if (out.length < 20) throw new Error(s + " bars invalid");
  return out;
}

const dataFile = fileURLToPath(new URL("data.js", ROOT));
const src = readFileSync(dataFile, "utf8");
const model = readModel(src);
const log = model.POSITIONS.log || [];
const holdCodes = new Set((model.POSITIONS.hold || []).map((h) => h.code));

const items = [];
let asOf = null;
for (const m of MAP) {
  const trades = log.filter((e) => e.sym === m.name).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  if (!trades.length) { console.log("  跳过 " + m.name + "：流水里没有这笔"); continue; }
  let px;
  try { px = await bars(m.code); }
  catch (e) { console.log("  ⚠ " + m.name + " 价格抓取失败：" + e.message + "（保留旧值）"); continue; }

  let qty = 0, cost = 0, realized = 0, invested = 0, ti = 0;   // invested = 累计买入金额（清仓时算实现收益率的分母）
  let closedDate = null, qtyAtClose = 0, closePx = null, avgAtClose = null, lastSellRealized = null;
  const pts = [];
  for (const bar of px) {
    while (ti < trades.length && trades[ti].d <= bar.d) {
      const t = trades[ti], q = +t.qty || 0, c = +t.cost || 0;
      if (/买|建仓/.test(String(t.act || ""))) { cost += q * c; qty += q; invested += q * c; }
      else if (qty > 0) {
        const avg = cost / qty, sell = Math.min(q, qty);
        if (Number.isFinite(+t.realized)) { realized += +t.realized; lastSellRealized = +t.realized; }
        else realized += (c - avg) * sell;
        cost -= avg * sell; qty -= sell;
        if (qty <= 1e-6) { qty = 0; closedDate = bar.d; qtyAtClose = sell; closePx = c; avgAtClose = avg; cost = 0; }
      }
      ti++;
    }
    if (qty > 0) pts.push([bar.d, Math.round((bar.c - cost / qty) * qty), Math.round(qty), +((cost / qty)).toFixed(4), Math.round(cost)]);   // [日期, 浮盈, 份额, 摊薄成本, 成本基数]
    /* 清仓日（2026-10-18 改）：不再补一个 (date, 0) 的归零点 —— 那会让曲线在末端垂直掉到 0，
       读者以为「收益消失了」，也接不上后面的「假设没卖」延续段。
       改为记录清仓当日的**浮盈**（份额已归零，用清仓份额 × 原摊薄成本算），曲线在此终止。 */
    else if (closedDate && pts.length) {
      if (bar.d === closedDate) pts.push([bar.d, Math.round((bar.c - avgAtClose) * qtyAtClose), 0, +avgAtClose.toFixed(4), Math.round(avgAtClose * qtyAtClose)]);
      break;
    }
  }
  if (!pts.length) { console.log("  跳过 " + m.name + "：重建后没有持仓日"); continue; }

  const lastBar = px.at(-1);
  const lastPt = pts.at(-1);
  const closed = qty <= 0 && closedDate !== null;
  /* 已实现的口径（2026-10-18 修正）：
     ⚠ 券商在**清仓那一笔**里给的 `realized` 是「该标的累计实现」，不是单笔 ——
     直接累加会把前面几笔重复算一遍（港美会从 −5,275 变成 −10,347）。
     所以：清仓时取最后一笔的值；没清仓才逐笔累加。 */
  const realizedFinal = closed && lastSellRealized !== null ? lastSellRealized : realized;
  /* 「若持有至今」：清仓时的份额 ×（最新价 − 清仓价）—— 负数 = 不清会更亏 */
  const ifHeld = closed && closePx !== null ? Math.round(qtyAtClose * (lastBar.c - closePx)) : null;
  /* 「假设没卖」的延续线（2026-10-18 加）：清仓后用**原份额 × 原摊薄成本**继续算浮盈，
     曲线因此不断 —— 用户要看的正是「不清会怎样」，而不只是末端一个数字。 */
  const phantom = [];
  if (closed && avgAtClose !== null && qtyAtClose > 0) {
    for (const bar of px) {
      if (bar.d <= closedDate) continue;
      phantom.push([bar.d, Math.round((bar.c - avgAtClose) * qtyAtClose), Math.round(qtyAtClose), +avgAtClose.toFixed(4), Math.round(avgAtClose * qtyAtClose)]);
    }
  }
  items.push({
    code: m.code, name: m.name, idx: m.idx,
    first: pts[0][0], last: lastPt[0],
    closed, closedDate, realized: Math.round(realizedFinal), invested: Math.round(invested), ifHeld,
    qty: lastPt[2], avg: lastPt[3], pl: lastPt[1],
    pts, phantom,
  });
  if (!asOf || lastBar.d > asOf) asOf = lastBar.d;
  console.log("  " + m.name.padEnd(18) + pts[0][0] + " → " + lastPt[0] + "  " + pts.length + " 日" +
    (closed ? "  已清仓（已实现 " + Math.round(realizedFinal) + "，若持有至今 " + ifHeld + "）" : "  浮盈 " + lastPt[1]));
}

if (!items.length) { console.error("没有可写的标的，保留旧值"); process.exit(1); }
const next = { asOf, source: "Tencent qfq daily + POSITIONS.log", items };
/* ⚠ 不用 replaceConst（2026-10-18）：它的正则假设 body 是「每行一个 key」，
   而 items 会被 inlineLiteral 写成一整行（14KB），同一行里的每个 `, key:` 都会被当成新键 →
   重建出来的块结构损坏。这里直接整块 JSON 序列化后替换，简单且不会误伤。 */
if (!/^const HOLD_HIST = \{/m.test(src)) throw new Error("HOLD_HIST anchor missing");
const block = "const HOLD_HIST = " + JSON.stringify(next, null, 1) + ";";
const candidate = src.replace(/^const HOLD_HIST = \{[\s\S]*?^\};/m, () => block);
const errs = validateModel(readModel(candidate));
if (errs.length) { console.error("候选被拒（未写入）：" + errs.join("; ")); process.exit(1); }
atomicWrite(dataFile, candidate);
console.log("data.js: HOLD_HIST 已更新（" + items.length + " 只，截至 " + asOf + "）");
