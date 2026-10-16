#!/usr/bin/env node
/* 截图录入器（2026-09-23 加）：把「一张截图里读到的数字」一次性写进数据文件，
   自动推导所有能推导的量、自动生成注释里的合计、跑门禁、失败自动回滚。

   为什么需要（2026-09-23 实操复盘）：那一天是
     · 145 个手输数字（场外 8×7 + 快照 13×4 + 溢价 5×4 + 合计/ACCT_STATS）
     · 20 次定点文本替换，其中 1 次锚点失配（上一次编辑在同一行插了注释）→ 重新读文件再来
     · 摩根 20:26 才到 → 合计与注释里的数字要跟着改 4 处（注释里的数字**没有任何门禁能校验**）
   本脚本把这四类成本压掉：数字只出现在输入 JSON 里一处，其余全部推导；改动全部定点替换，保留既有注释。

   用法：
     node scripts/apply-screenshot.mjs day.json            干跑：只打印将要做哪些改动
     node scripts/apply-screenshot.mjs day.json --write    落盘 + 跑门禁（不通过自动回滚）
     node scripts/apply-screenshot.mjs day.json --write --allow-partial   允许场外只更新一部分

   输入（只写「读了什么」，不写任何能算出来的东西）：
   {
     "date": "2026-09-24",                       // 快照日 = 场内报价日
     "cash": 0,                                  // 各渠道可用资金合计
     "otc": [ { "code": "021000", "value": 24096.85, "pnl": 896.85, "day": 36.60, "qty": 9996.56,
                "upd": "2026-09-24 20:12", "navClose": 2.4103, "navDate": "2026-09-23" } ],
     "etf": { "etfNdx": { "close": 1.712, "chg": 0.42 }, "etfSpx": 2.030, "kr": 4.900, "n225": 2.150, "hkus": 1.990 },
     "hold": [ { "code": "159941", "qty": 82100, "cost": 1.5921 } ],     // 份数/成本变了才写（App 读数）
     "trades": [ { "d": "2026-09-24", "act": "买入", "sym": "纳指ETF广发", "qty": 1000, "cost": 1.700,
                   "realized": null, "note": "平安证券 09-24 成交…" } ],
     "pending": [ { "code": "021000", "amount": 400 } ],                 // 在途（市值已含、份额未含）；⚠ rate 的分母要用它
     "acct": { "updated": "2026-09-24", "pnl": 3500.00, "pnlPct": -9.80,
               // ↓ 2026-10-16 扩：这些原先全靠手工 replace_in_file（一期 8 处），现在一处搬完 ✓
               "trades": 64, "fees": 322.05,          // 同一行，要给全
               "win": 2, "loss": 3,                   // 同一行，要给全
               "avgPos": 96.51, "holdDays": 93, "benchYtd": -5.63,
               "monthly": { "m": "10月", "pnl": -3619.00, "pct": -0.95, "bench": -2.67 } },   // 当月行三个数给全
     "day": 1234.56,                             // 可选：当日盈亏（不填则用「场内 Δ市值−Δ成本 + Σ场外 day」推）
     "note": "当日事件说明（可选，附在快照注释里）"
     }
     `etf` 的值可写成数字（close，chg 由文件里的旧 close 推）或 { close, chg }（chg 由 App 读取，
     复跑/补录时用它才能保持幂等 —— 只有数字时 chg 会被推成 0）。

     推导并写入：rate = pnl ÷ (**value − pnl − 该只在途**)〔2026-10-16 起：App 的分母是不含在途的确认成本，
     旧式 value − pnl 会让每期都差一截、得手工订正 3~4 格〕；DEFAULT 的 chg / priceDate / ath / low52；
     快照 items（场内 val = close×份数、cost = 成本价×份数；场外取 App 读数）、pl = Σ、
     day、flow = ΔΣ成本 + Δ现金，以及注释里的全部合计文字。

     两条硬规则（对应 2026-09-23 踩过的两个坑）：
     · 场外没凑齐（少于全部只数）且没加 --allow-partial → 拒绝写快照（否则旧值会被冻进历史）
     · 快照日必须晚于最新一期（历史不许改）
     ⚠ 仍需人工补的：**只剩** AUTO 的 premiums（见 handoff.md SOP 第 6 步）
     —— ACCT_STATS 的全部字段（含 monthly[当月]）2026-10-16 起由本脚本的 `acct` 一处写入 ✓。 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { readModel } from "./data-quality.mjs";

const argv = process.argv.slice(2);
const inputPath = argv.find((a) => !a.startsWith("--"));
const WRITE = argv.includes("--write");
const ALLOW_PARTIAL = argv.includes("--allow-partial");
if (!inputPath) {
  console.error("用法：node scripts/apply-screenshot.mjs <day.json> [--write] [--allow-partial]");
  process.exit(2);
}
const ROOT = new URL("../", import.meta.url);
/* ⚠ 2026-09-27 起持仓页的 MANUAL 数据（OTC / OTC_LOG / SNAPSHOTS）在 positions-data.js ——
   本脚本改的全在这三块里（OTC.updated / cash / funds、SNAPSHOTS 追加期间区块），
   故读写都指向数据文件；positions.html 本身不再被本脚本改。 */
const DATA_PATH = new URL("data.js", ROOT), POSDATA_PATH = new URL("positions-data.js", ROOT);
const ETF_KEYS = { etfNdx: "ndx", etfSpx: "spx", kr: "kr", n225: "n225", hkus: "hkus" };
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/* ---------- 读输入 + 校验 ---------- */
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const errors = [];
if (!isDate(input.date)) errors.push("date 缺失或格式不对");
if (!Number.isFinite(input.cash)) errors.push("cash 缺失（各渠道可用资金合计）");
if (!input.otc?.length) errors.push("otc 为空（至少要有一只场外读数）");
for (const f of input.otc || []) {
  if (!/^\d{6}$/.test(f.code || "")) errors.push("otc.code 非法：" + f.code);
  for (const k of ["value", "pnl", "day", "qty"]) if (!Number.isFinite(f[k])) errors.push(f.code + " 缺 " + k);
  if (!Number.isFinite(f.navClose) || !isDate(f.navDate)) errors.push(f.code + " 缺 navClose/navDate");
  /* upd 必须**不早于**本期快照日：页面按它判「已同步」，日期早了就会显示「N 只未更新」、
     并把该只的当日收益从合计里剔除（2026-09-23 自检时正是这样被 dom-check 抓到的 —— 沿用上期 upd 即翻车）。
     ⚠ 2026-10-16 放宽（本脚本此前要求 `startsWith(input.date)`，比页面严 ✗ 且与「不伪造时间戳」冲突）：
       · 页面 2026-09-25 起就是 `f.upd.slice(0,10) >= OTC.updated` 即算本期（positions.html 的 syncBadge / syncCnt，
         原话「晚于快照日的属**补录**，不该标成『待更』」）—— 脚本没跟上，导致**跨零点截图**必被拒 ✗；
       · 实测场景：10-15 那期的 8 张截图是 **10-16 02:34~11:14** 拍的（晚间没拍、第二天凌晨补拍是常态）。
         此时唯一诚实的写法就是记真实时刻，而写 `2026-10-15 20:00` 属伪造时间戳 ✗（handoff 底线）。
       → 判据与页面统一为「upd ≥ 快照日」，晚于快照日的原样记真、不假装成当天。 */
  if (!f.upd) f.upd = input.date + " 20:00";
  else if (String(f.upd).slice(0, 10) < input.date)
    errors.push(f.code + " 的 upd（" + f.upd + "）早于本期 " + input.date + "：页面会当它没更新，当日合计会少算这一只");
}
for (const [k, e] of Object.entries(input.etf || {})) {
  if (!(k in ETF_KEYS)) errors.push("etf 多出未知键：" + k);
  const close = typeof e === "object" ? e.close : e;
  if (!Number.isFinite(close)) errors.push("etf." + k + " 的 close 非法");
}
for (const k of Object.keys(ETF_KEYS)) if (!(k in (input.etf || {}))) errors.push("etf 缺 " + k);
for (const e of input.trades || []) {
  if (!isDate(e.d)) errors.push("trade 缺 d");
  if (!Number.isInteger(e.qty) || !Number.isFinite(e.cost)) errors.push("trade 缺 qty/cost");
  if (/卖出|减仓|清仓/.test(String(e.act)) && !Number.isFinite(e.realized)) errors.push("卖出行 " + e.d + " " + e.act + " 必须带 realized（门禁强制）");
}
const dataSrc0 = readFileSync(DATA_PATH, "utf8"), posSrc0 = readFileSync(POSDATA_PATH, "utf8");
const model = readModel(dataSrc0);
const evalBlock = (src, re, expr) => {
  const m = src.match(re);
  if (!m) throw new Error("找不到块：" + expr);
  const ctx = vm.createContext({});
  vm.runInContext(m[0] + "\nthis.x = " + expr + ";", ctx, { timeout: 500 });
  return ctx.x;
};
const otcNow = evalBlock(posSrc0, /^const OTC = \{[\s\S]*?^\};/m, "OTC");
const rows = evalBlock(posSrc0, /^const SNAPSHOTS = \[[\s\S]*?^\];/m, "SNAPSHOTS");
const last = rows.filter((r) => r.items).at(-1);
if (!last) errors.push("没有可参照的上一期完整快照");
else if (input.date <= rows.at(-1).d) errors.push("date " + input.date + " 不晚于最新快照 " + rows.at(-1).d + "（历史不许改）");
const missing = (otcNow.funds || []).filter((f) => !input.otc.some((x) => x.code === f.code));
if (missing.length && !ALLOW_PARTIAL) errors.push("场外只给了 " + input.otc.length + "/" + otcNow.funds.length + " 只（缺 " + missing.map((f) => f.code).join("/") + "）：未凑齐不写快照，否则旧值会被冻进历史；确实要写就加 --allow-partial");
if (errors.length) { console.error("输入有问题：\n" + errors.map((s) => "  - " + s).join("\n")); process.exit(1); }

/* ---------- 推导 ---------- */
const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100, r3 = (x) => Math.round(x * 1000) / 1000;
const num = (v, dp = 2) => { const s = (+v).toFixed(dp); return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s; };
/* 定长小数（不抹尾零）：只给 **ACCT_STATS** 那几个字段用 —— data.js 里它们是**人读的**固定两位
   （`pnl: 3166.40` / `fees: 287.05` / `pct: 6.50`），用 num 会把 `-3619.00` 写成 `-3619` ✗
   制造无意义的 diff（快照 items 那边相反，历来就是抹零的 `val: 179190` ✓，别混）。 */
const numF = (v, dp = 2) => (+v).toFixed(dp);
const holdByCode = (code) => model.POSITIONS.hold.find((p) => p.code === code);
const holdByIdx = (idx) => model.POSITIONS.hold.find((p) => p.idx === idx);
const nextHold = (code) => { const p = holdByCode(code); const u = (input.hold || []).find((h) => h.code === code); return u ? { ...p, qty: u.qty, cost: u.cost, idxAtCost: u.cost } : p; };
const prev = last.items;
const pv = (c) => (prev[c] ? prev[c].val : 0), pc = (c) => (prev[c] ? prev[c].cost : 0);

const items = {}; const tips = [];
const holdCodes = new Set(model.POSITIONS.hold.map((p) => p.code));
let dCost = 0, dVal = 0;
/* 场内**单独**一对累计量（2026-10-16 加，修 day 的双计 bug）：
   dCost/dVal 是**全场**（场内 ＋ 场外），flow 要用它（ΔΣ成本 ＋ Δ现金）；
   而 dayIn 的定义是「场内 Δ市值 − Δ成本」，场外那半由 Σ(场外 day) 单独承担 ✓。
   原先二者共用 dCost/dVal → day = (dVal−dCost) + ΣdayOtc 把场外算了**两遍** ✗。 */
let dCostIn = 0, dValIn = 0;
for (const [key, idx] of Object.entries(ETF_KEYS)) {
  const hp = holdByIdx(idx);
  /* 2026-10-09 加：该场内标的**已清仓**（不再在 POSITIONS.hold 里）→ 跳过，不进本期 items。
     为什么必须跳过：页面「快照对比」正是靠「上期有、本期没有」判**清仓**（tag: "close"）✓。
     ⚠ 原实现是 `nextHold(holdByIdx(idx).code)` —— 清仓后 holdByIdx 返回 undefined，
       直接取 .code 会 **TypeError 崩掉整个脚本** ✗（2026-10-09 清仓中韩/港美时实测踩到）。 */
  if (!hp) { tips.push(idx + "（" + key + "）已不在 POSITIONS.hold 里 → 本期不进 items（页面据此显示「清仓」✓）"); continue; }
  const p = nextHold(hp.code);
  const close = typeof input.etf[key] === "object" ? input.etf[key].close : input.etf[key];
  const cost = r2(p.qty * p.cost), val = r2(p.qty * close);
  items[p.code] = { name: p.sym, qty: p.qty, cost, val, pl: r2(val - cost) };
  dCost += cost - pc(p.code); dVal += val - pv(p.code);
  dCostIn += cost - pc(p.code); dValIn += val - pv(p.code);
  if (!prev[p.code]) tips.push(p.code + " 是本期新建仓，其 Δ 会计入当日（当日会偏大，需人工核对）");
}
for (const f of input.otc) {
  const known = otcNow.funds.find((x) => x.code === f.code);
  const name = (prev[f.code] || {}).name || String(known.name).replace(/[（(].*$/, "").slice(0, 8);
  if (!(prev[f.code] || {}).name) tips.push("快照短名 " + f.code + " 由基金名截取（上一期快照没有它，建议核对）");
  const cost = r2(f.value - f.pnl);
  items[f.code] = { name, qty: f.qty, cost, val: r2(f.value), pl: r2(f.pnl) };
  dCost += cost - pc(f.code); dVal += r2(f.value) - pv(f.code);
}
/* 2026-10-09 加（配合 --allow-partial）：本期**没给读数**的场外，沿用上一期快照的 items（份额/成本/市值/收益全同）。
   为什么非加不可：不分批时，缺的几只**不在 items 里** → 页面把它们读成**清仓** ✗✗（比"沿用"严重得多）。
   沿用后的诚实性由 OTC.funds[].upd 承担：那几只的 upd 仍是上一期 → 页面显示「N 只未更新」✓、净值日也不动 ✓。
   ⚠ 场内已清仓的标的不在此列（它们**本来就不该**进 items）—— 靠 otcNow.funds 里有没有这个 code 区分 ✓ */
if (ALLOW_PARTIAL) {
  for (const code of Object.keys(prev)) {
    if (items[code]) continue;
    if (!otcNow.funds.some((x) => x.code === code)) continue;      // 场内的清仓标的：正确地不进 items ✓
    items[code] = { ...prev[code] };
    dCost += (prev[code].cost || 0) - pc(code);
    dVal += (prev[code].val || 0) - pv(code);
    tips.push(code + "（" + (prev[code].name || "") + "）本期未给读数 → **沿用上一期快照**，页面会标「未更新」✓");
  }
}
const sumBy = (pick, field) => r2(Object.entries(items).filter(([c]) => pick(c)).reduce((a, [, it]) => a + it[field], 0));
const pl = sumBy(() => true, "pl");
const dayOtc = r2(input.otc.reduce((a, f) => a + f.day, 0));
/* dayIn 取**场内**那一半（dCostIn/dValIn），不加场外的 —— 场外由 dayOtc 承担 ✓。
   ⚠ 2026-10-16 修：此前写成 r2(dVal - dCost)（全场），于是 10-15 期算出 day −14,537.99（＝ −12,444.75 − 2,093.25）
     —— 场外被算了**两遍** ✗。历史各期都显式传了 day，所以一直没暴露 ✗；注释本来写的就是「场内 Δ市值−Δ成本」✗→✓。 */
const dayIn = r2(dValIn - dCostIn);
const day = Number.isFinite(input.day) ? r2(input.day) : r2(dayIn + dayOtc);
const dCash = r2(input.cash - last.cash);
/* 2026-10-09 加：流入口径的**例外**与显式覆盖。
   既有公式 flow ＝ ΔΣ持仓成本 ＋ Δ现金 只在「没有清仓」时成立 ✓（每期 note 都这么写的）。
   ⚠ 一旦有标的**清仓**，该标的的成本从 Σ 里整块消失、而卖出回款进了现金 →
     公式凭空多出一大笔（2026-10-09 清掉中韩 82,372.10 ＋ 港美 9,306.10 时实测多算 73,391.20 ✗，
     真实 flow 是 0 —— 当天只有账户内买卖）。
   → 有清仓时**必须**在输入里显式给 flow；缺省则告警（不静默给一个错数 ✗）。
     显式 flow 的口径取**总资产恒等式**：flow ＝ Δ总资产 − day ＋ 当日费用（本项目一贯用它自检）。 */
const clearedIn = Object.keys(prev).filter((c) => !items[c] && !otcNow.funds.some((x) => x.code === c));
const flow = Number.isFinite(input.flow) ? r2(input.flow) : r2(dCost + dCash);
if (clearedIn.length && !Number.isFinite(input.flow))
  tips.push("⚠ 本期有**清仓**（" + clearedIn.join("/") + "）：ΔΣ成本＋Δ现金 的公式此时不成立 ✗ → 请在输入里显式给 flow（＝Δ总资产 − day ＋ 费用）");
else if (clearedIn.length) tips.push("清仓 " + clearedIn.join("/") + " → flow 取输入显式值 " + num(flow, 2) + "（总资产恒等式：Δ总资产 − day ＋ 费用 ✓）");
const totalVal = sumBy(() => true, "val");
const inVal = sumBy((c) => holdCodes.has(c), "val"), otcVal = sumBy((c) => !holdCodes.has(c), "val");

/* ---------- 改文本（全部定点替换，保留既有注释） ---------- */
const changes = [];
let hardFail = false;
/* 定点替换。两个坑（2026-09-23 干跑抓到）：
   ① 替换串里要用 $1/$2 回填捕获组 → 必须走**字符串式** replace；用 () => repl 会把 $1 原样写进文件。
   ② 判定「有没有变化」要比较替换**后**的整串，不能拿匹配到的片段和替换串比（$1 未展开，永远不相等）。 */
const sub1 = (src, re, repl, label) => {
  const m = src.match(re);
  if (!m) { changes.push("✗ 找不到锚点：" + label); hardFail = true; return src; }
  const out = src.replace(re, repl);
  if (out === src) return src;
  /* 标签里把 $1/$2 展开成真实文本，否则读起来是 `→ $12026-09-24$2`，看不出改成了什么 */
  const shown = repl.replace(/\$(\d)/g, (_, i) => (m[+i] === undefined ? "" : m[+i]));
  changes.push("· " + label + "：" + m[0].trim().replace(/\s+/g, " ").slice(0, 70) + " → " + shown.trim().replace(/\s+/g, " ").slice(0, 70));
  return out;
};
let dataSrc = dataSrc0, posSrc = posSrc0;
/* DEFAULT：五只场内报价。chg 优先用输入给的（App 读到的），否则由文件里的旧 close 推。
   ⚠ 键与 `{` 之间是对齐空格（`kr:   { close: …`），所以用 \s* 而不是一个空格 —— 初版写死一个空格，
     etfNdx/etfSpx（单个空格）能匹配、kr/n225/hkus（三个空格）整条找不到锚点。 */
for (const key of Object.keys(ETF_KEYS)) {
  /* 2026-10-09 加：**已清仓**的场内标的不再写 DEFAULT 报价 —— 我们手上没有它当日的真实成交价，
     照输入写就会把 priceDate 盖成今天（**伪造时间戳** ✗，与「不允许静默降级 / 不伪造读数」同一底线）。
     它的报价留给 CI 的定时任务按行情源刷新 ✓（清仓标的不再参与持仓页计算，晚一天无害 ✓）。 */
  if (!holdByIdx(ETF_KEYS[key])) { tips.push(key + " 已清仓 → 不写 DEFAULT 报价（priceDate 保持原值，等 CI 刷）"); continue; }
  const close = typeof input.etf[key] === "object" ? input.etf[key].close : input.etf[key];
  const given = typeof input.etf[key] === "object" ? input.etf[key].chg : undefined;
  const chg = Number.isFinite(given) ? r3(given) : r3((close / model.DEFAULT[key].close - 1) * 100);
  dataSrc = sub1(dataSrc, new RegExp("(" + key + ":\\s*\\{ close: )[-0-9.]+(, chg: )[-0-9.]+", "m"),
    "$1" + num(close, 3) + "$2" + num(chg, 3), key + " close/chg");
  dataSrc = sub1(dataSrc, new RegExp("(" + key + ":\\s*\\{[^\\n]*priceDate: \")[\\d-]+(\")", "m"), "$1" + input.date + "$2", key + " priceDate");
  if (close > model.DEFAULT[key].ath) {
    dataSrc = sub1(dataSrc, new RegExp("(" + key + ":\\s*\\{[^\\n]*ath: )[-0-9.]+", "m"), "$1" + num(close, 3), key + " ath（创新高）");
    dataSrc = sub1(dataSrc, new RegExp("(" + key + ":\\s*\\{[^\\n]*athDate: \")[\\d-]+(\")", "m"), "$1" + input.date + "$2", key + " athDate");
  }
  if (close < model.DEFAULT[key].low52) dataSrc = sub1(dataSrc, new RegExp("(" + key + ":\\s*\\{[^\\n]*low52: )[-0-9.]+", "m"), "$1" + num(close, 3), key + " low52（创新低）");
}
/* 持仓份数/成本（cost 与 idxAtCost 必须一起改：门禁强制两者相等） */
for (const h of input.hold || []) {
  dataSrc = sub1(dataSrc, new RegExp("(code: \"" + h.code + "\"[^\\n]*?qty: )\\d+", "m"), "$1" + h.qty, h.code + " qty");
  dataSrc = sub1(dataSrc, new RegExp("(code: \"" + h.code + "\"[^\\n]*?cost: )[-0-9.]+(, idxAtCost: )[-0-9.]+", "m"),
    "$1" + num(h.cost, 10) + "$2" + num(h.cost, 10), h.code + " cost/idxAtCost");
}
/* 流水：插到 log: [ 之后（新的在最上面） */
if ((input.trades || []).length) {
  const lines = input.trades.map((e) => "    { d: \"" + e.d + "\", act: \"" + e.act + "\", sym: \"" + (e.sym || "") + "\", qty: " + e.qty +
    ", cost: " + num(e.cost, 3) + (Number.isFinite(e.realized) ? ", realized: " + num(e.realized, 2) : "") +
    (e.note ? ", note: \"" + String(e.note).replace(/"/g, "'") + "\"" : "") + " },").join("\n");
  dataSrc = sub1(dataSrc, /(^  log: \[\n)/m, "$1" + lines + "\n", "流水 " + input.trades.length + " 笔插到 log 顶部");
}
/* ACCT_STATS */
dataSrc = sub1(dataSrc, /(const ACCT_STATS = \{\n  updated: ")[\d-]+(")/m, "$1" + (input.acct?.updated || input.date) + "$2", "ACCT_STATS.updated");
/* ⚠ 2026-10-16 修：原实现对两个键都用行首锚点 `^  <k>: `，但 data.js 里 **pnlPct 与 pnl 同行**
   （`  pnl: 3166.40, pnlPct: -10.34,`）→ pnlPct 的行首锚点永远匹配不到 ✗，脚本报
   「✗ 找不到锚点：ACCT_STATS.pnlPct」并整体拒绝写盘 ✗（首次真的传 acct.pnl/pnlPct 时踩到 —— 此前各期
   只传 updated，所以一直没暴露）。改成：pnl 仍按行首锚，pnlPct 按 `pnlPct: ` 定位（data.js 里唯一，注释里的
   「pnlPct 是 …」不带冒号，不会误伤 ✓）。 */
if (Number.isFinite(input.acct?.pnl))
  dataSrc = sub1(dataSrc, /(^  pnl: )[-0-9.]+/m, "$1" + numF(input.acct.pnl, 2), "ACCT_STATS.pnl");
if (Number.isFinite(input.acct?.pnlPct))
  dataSrc = sub1(dataSrc, /(pnlPct: )[-0-9.]+/, "$1" + numF(input.acct.pnlPct, 2), "ACCT_STATS.pnlPct");
/* ACCT_STATS 的其余人工字段（**2026-10-16 扩**：此前只有 updated / pnl / pnlPct，
   于是每期都要为此手写 8 次 replace_in_file —— 对账单一行里的 trades/fees、win/loss 还得拆成两处，
   正是「漏改一处就静默漂」的高发区 ✗）。
   口径：全部是 App「对账单 · 今年」页的**原读数**，本脚本只搬数、不推导 ✓。
   取值要求：**同一行/同一行条目里的字段必须给全**（给一半会静默保留另一半的旧值 → 又是那个坑 ✗）→ 缺就报错，
   宁可拒绝写盘，也不留半新半旧 ✗。 */
const A = input.acct || {};
if (Number.isFinite(A.trades) || Number.isFinite(A.fees)) {
  if (![A.trades, A.fees].every(Number.isFinite)) { changes.push("✗ acct.trades / acct.fees 要给全（同一行）"); hardFail = true; }
  else dataSrc = sub1(dataSrc, /(^  trades: )[-0-9.]+(, fees: )[-0-9.]+/m,
    "$1" + num(A.trades, 0) + "$2" + numF(A.fees, 2), "ACCT_STATS.trades/fees");
}
if (Number.isFinite(A.win) || Number.isFinite(A.loss)) {
  if (![A.win, A.loss].every(Number.isFinite)) { changes.push("✗ acct.win / acct.loss 要给全（同一行）"); hardFail = true; }
  else dataSrc = sub1(dataSrc, /(^  win: )[-0-9.]+(, loss: )[-0-9.]+/m,
    "$1" + num(A.win, 0) + "$2" + num(A.loss, 0), "ACCT_STATS.win/loss");
}
if (Number.isFinite(A.avgPos))
  dataSrc = sub1(dataSrc, /(^  avgPos: )[-0-9.]+/m, "$1" + numF(A.avgPos, 2), "ACCT_STATS.avgPos");
if (Number.isFinite(A.holdDays))
  dataSrc = sub1(dataSrc, /(^  holdDays: )[-0-9.]+/m, "$1" + num(A.holdDays, 0), "ACCT_STATS.holdDays");
if (Number.isFinite(A.benchYtd))
  dataSrc = sub1(dataSrc, /(^  benchYtd: )[-0-9.]+/m, "$1" + numF(A.benchYtd, 2), "ACCT_STATS.benchYtd");
/* 当月那一行（形如 `{ m: "10月", pnl: -3619.00, pct: -0.95, bench: -2.67 }`）——
   月份名由输入给（跨月时不必改脚本 ✓），三个数必须一并给全 ✓。 */
if (A.monthly && A.monthly.m) {
  const mm = A.monthly;
  if (![mm.pnl, mm.pct, mm.bench].every(Number.isFinite)) {
    changes.push("✗ acct.monthly 的 pnl / pct / bench 要给全（对账单一行三个数）"); hardFail = true;
  } else dataSrc = sub1(dataSrc, new RegExp("(\\{ m: \"" + mm.m + "\", pnl: )[-0-9.]+(, pct: )[-0-9.]+(, bench: )[-0-9.]+"),
    "$1" + numF(mm.pnl, 2) + "$2" + numF(mm.pct, 2) + "$3" + numF(mm.bench, 2), "ACCT_STATS.monthly[" + mm.m + "]");
}
/* OTC：updated / cash */
posSrc = sub1(posSrc, /(const OTC = \{\n  updated: ")[\d-]+(")/m, "$1" + input.date + "$2", "OTC.updated");
posSrc = sub1(posSrc, /(\n  cash: )[-0-9.]+/m, "$1" + num(input.cash, 2), "OTC.cash");
/* rate 的分母规则（**2026-10-16 内建**）：用**不含在途**的确认成本 ＝ value − pnl − 在途。
   为什么：App 与历史链条的分母都是「已确认份额的成本」，而在途（钱已扣、份额未确认）不算 ✓。
   旧实现用 value − pnl（＝本页含在途的成本）→ 对有在途的 021778 / 021000 / 040046 / 014978 会算小一截 ✗，
   于是**每期都要手工订正 3~4 格**（10-13/10-14/10-15 三期都手改过）✗ —— 现在按这条算，
   2026-10-15 那期**逐只 7/7 与 App 一致**（0.80 / 1.20 / 1.17 / −0.55 …）✓，手工订正可以退休 ✓。 */
const pendOf = (code) => (input.pending || []).filter((p) => p.code === code)
  .reduce((a, p) => a + (Number.isFinite(p.amount) ? p.amount : 0), 0);
const rateOf = (f) => { const c = f.value - f.pnl - pendOf(f.code); return (c ? r2((f.pnl / c) * 100) : 0).toFixed(2); };
/* OTC：逐只场外（从 code: 起到下一条之前；只动字段值，注释一行不碰） */
for (const f of input.otc) {
  const at = posSrc.indexOf('code: "' + f.code + '"');
  if (at < 0) { changes.push("✗ OTC.funds 里找不到 " + f.code); hardFail = true; continue; }
  const nextEntry = posSrc.indexOf("\n    { name: ", at);
  const arrEnd = posSrc.indexOf("\n  ],", at);
  const end = nextEntry < 0 || (arrEnd >= 0 && arrEnd < nextEntry) ? arrEnd : nextEntry;
  const seg = posSrc.slice(at, end);
  const before = seg;
  const out = seg
    .replace(/(\bvalue: )[-0-9.]+/, "$1" + num(f.value, 2))
    .replace(/(\bday: )(null|[-0-9.]+)/, "$1" + num(f.day, 2))
    .replace(/(\bpnl: )[-0-9.]+/, "$1" + num(f.pnl, 2))
    .replace(/(\brate: )[-0-9.]+/, "$1" + rateOf(f))
    .replace(/(\bupd: ")[^"]*(")/, "$1" + (f.upd || input.date + " 20:00") + "$2")
    .replace(/(nav: \{ close: )[-0-9.]+/, "$1" + num(f.navClose, 4))
    .replace(/(nav: \{ close: [-0-9.]+, closeDate: ")[\d-]+(")/, "$1" + f.navDate + "$2");
  if (out !== before) changes.push("· OTC " + f.code + "：value " + num(f.value, 2) + " / day " + num(f.day, 2) + " / pnl " + num(f.pnl, 2) +
    " / rate " + rateOf(f) + " / upd " + (f.upd || input.date + " 20:00") + " / nav " + num(f.navClose, 4) + "@" + f.navDate);
  posSrc = posSrc.slice(0, at) + out + posSrc.slice(at + seg.length);
}
/* 快照：追加一期（含自动生成的注释合计） */
const noteHead = "⚠ 本页" + (missing.length ? "仅 " + input.otc.length + "/" + otcNow.funds.length + " 只（其余沿用旧值）" : input.otc.length + "/" + otcNow.funds.length + " 全覆盖") +
  "；总资产 " + num(r2(totalVal + input.cash), 2) + " = 场内 " + num(inVal, 2) + " + 场外 " + num(otcVal, 2) + " + 现金 " + num(input.cash, 2) +
  "；累计浮盈亏 " + num(pl, 2) + "；当日 " + num(day, 2) + "（场内 " + num(dayIn, 2) + " + 场外 " + num(dayOtc, 2) + "）" +
  "；flow " + num(flow, 2) + " = Δ成本 " + num(dCost, 2) + " + Δ现金 " + num(dCash, 2) +
  ((input.pending || []).length ? "；在途 " + input.pending.map((p) => p.code + " " + p.amount).join("、") + "（市值已含、份额未含）" : "");
const period = "  { d: \"" + input.date + "\", cash: " + num(input.cash, 2) + ", pl: " + num(pl, 2) +
  ", day: " + num(day, 2) + ", flow: " + num(flow, 2) + ",\n" +
  "    /* " + [noteHead, input.note].filter(Boolean).join("。") + " */\n" +
  "    items: {\n" + Object.entries(items).map(([c, it]) =>
    "        " + JSON.stringify(c) + ": { name: " + JSON.stringify(it.name) + ", qty: " + num(it.qty, 2) + ", cost: " + num(it.cost, 2) +
    ", val: " + num(it.val, 2) + ", pl: " + num(it.pl, 2) + " },").join("\n") + "\n    } },\n";
{
  const block = posSrc.match(/^const SNAPSHOTS = \[[\s\S]*?^\];/m);
  if (!block) { changes.push("✗ 找不到 SNAPSHOTS 块"); hardFail = true; }
  else {
    const at = block[0].lastIndexOf("\n];");
    posSrc = posSrc.replace(block[0], () => block[0].slice(0, at) + "\n" + period + block[0].slice(at + 1));
    changes.push("· SNAPSHOTS 追加 " + input.date + " 期（items " + Object.keys(items).length + " 只 · pl " + num(pl, 2) + " · day " + num(day, 2) + " · flow " + num(flow, 2) + "）");
  }
}
for (const t of tips) changes.push("· 提示：" + t);

/* ---------- 输出 ---------- */
console.log("【" + (WRITE ? "落盘" : "干跑") + "】" + input.date + "  ｜ 场外 " + input.otc.length + "/" + otcNow.funds.length + " 只 ｜ 流水 " + (input.trades || []).length + " 笔 ｜ 改动 " + changes.filter((c) => c.startsWith("· ")).length + " 处");
for (const c of changes) console.log("  " + c);
if (hardFail) { console.error("\n✗ 有锚点没找到 → 未写盘。请检查对应字段是否被改过名/删过。"); process.exit(1); }
if (!WRITE) { console.log("\n（干跑：未写盘。确认无误后加 --write 落盘并跑门禁）"); process.exit(0); }

const backup = { data: dataSrc0, pos: posSrc0 };
writeFileSync(DATA_PATH, dataSrc); writeFileSync(POSDATA_PATH, posSrc);
const tryRun = (file, args) => { try { execFileSync("node", [file, ...args], { stdio: "pipe" }); return null; } catch (e) { return String(e.stdout || "") + String(e.stderr || ""); } };
/* ⚠ 2026-10-16 修「失败信息读不出来」：原来按**行内是否含 ✗**筛失败行 ——
   但这个项目的断言描述里**一半本身就带 ✗**（例如「…不再重述来源与推导 ✗」是一条**通过**的断言）✗，
   于是前 6 行全被这类 ✓ 行占满、真正的失败被挤出 slice(0,6) ✗✗。实测为此要把整份仓库复制到别处、
   再把 tryRun 改成 return null 跳过内建门禁，才能看到是哪条失败 —— 排查成本全花在工具上 ✗。
   → 改为判**状态前缀**（`^\s*✗`），并把门禁的**完整** stdout 落盘到 outputs/gate-*.log（该目录已被 .gitignore ✓），
     失败信息里给出绝对路径，需要上下文时直接看日志 ✓。 */
const GATE_LOG_DIR = new URL("../outputs/", import.meta.url);
const runGate = (file, label) => {
  const out = tryRun(file, []);
  if (!out) return null;
  let logPath = "";
  try {
    mkdirSync(GATE_LOG_DIR, { recursive: true });
    const p = new URL("gate-" + label + ".log", GATE_LOG_DIR);
    writeFileSync(p, out);
    logPath = fileURLToPath(p);
  } catch { /* 日志落盘失败不影响主流程（门禁结论不依赖它） */ }
  /* 三种格式都要能读出来（实测：dom-check 用「✗ 描述」，check-data 用「- 描述」＋一行英文总结 ✗） */
  const lines = out.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  const marked = lines.filter((l) => /^\s*✗/.test(l));
  const bullets = lines.filter((l) => /^\s*[-·]\s+\S/.test(l));
  const head = marked.length ? marked.slice(0, 8)
    : (bullets.length ? [lines[0]].concat(bullets.slice(0, 7)) : lines.slice(-8));
  return "  " + label + "：\n" +
    head.map((l) => (l.startsWith("  ") ? l : "    " + l)).join("\n") +
    (logPath ? "\n    完整输出：" + logPath : "");
};
const bad = [];
const g1 = runGate("scripts/check-data.mjs", "check-data"); if (g1) bad.push(g1);
const g2 = runGate("scripts/dom-check.mjs", "dom-check"); if (g2) bad.push(g2);
if (bad.length) {
  writeFileSync(DATA_PATH, backup.data); writeFileSync(POSDATA_PATH, backup.pos);
  console.error("\n✗ 门禁未通过 → 已回滚（两个文件均已还原）：\n" + bad.join("\n"));
  process.exit(1);
}
console.log("\n✓ 已落盘，门禁通过（check-data 含交叉一致性 ✓ · dom-check ✓）");
/* ⚠ 2026-10-16：ACCT_STATS 的全部字段（含 monthly[当月]）已能由本脚本的 acct 写入 → 从「仍需人工」里摘掉 ✓，
   只留 premiums（它的净值要连网抓，见 handoff.md SOP 第 6 步）。 */
console.log("  ⚠ 仍需人工的只剩：AUTO 的 premiums（需当日各 ETF 单位净值，见 handoff.md SOP 第 6 步）");
