#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
   「已清仓标的后市」数据（scripts/build-sell-after.mjs）
   回答一个只有事后才能回答的问题：**我卖对了吗？**
   对每只已清仓的场内标的，抓它的日线，写进 data.js 的 SELL_AFTER：
     · px / pxDate     最新收盘（东财日线，fqt=1）
     · dif / dea / bull  MACD(12,26,9) 的当前状态（**只作观察，不进任何决策** ✗）
     · crossType / crossDate / crossAgo  最后一次交叉（金叉 gold / 死叉 death）与距今天数

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
/* ⚠ 场内已清仓的标的在 **HOLD_HIST.items**（带 closed:true / closedDate / realized），
   不在 CLOSED.items —— 后者是**场外**已清仓的基金（债基那批）✗ 两个块容易混，写清楚。 */
vm.runInContext(src + "\nthis.H=HOLD_HIST;", ctx, { timeout: 9000 });
const items = ((ctx.H && ctx.H.items) || []).filter((x) => x && x.code && x.closed);
if (!items.length) { console.log("没有已清仓的场内标的，跳过"); process.exit(0); }

const ema = (a, n) => { const k = 2 / (n + 1); let e = a[0]; return a.map((v, i) => (i ? (e = v * k + e * (1 - k)) : (e = v))); };
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

  const cl = rows.map((r) => r.c);
  const e12 = ema(cl, 12), e26 = ema(cl, 26);
  const dif = cl.map((_, i) => e12[i] - e26[i]);
  const dea = ema(dif, 9);
  const n = rows.length;
  let crossType = null, crossIdx = -1;
  for (let i = n - 1; i >= 1; i--) {
    if (dif[i] > dea[i] && dif[i - 1] <= dea[i - 1]) { crossType = "gold"; crossIdx = i; break; }
    if (dif[i] < dea[i] && dif[i - 1] >= dea[i - 1]) { crossType = "death"; crossIdx = i; break; }
  }
  out[it.code] = {
    name: it.name,
    px: +cl[n - 1].toFixed(3),
    pxDate: rows[n - 1].d,
    dif: +dif[n - 1].toFixed(4),
    dea: +dea[n - 1].toFixed(4),
    bull: dif[n - 1] > dea[n - 1],
    aboveZero: dif[n - 1] > 0,
    crossType,
    crossDate: crossIdx >= 0 ? rows[crossIdx].d : null,
    crossAgo: crossIdx >= 0 ? n - 1 - crossIdx : null,
  };
  if (rows[n - 1].d > asOf) asOf = rows[n - 1].d;
  console.log("  " + it.code + " " + it.name.padEnd(12) + " 收 " + out[it.code].px + "（" + rows[n - 1].d + "）"
    + " MACD " + (out[it.code].bull ? "多头" : "空头") + " · 上次" + (crossType === "gold" ? "金叉" : "死叉")
    + " " + out[it.code].crossDate + "（" + out[it.code].crossAgo + " 日前）");
}

if (!Object.keys(out).length) { console.warn("一只都没拿到，放弃写盘"); process.exit(0); }

const block = "const SELL_AFTER = " + JSON.stringify({
  asOf,
  note: "已清仓场内标的的后市读数（东财日线 fqt=1）：px＝最新收盘；MACD(12,26,9) 只作观察、不进任何决策。由 scripts/build-sell-after.mjs 生成。",
  items: out,
}, null, 2) + ";";

const re = /^const SELL_AFTER = \{[\s\S]*?^\};/m;
const prev = src.match(re);
if (prev) {
  if (prev[0] === block) { console.log("\nSELL_AFTER 无变化，跳过写盘"); process.exit(0); }
  writeFileSync(DATA, src.replace(prev[0], () => block));
} else {
  const anchor = src.match(/^const CLOSED = \{/m);
  if (!anchor) throw new Error("找不到插入锚点 const CLOSED");
  writeFileSync(DATA, src.slice(0, anchor.index) + block + "\n\n" + src.slice(anchor.index));
}
console.log("\n✓ SELL_AFTER 已写入：" + Object.keys(out).length + " 只，asOf " + asOf);
