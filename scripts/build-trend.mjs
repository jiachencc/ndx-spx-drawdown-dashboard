#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
   场内标的的「技术面读数」（scripts/build-trend.mjs）
   对**每一只场内标的**（在持 ＋ 已清仓）抓日线，写进 data.js 的 TREND：

     px / pxDate        最新收盘与日期（东财日线，fqt=1）
     ma50 / ma200       均线；aboveMa50 / aboveMa200  现价在均线上下
     rsi14              RSI（简单窗口，与页面 SOURCE_META 里写的口径一致）
     pos52 / hi52 / lo52 / distHi   52 周区间位置、高点、低点、距高点
     dif / dea / bull / aboveZero / crossType / crossDate / crossAgo   MACD(12,26,9)

   两处消费者：
     · 持仓卡「趋势」一行 —— 长期 MA200 / 中期 MA50 / RSI / 位置
     · 「已清仓标的后市」卡 —— 现价 ＋ MACD 状态
   （原来只服务后者，块名叫 SELL_AFTER；2026-11-02 起两份用途合并成 TREND，
     避免同一份日线算两遍、两块数据各说各话 ✗）

   ⚠ MACD **只作观察**：实测三只持仓 ETF 的金叉 20 日胜率 63~65%，
     与「随便哪天买」的基线（64%/70%/58%）持平甚至更低 → 卡面不画箭头、不写「要涨」✗
   ⚠ 卖出价与份数**不进这个块** —— 那是 POSITIONS.log 的事实，页面直接读，避免两份来源 ✗
   ⚠ 幂等：内容相同则跳过写盘。
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data.js");
const UA = { "User-Agent": "Mozilla/5.0" };
const secid = (code) => (/^(15|16|00|30)/.test(code) ? "0." : "1.") + code;

const src = readFileSync(DATA, "utf8");
const ctx = vm.createContext({});
/* ⚠ 场内标的（含已清仓）在 HOLD_HIST.items（带 code / closed），
   不在 CLOSED.items —— 后者是**场外**已清仓的基金（债基那批）✗ 两个块容易混 */
vm.runInContext(src + "\nthis.H=HOLD_HIST;", ctx, { timeout: 9000 });
const items = ((ctx.H && ctx.H.items) || []).filter((x) => x && x.code);
if (!items.length) { console.log("没有场内标的，跳过"); process.exit(0); }

const ema = (a, n) => { const k = 2 / (n + 1); let e = a[0]; return a.map((v, i) => (i ? (e = v * k + e * (1 - k)) : (e = v))); };
const sma = (a, n) => { if (a.length < n) return null; return a.slice(-n).reduce((x, y) => x + y, 0) / n; };
/* RSI14：简单窗口（与页面 SOURCE_META 里「simple-window RSI14」同一口径 ✓） */
const rsiLast = (cl, n = 14) => {
  if (cl.length <= n) return null;
  let g = 0, l = 0;
  for (let i = cl.length - n; i < cl.length; i++) {
    const d = cl[i] - cl[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  return (g + l) ? (g / (g + l)) * 100 : 50;
};

const out = {};
let asOf = "";

for (const it of items) {
  const url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=" + secid(it.code)
    + "&fields1=f1,f2&fields2=f51,f53&klt=101&fqt=1&beg=0&end=20500101";
  let rows;
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
    const j = await res.json();
    rows = ((j.data && j.data.klines) || [])
      .map((s) => { const [d, c] = s.split(","); return { d, c: +c }; })
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.d) && Number.isFinite(x.c) && x.c > 0);
  } catch (e) { console.warn("  " + it.code + " 取价失败：" + e.message + "（保留旧值）"); continue; }
  if (rows.length < 60) { console.warn("  " + it.code + " 日线不足，跳过"); continue; }

  const cl = rows.map((r) => r.c), n = cl.length, last = cl[n - 1];
  const e12 = ema(cl, 12), e26 = ema(cl, 26);
  const dif = cl.map((_, i) => e12[i] - e26[i]);
  const dea = ema(dif, 9);
  let crossType = null, crossIdx = -1;
  for (let i = n - 1; i >= 1; i--) {
    if (dif[i] > dea[i] && dif[i - 1] <= dea[i - 1]) { crossType = "gold"; crossIdx = i; break; }
    if (dif[i] < dea[i] && dif[i - 1] >= dea[i - 1]) { crossType = "death"; crossIdx = i; break; }
  }
  const w = cl.slice(-252);
  const hi = Math.max(...w), lo = Math.min(...w);
  const ma50 = sma(cl, 50), ma200 = sma(cl, 200);

  out[it.code] = {
    name: it.name,
    closed: !!it.closed,
    px: +last.toFixed(3),
    pxDate: rows[n - 1].d,
    ma50: ma50 === null ? null : +ma50.toFixed(3),
    ma200: ma200 === null ? null : +ma200.toFixed(3),
    aboveMa50: ma50 === null ? null : last > ma50,
    aboveMa200: ma200 === null ? null : last > ma200,
    rsi14: rsiLast(cl) === null ? null : +rsiLast(cl).toFixed(0),
    pos52: +(((last - lo) / (hi - lo)) * 100).toFixed(0),
    hi52: +hi.toFixed(3),
    lo52: +lo.toFixed(3),
    distHi: +((last / hi - 1) * 100).toFixed(1),
    dif: +dif[n - 1].toFixed(4),
    dea: +dea[n - 1].toFixed(4),
    bull: dif[n - 1] > dea[n - 1],
    aboveZero: dif[n - 1] > 0,
    crossType,
    crossDate: crossIdx >= 0 ? rows[crossIdx].d : null,
    crossAgo: crossIdx >= 0 ? n - 1 - crossIdx : null,
  };
  if (rows[n - 1].d > asOf) asOf = rows[n - 1].d;
  const o = out[it.code];
  console.log("  " + it.code + " " + String(it.name).padEnd(14) + " 收 " + o.px + "（" + o.pxDate + "）"
    + " · MA200 " + (o.aboveMa200 ? "上" : "下") + " MA50 " + (o.aboveMa50 ? "上" : "下")
    + " · RSI " + o.rsi14 + " · 位置 " + o.pos52 + "%"
    + " · MACD " + (o.bull ? "多头" : "空头"));
}

if (!Object.keys(out).length) { console.warn("一只都没拿到，放弃写盘"); process.exit(0); }

const block = "const TREND = " + JSON.stringify({
  asOf,
  note: "场内标的的技术面读数（东财日线 fqt=1）：均线 / RSI14（简单窗口）/ 52 周位置 / MACD(12,26,9)。"
    + "MACD 与 RSI 只作观察、不进任何决策。由 scripts/build-trend.mjs 生成。",
  items: out,
}, null, 2) + ";";

const re = /^const TREND = \{[\s\S]*?^\};/m;
const prev = src.match(re);
if (prev) {
  if (prev[0] === block) { console.log("\nTREND 无变化，跳过写盘"); process.exit(0); }
  writeFileSync(DATA, src.replace(prev[0], () => block));
} else {
  /* 首次：放在 SELL_AFTER 原来的位置（若还有），否则放 CLOSED 之前 */
  const oldSA = src.match(/^const SELL_AFTER = \{[\s\S]*?^\};\n\n/m);
  const anchor = src.match(/^const CLOSED = \{/m);
  if (oldSA) writeFileSync(DATA, src.replace(oldSA[0], block + "\n\n"));
  else if (anchor) writeFileSync(DATA, src.slice(0, anchor.index) + block + "\n\n" + src.slice(anchor.index));
  else throw new Error("找不到插入锚点");
}
console.log("\n✓ TREND 已写入：" + Object.keys(out).length + " 只，asOf " + asOf);
