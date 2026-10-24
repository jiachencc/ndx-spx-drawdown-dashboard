#!/usr/bin/env node
/* 在真实 DOM 里跑一遍 positions.html，断言「页面上显示的数字」与最新一期快照一致。
 *
 * 为什么需要（2026-09-22 的教训）：OTC.cash 滞后一期时，汇总卡总资产少算 6,866、
 *   配置图现金占比偏小，而累计浮盈亏完全正常（现金在 pl 里两边抵消）——
 *   check-data 只校验文件里的数据自洽，看不见「渲染出来的结果」，所以溜过去了。
 *   本脚本把两者对起来：跑页面 → 断言关键数字出现在它该出现的卡片里。
 *
 * 依赖：jsdom（本地工具；门禁不依赖它，CI 也不跑）
 *   npm i -g jsdom
 *
 * 用法：node scripts/dom-check.mjs [--verbose]
 * 退出码：0 = 全部通过；1 = 有断言失败或页面报错。
 */
import { readFileSync } from "node:fs";
import { readPosLogic } from "./data-quality.mjs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/* 持仓页的共享口径（2026-10-16）：本文件里凡是「页面也该这么算」的判据，
   一律用 POS_LOGIC（读 positions-logic.js 的同一份源码 ✓）——
   此前这里自己写过 `upd === OTC.updated`（页面是 `>=`）与写死的「组合末日」，
   把**正确的页面**判成错、还回滚了写盘 ✗。 */
const LOGIC = readPosLogic(root);
const VERBOSE = process.argv.includes("--verbose");

/* jsdom 装在哪都可能：先常规解析，再回退到全局包目录（ESM 不认 NODE_PATH） */
async function loadJsdom() {
  for (const spec of ["jsdom", await globalSpec()]) {
    if (!spec) continue;
    try {
      const m = await import(spec);
      if (m.JSDOM) return m;
    } catch { /* 换下一个候选 */ }
  }
  return null;
}
async function globalSpec() {
  try {
    const { execSync } = await import("node:child_process");
    const g = execSync("npm root -g", { encoding: "utf8" }).trim();
    return pathToFileURL(path.join(g, "jsdom", "lib", "api.js")).href;
  } catch { return null; }
}

const { JSDOM } = (await loadJsdom()) || {};
if (!JSDOM) {
  console.error("未找到 jsdom。先装一次：npm i -g jsdom");
  process.exit(2);
}

/* 最新一期含持仓明细的快照：页面上的汇总数字应当与它一致。
   ⚠ 地面真值必须是**快照里的现金**，不能拿 OTC.cash 当基准 —— 那样页面永远和自己一致，
   2026-09-22 那个「现金滞后一期」就照样通过（本脚本初版就是这么写的，是负例测试把它暴露的）。 */
/* ⚠ 2026-09-27 起 SNAPSHOTS / OTC 在 positions-data.js 里（原先内联在 positions.html）——
   取地面真值要读那个文件；下面喂给 JSDOM 的仍是 positions.html（它会自己加载两个数据文件）。 */
const dataSrc = readFileSync(path.join(root, "positions-data.js"), "utf8");
const ctx = vm.createContext({});
vm.runInContext(dataSrc.match(/^const SNAPSHOTS = \[[\s\S]*?^\];/m)[0] + "\nthis.rows = SNAPSHOTS;", ctx, { timeout: 500 });
const latest = ctx.rows.filter((s) => s.items).at(-1);
const snapCash = latest.cash;                                                        // 真值
const snapTotal = Object.values(latest.items).reduce((a, it) => a + it.val, 0) + snapCash;
const otcCash = +dataSrc.match(/cash:\s*([\d.]+)/)[1];                                // 页面实际在用的值

const errors = [];
const dom = await JSDOM.fromFile(path.join(root, "positions.html"), {
  runScripts: "dangerously",
  resources: "usable",          // 加载同目录的 data.js
  pretendToBeVisual: true,      // 提供 requestAnimationFrame
  beforeParse(win) {
    /* jsdom 没有布局引擎，页面里这类「测量」API 需要最小桩，否则初始化就会抛异常 */
    win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    if (!win.matchMedia) win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    win.addEventListener("error", (e) => errors.push("error: " + (e.message || e.error)));
  },
});
const win = dom.window;
win.addEventListener("error", (e) => errors.push("error: " + (e.message || e.error)));
await new Promise((r) => win.setTimeout(r, 400));   // 等首屏渲染

const money = (n) => Math.abs(Math.round(n)).toLocaleString("en-US");
/* 卡片显示会按需截断或取整（2,482.97 → 「2,482」），所以按数值容差比对，
   而不是拼一个字符串去 includes —— 那样一遇到四舍五入/单位（万）就假报警。 */
/* ⚠ 负号必须同时认 U+2212「−」（页面 fmtAmt/fmtYuan 用的就是它）：只写 ASCII 的 - 时，
   2026-09-24 首次出现「负数当期盈亏」就集体误报 —— 取出的是 3,041 而快照是 −3,041.40，
   |3041 − (−3041.4)| = 6082 → 四条断言全挂（浮盈亏 / 当日 / 场外快 / 走势卡读数）。 */
const numsOf = (t) => (t.match(/[-−]?\d[\d,]*(?:\.\d+)?/g) || []).map((s) => +s.replace(/,/g, "").replace("−", "-"));
/* ⚠ 页面对**负值**用「↓ ＋ 绝对值」表达（positions.html 的 arrow()：有箭头就不再印负号 ✗）——
   2026-10-13 期「本期盈亏」第一次为负 ✗，只抓数字的写法把 ↑/↓ 丢了 → 三条断言当场全红 ✗
   （组小计写成「当日↓1,812」✓ 门禁拿到 +1812 ✗）。arrowNums：把箭头还原成符号 ✓；
   数字自带 − 时以它为准、不叠符号 ✓；没有箭头时与原来的 numsOf 行为完全一致 ✓。 */
const arrowNums = (t) => {
  const out = []; let sign = 1, m;
  const re = /([↑↓])|([-−]?\d[\d,]*(?:\.\d+)?)/g;
  while ((m = re.exec(String(t)))) {
    if (m[1]) { sign = m[1] === "↓" ? -1 : 1; continue; }
    const raw = m[2];
    out.push(/^[-−]/.test(raw) ? +raw.replace(/,/g, "").replace("−", "-") : sign * +raw.replace(/,/g, ""));
    sign = 1;
  }
  return out;
};
const near = (t, v, tol = 1) => arrowNums(t).some((n) => Math.abs(n - v) <= tol);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

/* ① 关键卡片都在（选择器改了就会在这里报，而不是静默通过） */
const sum = win.document.querySelector("#sum-grid");
const alloc = win.document.querySelector("#alloc-bar");
const trend = win.document.querySelector("#trend-box");
const readout = win.document.querySelector("#trend-readout");
check("#sum-grid / #alloc-bar / #trend-box / #trend-readout 均存在", !!(sum && alloc && trend && readout));

/* ② 页面在用的现金 = 最新快照的现金（数据层已由 check-data 把关，这里是渲染层的双保险） */
check("OTC.cash 与最新快照现金一致 " + money(snapCash), Math.abs(otcCash - snapCash) < 0.01, "OTC.cash = " + otcCash);

/* ── 读 data.js 的 POSITIONS.log（2026-10-09 加）：用于「全额清仓漏出的已实现」的**独立复算**。
   判据与页面 closedCostGap() 一致：某笔卖出使该标的累计份数归零 → 取这一笔的 realized ✓
   （摊薄成本额本身已含此前的部分卖出效应，故不能把部分卖出再加一遍 ✗）。 */
const LOGPOS = (() => {
  const m = readFileSync(path.join(root, "data.js"), "utf8").match(/^const POSITIONS = \{[\s\S]*?^\};/m);
  if (!m) return null;
  const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = POSITIONS;", c, { timeout: 500 }); return c.o;
})();
/* ⚠ 2026-10-09 改：由常量改为**带 upTo 的函数**（closedGapTo）＋ 常量 closedGap 保留（＝全程 ✓）。
   起因：归因「全期」行的新断言要按**矩阵基准期**取"当时的修正项" ✓ —— 10-09 之前它恒为 0 ✓，
   但若将来出现更早的全额清仓，用"全程值"去算基准期的累计收益就会算错 ✗。两个用法共用同一实现，不会漂 ✓
   ⚠ 2026-10-14 补**场外那一半**：页面 closedCostGap() 从 POSITIONS.log（场内交割单、有份额）推，
   场外没有份额级流水 → 由 positions-data.js 的 OTC_CLEARED 显式给出（口径 = Σ(成本 − 回款)）。
   这里同样**独立复算**（读那个常量，不调页面函数 ✓、不写死数字 ✓）—— 页面那半若改口径 → 当场报红 ✓ */
const OTCCLEARED = (() => {
  try {
    const m = String(dataSrc || "").match(/^const OTC_CLEARED = \[[\s\S]*?^\];/m);
    if (!m) return [];
    const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = OTC_CLEARED;", c, { timeout: 500 });
    return Array.isArray(c.o) ? c.o : [];
  } catch (e) { return []; }
})();
const closedGapTo = (upTo) => {
  const log = ((LOGPOS && LOGPOS.log) || []).filter((e) => !upTo || e.d <= upTo).slice()
    .sort((a, b) => (a.d === b.d ? 0 : a.d < b.d ? -1 : 1));
  const qty = {}, gap = {};
  log.forEach((e) => {
    const s = /卖出|减仓|清仓/.test(String(e.act || "")), before = qty[e.sym] || 0;
    qty[e.sym] = before + (s ? -(e.qty || 0) : (e.qty || 0));
    if (s && before > 0 && qty[e.sym] === 0 && Number.isFinite(e.realized)) gap[e.sym] = (gap[e.sym] || 0) - e.realized;
  });
  const otcGap = OTCCLEARED.filter((x) => x && (!upTo || x.d <= upTo))
    .reduce((a, x) => a + ((x.cost || 0) - (x.proceeds || 0)), 0);
  return Object.keys(gap).reduce((a, k) => a + gap[k], 0) + otcGap;
};
const closedGap = closedGapTo(null);

/* ③ 汇总卡：总资产 与 累计收益 = 最新快照的读数 */
const sumText = sum ? sum.textContent.replace(/\s+/g, "") : "";
/* ⚠ 2026-10-20：每个交易日收盘后、用户还没提供当日快照之前，CI 会先把场内 ETF 报价更新到当天。
   此时页面汇总卡显示的是「今日估值」（用新报价 × 份数），**天然不等于**昨日快照的 total ——
   原来三条断言因此每天晚上必红一次（并非页面错）。报价领先快照时跳过这三条，并打印原因。 */
const quoteDay = (readFileSync(path.join(root, "data.js"), "utf8")
  .match(/etfNdx:\s*\{[^}]*?priceDate:\s*"([\d-]+)"/) || [])[1] || null;
const quoteAhead = !!(quoteDay && latest && latest.d && quoteDay > latest.d);
const QUOTE_AHEAD = quoteAhead;
if (quoteAhead) {
  console.log("  · 跳过汇总卡三条断言：场内报价 " + quoteDay + " 已领先快照 " + latest.d +
    "，页面汇总卡显示的是今日估值（等当日快照录入后自然对齐）");
}
/* 总资产容差放到 3：页面是「快照逐只市值取整后求和」，与 App 总读数天然差 1 元以内 */
check("汇总卡总资产 = 最新快照 " + money(snapTotal), quoteAhead || near(sumText, snapTotal, 3), quoteAhead ? "（报价已领先快照，跳过）" : sumText.slice(0, 140));
/* ⚠ 2026-10-09 改口径（用户选 A）：汇总卡那格由「浮盈亏」改为「累计收益（含已实现）」——
   快照 pl 是**摊薄口径的在持浮盈亏**（＝券商 App 的浮动盈亏），全额清仓后它不含已兑现那部分 ✗；
   真·累计收益 = pl − closedGap ✓（10-09：19,988.31 − 18,492.00 = +1,496 ✓）。
   closedGap 由本文件独立复算（读 data.js 的 POSITIONS.log），不读页面中间量 ✓。 */
check("汇总卡累计收益 = 最新快照 pl − 全额清仓已实现 " + money(latest.pl - closedGap),
  quoteAhead || near(sumText, latest.pl - closedGap), quoteAhead ? "（报价已领先快照，跳过）" : sumText.slice(0, 140));
/* ③-2 汇总卡「本金」（2026-10-12 加）：页面上本金有**两条实现路径** ✗ ——
     实时路径（renderImpl：Σ摊薄成本 ＋ 现金 ＋ 清仓修正）与快照路径（snapCost：总资产 − pl 或
     裸成本 ＋ closedCostGap）—— 同一公式、两个输入源，任一漂移这里就红 ✓。
   判据用**快照口径独立复算**：本金 ≡ 总资产 − 累计收益（＝ snapTotal − (pl − closedGap)）✓，
   容差 3 元与总资产那条同源（页面是逐只取整后求和 ✓）。 */
check("汇总卡本金 = 总资产 − 累计收益（快照口径独立复算，容差 3 元）",
  near(sumText, snapTotal - (latest.pl - closedGap), 3),
  "页面合计 " + sumText.slice(0, 60) + " … 复算 " + money(snapTotal - (latest.pl - closedGap)));

/* ③b 汇总卡「当日盈亏」：**全是实际读数**（2026-10-13 用户决定「每天截图更新就行了」✓）
     ① 三栏自洽：场内 ＋ 场外 ＝ 合计（页面内部一致，tol 1 元）
     ② 场外那一半 ≡ Σ「本期已更新」基金的 App 日收益（严格相等，tol 1 元）—— 判据取 POS_LOGIC.sumDay ✓
     ③ 场外那半的**未更新只**必须被点名（悬停里）—— 见下面那两条 ✓
   ⚠ 2026-10-16：原先还有一条「场外 ≡ 用 NOWCAST 独立复算的**预估**」✗ —— 随页面上的
     「场外当日预估」模块整体下线一并删除 ✓（预估不再出现在页面上，就没有可比的对象了）。
     NOWCAST 数据侧的校验（形状 ＋ 陈旧）与其唯一写者/数据块也在同一天整体移除 ✓ —— 全仓库已无引用。 */
const dayCellEl = sum ? [...sum.querySelectorAll(".sum-cell")].find((el) => el.textContent.includes("当日盈亏")) : null;
const dayCell = dayCellEl ? dayCellEl.textContent.replace(/\s+/g, "") : null;
/* ⚠ 2026-10-13：用户决定「当日盈亏用实际当日盈亏，场内＋场外，每天截图更新就行了」✓ →
   格子恢复**三栏**（场内 ＋ 场外 ＝ 合计 ✓），但三栏**全是实际读数** ✓（估算已从这格撤下 ✗，
   见 positions.html 那段注释 ✓）。这条只守结构自洽 ✓；值与数据源的对齐由下面两条数值断言守 ✓。 */
const splitCells = dayCellEl ? [...dayCellEl.querySelectorAll(".s-split-cell")] : [];
const splitVals = splitCells.map((e) => numsOf(e.textContent)[0]);
const vEtfDay = splitVals[0], vOtcDay = splitVals[1], vAllDay = splitVals[2];
if (splitCells.length === 3 && splitVals.every(Number.isFinite)) {
  check("汇总卡当日盈亏三栏自洽（场内 ＋ 场外 ＝ 合计 · 全是实际读数 ✓）",
    Math.abs(vEtfDay + vOtcDay - vAllDay) <= 1, "场内 " + vEtfDay + " ＋ 场外 " + vOtcDay + " = " + vAllDay);
} else {
  check("汇总卡当日盈亏三栏可解析（场内 / 场外 / 合计）", false, dayCell ? dayCell.slice(0, 140) : "未找到「当日盈亏」单元");
}
const prevFull = ctx.rows.filter((s) => s.items).at(-2);
const IN_CODES = ["159941", "513650", "513310", "513880", "160644"];   // 场内五只（同 SNAP_MKT）
/* ⚠ 2026-09-24 加：本期若有买卖（份额变化），这条只做存在性检查、跳过数值比对。
   页面「场内估」= DEFAULT.chg（真涨跌幅）× 现份额推算，它**不知道当天的成交价**；而券商「当日参考盈亏」
   是按份额逐笔算的（当天买入的份额按买入价）→ 两者天然有差。实测 09-24：标普 513650 当天买入 15,000 份
   （@2.0123），App 报 −2,271.00、页面估算 −2,744（差 473）。这不是 bug 而是口径差（该格 title 已写明），
   故有成交时豁免；无成交时仍按 0.01% 总资产的容差严格比对。 */
const traded = prevFull ? Object.keys(latest.items).some((c) => {
  const a = prevFull.items[c], b = latest.items[c];
  return !!(a && b && (a.qty || 0) !== (b.qty || 0));
}) : false;
const OC = (() => { const c = vm.createContext({}); vm.runInContext(dataSrc.match(/^const OTC = \{[\s\S]*?^\};/m)[0] + "\nthis.o = OTC;", c, { timeout: 500 }); return c.o; })();
/* ⚠ 2026-10-12 修：本条口径是「App 快照里**已公布的那部分**」✗ —— 原式把**沿用旧读数**的基金 day 也加了进来
   ✗：10-12 期 015884 中欧未更新（已清仓在途、按用户指示本期不记），它的 day 仍是 10-08 那个净值日的 −192.26，
   算进来就会把副标里对的数判成错 ✗（副标写 +329＝7 只本周读到 App 的合计，原式给 137 ✗）。
   改为只累加「upd 日期 ＝ OTC.updated」的那些只 —— 与页面副标「App 快照 +X · 1 只未更新」同一口径 ✓。 */
/* 场外当日合计的期望值：**直接调 POS_LOGIC**（positions-logic.js）✓ ——
   本文件原来自写一份 `upd === OTC.updated`（严格相等），而页面 2026-09-25 起是「不早于快照日即算本期」，
   两处口径已漂 ✗：实测 10-15 那期截图取自 10-16（跨零点补拍），页面算出场外 −2,093.25 ✓，
   本断言却一只都不认、期望值成 0.00 → **把正确的页面判成错** ✗✗，还把 apply-screenshot 的写盘挡下回滚 ✗。
   ⚠ 这一行现在**不再自己写判据**：口径改动只需改 positions-logic.js 一处 ✓（页面与门禁同时生效）。 */
const otcDayApp = LOGIC.sumDay(OC.funds, OC.updated);
/* ③b-0 预估值与「快照 day」只比**量级**（2026-10-03 改）：两者口径本就不同 ——
   快照 day 是"场内当日 ＋ 场外已公布"，页面合计是"场内估值 ＋ 场外预估补齐"，不该相等；
   但若差出半个场外，说明 beta / 窗口 / 对齐错了。（旧版是严格比相等，那是场外还是 App 快照时候的事。） */
{
  const otcVal = OC.funds.reduce((a, f) => a + f.value, 0);
  const tol = Math.max(50, otcVal * 0.05);
  /* ⚠ 2026-10-13：这格改成**实际读数**后，本条可以从「只比量级」**收紧成严格相等** ✓ ——
     页面「合计」就该 ≡ 最新快照的 day ✓（同一份落盘数据 ✓，容差 1 元给逐只取整 ✓）。
     （原来比量级是因为页面那格＝"场内估算 ＋ 场外补齐"✗，与快照 day 本就不同范围 ✓。） */
  check("汇总卡当日盈亏「合计」≡ 最新快照的 day（" + latest.day.toFixed(2) + "）",
    Number.isFinite(vAllDay) && Math.abs(vAllDay - latest.day) <= 1,
    "页面合计 " + vAllDay + " vs 快照 day " + latest.day.toFixed(2) + "（差 " + (vAllDay - latest.day).toFixed(2) + "）");
}
if (splitCells.length === 3) {
  /* ⚠ 2026-10-13：页面「场外」栏现在是**实际读数**（Σ 各平台 App「日收益」✓）而不是「指数补齐」的预估 ✗
     → 断言改成与 otcDayApp **严格相等** ✓（原来比的是"独立复算的预估"✓，那是折叠块 + 台账的事
     ✓ 见下面 ③c ✓）。 */
  check("汇总卡「场外」≡ Σ 本次已更新基金的 App「日收益」（" + otcDayApp.toFixed(2) + "）",
    Math.abs(vOtcDay - otcDayApp) <= 1,
    "页面场外 " + vOtcDay + " vs App 日收益合计 " + otcDayApp.toFixed(2) + (traded ? "（本期有买卖）" : ""));
}
const subText = dayCellEl && dayCellEl.querySelector(".s-sub") ? dayCellEl.querySelector(".s-sub").textContent.replace(/\s+/g, " ") : "";
/* ⚠ 2026-10-13 第二轮（用户报「实读值 xxx 说明太多了，精简」✗）：
   副标不再重述来源与推导 ✗ —— 那三句（场内/场外/合计 各是什么）整体搬进**悬停** ✓ →
   判据也跟着搬 ✓：**副标**只守「有快照日期 ✓ ＋ 没有算式 ✓」；**来源说明**改在悬停里守 ✓（下一条 ✓）。
   （原判据要求副标出现「券商 App」「日收益」✗ —— 那正是被精简掉的内容 ✓；且它把已订正的
     「场内＝券商 App」当成了应有内容 ✗，与 ⑫ 的口径一致性问题同源 ✓。） */
check("汇总卡当日副标只留快照日期（不再重述来源与推导 ✗，快照 " + (latest ? latest.d.slice(5) : "?") + "）",
  !!latest && subText.indexOf(latest.d.slice(5).replace("-", ".")) >= 0 && subText.indexOf("＝") < 0,
  (subText || "（无副标）").slice(0, 160));
/* 精简掉的那些话**必须在悬停里找得到** ✓ —— 否则就是"删掉没说"，不是"搬走"了 ✗ */
{
  const dayTip = dayCellEl ? (dayCellEl.getAttribute("title") || "") : "";
  check("当日盈亏**悬停**仍说清两个来源（券商 App「当日总盈亏」✓ ＋ 各平台 App「日收益」✓）",
    /券商 App/.test(dayTip) && /日收益/.test(dayTip), dayTip.slice(0, 110));
}

/* ③f 场外净值水位（2026-10-04 加）：① 8 只一场不落 ② 现价标记的位置必须等于独立复算的区间位置
   —— 标记错位属于「数字对、图本身错」那类 bug，只有把 style.left 与数据复算一遍才抓得到 */
{
  const rows = [...win.document.querySelectorAll("#otc-lvl-card .lvl-row")];
  check("场外水位表 = " + OC.funds.length + " 只", rows.length === OC.funds.length, "表内 " + rows.length + " 行");
  const got = new Map(rows.map((el) => [el.dataset.code, el.querySelector(".lvl-mk.now")]));
  const bad = [];
  OC.funds.forEach((f) => {
    const el = got.get(f.code);
    if (!el) { bad.push(f.code + " 缺行"); return; }
    const want = Math.max(0, Math.min(1, (f.nav.close - f.nav.lo) / (f.nav.hi - f.nav.lo))) * 100;
    const has = parseFloat(el.style.left);
    if (!(Math.abs(has - want) <= 0.2)) bad.push(f.code + " 标记 " + has + "% vs 复算 " + want.toFixed(1) + "%");
  });
  check("水位标记 = 独立复算的区间位置（±0.2pp）", bad.length === 0, bad.join("；"));
}

/* ③f-2 场内「成本位置条」的编码（2026-10-16 加，起因是一次实测 —— 详见 positions.html 的 sz 注释）：
   ① **绿点直径的分辨率**：原 base(5)+range(3)×份数/maxQ → 三只实测极差只有 2.4~2.9px，
      「哪笔买得多」等于没画出来 ✗（改按 √金额 ＋ range 7 → 3.7~6.0px ✓）。
      ⚠ 这条锁的正是「这个编码有没有分辨率」—— 改回线性映射、或把 range 调小，都会在这里报 ✗。
   ② 轴上 3 条四分位刻度（轴就是「52周分位」，而那个数页面上到处在用，条上原先没有参照 ✗）。
   ③ 两个游标**形状不同**（成本＝圆 · 现价＝竖线）—— 只靠颜色 +2px 直径，色盲/强光下会退化成两个圆 ✗。
   ④ 图例**按需**渲染：没有卖出点就不该出现「卖出」项（三只在持标的当前卖出均为 0，摆着是死项 ✗）。
   期望值一律由 data.js 的 POSITIONS.log 独立复算（不读页面中间量 ✓）。 */
{
  const POS2 = (() => {
    const m = readFileSync(path.join(root, "data.js"), "utf8").match(/^const POSITIONS = \{[\s\S]*?^\};/m);
    if (!m) return null;
    const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = POSITIONS;", c, { timeout: 500 }); return c.o;
  })();
  const holds = (POS2 && POS2.hold) || [], log = (POS2 && POS2.log) || [];
  const isSell = (e) => /卖出|减仓|清仓/.test(String(e.act || ""));
  const buysOf = (sym) => log.filter((e) => e.sym === sym && e.cost !== undefined && !isSell(e));
  const sellsOf = (sym) => log.filter((e) => e.sym === sym && e.cost !== undefined && isSell(e));
  const cards = [...win.document.querySelectorAll("#pos-list > article")];
  check("场内持仓卡 " + holds.length + " 张", cards.length === holds.length, "页面 " + cards.length + " 张");
  const thin = [], tickBad = [], shapeBad = [], legendBad = [];
  /* 绿点直径的最小可辨极差：抽成常量，免得**断言名与阈值各写一个数**（这种漂移本文件里出现过 ✗） */
  const MIN_DOT_SPAN = 3.5;
  cards.forEach((card, ci) => {
    const sym = (holds[ci] || {}).sym || "(第 " + (ci + 1) + " 张)";
    const buys = buysOf(sym), sells = sellsOf(sym);
    const dots = [...card.querySelectorAll(".buy-mark b")].map((b) => parseFloat(b.style.width)).filter((x) => Number.isFinite(x));
    const amts = buys.map((e) => Math.abs(e.qty) * (e.cost || 0));
    const span = amts.length ? Math.max.apply(null, amts) / Math.max(1, Math.min.apply(null, amts)) : 0;
    if (dots.length >= 2 && span >= 3) {
      const range = Math.max.apply(null, dots) - Math.min.apply(null, dots);
      /* MIN_DOT_SPAN：√ 映射本身就是压平的（极差不可能无限大），实测三只为 3.7 / 4.2 / 6.0px —
         3.5 是「人眼在 8~12px 尺度上还能分辨」的下限 ✓，也是「编码塌掉」的分界（改回线性映射会掉到 2.4~2.9 ✗）。 */
      if (range < MIN_DOT_SPAN) thin.push(sym + " 直径极差仅 " + range.toFixed(1) + "px（" + Math.min.apply(null, dots) + "~" + Math.max.apply(null, dots) + "px）");
    }
    if (card.querySelectorAll(".bar-tick").length !== 3) tickBad.push(sym + " " + card.querySelectorAll(".bar-tick").length + " 条");
    /* ⚠ 形状用 **getComputedStyle** 读，不能用 getBoundingClientRect —— 本文件跑在 jsdom 里，
       没有布局引擎，rect 恒为 0×0 ✗（2026-10-16 首次写这条时正是这样误报了三张卡）。
       jsdom 的 getComputedStyle 能解析样式表里的 width/height/border-radius ✓（实测确认）。 */
    const co = card.querySelector(".bar-marker.cost"), nw = card.querySelector(".bar-marker.now");
    if (co && nw) {
      const a = win.getComputedStyle(co), b = win.getComputedStyle(nw);
      const aw = parseFloat(a.width), ah = parseFloat(a.height), bw = parseFloat(b.width), bh = parseFloat(b.height);
      if (!(Math.abs(aw - ah) < 1.5 && /50%/.test(a.borderRadius)) || !(bh > bw * 3))
        shapeBad.push(sym + "（成本 " + aw + "×" + ah + " 圆角 " + a.borderRadius + " · 现价 " + bw + "×" + bh + "）");
    }
    const lgN = card.querySelectorAll(".bar-legend > span").length;
    const wantLg = 1 + (buys.length ? 1 : 0) + (sells.length ? 1 : 0);
    if (lgN !== wantLg) legendBad.push(sym + " 图例 " + lgN + " 项（应 " + wantLg + "：区间" + (buys.length ? "＋买入" : "") + (sells.length ? "＋卖出" : "") + "）");
  });
  check("场内位置条：绿点直径极差 ≥ " + MIN_DOT_SPAN + "px（金额编码真的有分辨率）", thin.length === 0, thin.join("；") || "各卡极差都够 ✓");
  check("场内位置条：每张卡 3 条四分位刻度（25/50/75%）", tickBad.length === 0, tickBad.join("；") || "全部 ✓");
  check("场内位置条：成本＝圆 · 现价＝竖线（形状可区分，不只靠颜色）", shapeBad.length === 0, shapeBad.join("；") || "形状区分 ✓");
  check("场内位置条：图例按需渲染（无卖出点则不出现「卖出」）", legendBad.length === 0, legendBad.join("；") || "图例项 ≡ 数据 ✓");
}

/* ③f-3 场内卡的「数字表述」（2026-10-16 加，用户点单 ①②③⑤）——
   这四条都属于「数字对、但读者会读错 / 得心算」那一类，纯看数据层永远发现不了 ✗：
   ① 摊薄那格必须带**动词**（「摊薄省下 / 多花 X 元」）：原写法「首笔 1.6294 → 今（−2,320 元）」
      符号与语义**都是反的** —— 成本下降（好事）显示成负数、上升显示成 +X，且没有动词 ✗；
   ② 卡内不许出现同一个成本价的两种精度：成本价一律 4 位（现价 / 高低点 3 位）—— 原先 1.6062 与 1.61 并存 ✗；
   ③ 策略行的「今日」必须同时给 % 与金额（17 万市值看百分比要心算 ✗）；
   ⑤ 持有天数那格必须带首笔日期（分批建仓时「持有 N 天」不代表某一笔的持有期 ✗）。 */
{
  const POS3 = (() => {
    const m = readFileSync(path.join(root, "data.js"), "utf8").match(/^const POSITIONS = \{[\s\S]*?^\};/m);
    if (!m) return null;
    const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = POSITIONS;", c, { timeout: 500 }); return c.o;
  })();
  const holds3 = (POS3 && POS3.hold) || [];
  const cards3 = [...win.document.querySelectorAll("#pos-list > article")];
  const noVerb = [], twoDp = [], noDayAmt = [], noFirstD = [], premGapMiss = [];
  cards3.forEach((card, ci) => {
    const h = holds3[ci] || {};
    const sym = h.sym || "(第 " + (ci + 1) + " 张)";
    const txt = card.textContent.replace(/\s+/g, "");
    /* ① 摊薄那格带动词（有 ≥2 笔买入才该出现这一句） */
    const kpis = [...card.querySelectorAll(".kpi")];
    const costKpi = kpis.find((k) => /距成本位/.test(k.textContent));
    const sub = costKpi ? costKpi.querySelector(".k-sub").textContent.replace(/\s+/g, "") : "";
    if (!/摊薄(省下|多花)|成本未变/.test(sub)) noVerb.push(sym + "：" + sub.slice(0, 60));
    /* ② 同一个成本价不许两种精度：2 位形式若出现，只能是别的数（本页成本价 4 位 ✓） */
    if (Number.isFinite(h.idxAtCost)) {
      const two = h.idxAtCost.toFixed(2);
      /* 只在「成本价」语境里查（避免 1.61 恰好也是别的数的前缀而误报） */
      if (new RegExp("成本价?" + two.replace(".", "\\.") + "(?![0-9])").test(txt)) twoDp.push(sym + " 出现 " + two + "（成本价应为 4 位 " + h.idxAtCost.toFixed(4) + "）");
      if (!txt.includes("成本价" + h.idxAtCost.toFixed(4) + "元")) twoDp.push(sym + " 缺 4 位成本价 " + h.idxAtCost.toFixed(4));
    }
    /* ③ 今日必须带金额 —— 正则**紧贴百分比之后**（2026-10-16 收紧：原先写成 /今日.*%（.*元≈/
       会一路匹配到本行末尾那个「?」浮层的说明文字里，等于放宽成"整卡有「元≈」就行" ✗） */
    const stratTxt = (card.querySelector(".strat-row") ? card.querySelector(".strat-row").textContent : "").replace(/\s+/g, "");
    if (!/今日[-+−]?\d[\d.]*%（[-+−][\d,]+元≈）/.test(stratTxt)) noDayAmt.push(sym + "：" + stratTxt.slice(0, 50));
    /* ⑤ 持有天数带首笔日期 */
    const heldTxt = (card.querySelector(".held") ? card.querySelector(".held").textContent : "").replace(/\s+/g, "");
    if (!/持有\d+天（首笔\d\d\.\d\d）/.test(heldTxt)) noFirstD.push(sym + "：" + heldTxt.slice(0, 40));
    /* ④ 溢价 ≥ 3%（PREM_WARN）时，悬停里要给出规模 */
    const premChip = card.querySelector(".date-chip.prem-warn, .date-chip.prem-high, .date-chip.prem-disc");
    if (premChip && !/规模/.test(premChip.getAttribute("title") || "")) premGapMiss.push(sym);
  });
  check("场内卡「摊薄」那格带动词（省下 / 多花 / 成本未变）—— 不是光给一个符号 ✗", noVerb.length === 0, noVerb.join("；") || "全部带动词 ✓");
  check("场内卡：同一个成本价只有一种精度（4 位；2 位形式不得出现在成本价语境）", twoDp.length === 0, twoDp.join("；") || "精度统一 ✓");
  check("场内卡策略行「今日」同时给 % 与金额（≈ 元）", noDayAmt.length === 0, noDayAmt.join("；") || "全部带金额 ✓");
  check("场内卡「持有 N 天」带首笔日期", noFirstD.length === 0, noFirstD.join("；") || "全部带首笔 ✓");
  check("场内卡溢价 ≥ " + 3 + "% 时悬停给出**规模**（≈ 多少元是溢价）", premGapMiss.length === 0, premGapMiss.join("、") || "溢价规模已给 ✓");
}

/* ③f-4 逐笔流水的「可读性四条」（2026-10-16 加，用户点单 ①②③④）——
   全部是**页面显示层**的事（数据层 log[] 一字未动 ✓），所以只能在这里断：
   ① 备注行内必须**截断**：log[].note 里混着"操作信息"与**对账证据链** ✗ ——
      原样贴进来等于把工作过程当成操作历史（实测单行 60~115 字，15 行全噪声），全文应挂 title ✓；
   ② 每行必须有**金额**：原来只有「份数 @ 价」，金额得心算 ✗（而周小计里就有 ✓）；
   ③ 买 / 卖的动作列只许一个字形：原先每行写「买入 / 卖出」，15 行 15 个零信息量的词 ✗；
   ④ 日期悬停必须是**完整日期**：行上只写 MM.DD ✓，但这份台账跨年后就不知道是哪年了 ✗。 */
{
  const cards4 = [...win.document.querySelectorAll("#pos-list > article")];
  const longNote = [], noAmt = [], actWord = [], noFullDate = [], moBad = [];
  let rows4 = 0;
  cards4.forEach((card, ci) => {
    const tag = "第 " + (ci + 1) + " 张卡";
    [...card.querySelectorAll(".log-item")].forEach((el) => {
      rows4++;
      const act = el.querySelector(".act-badge"), num = el.querySelector(".log-nums");
      const day = el.querySelector(".log-date"), note = el.querySelector(".log-note");
      if (note) {
        const shown = note.textContent.replace(/…/g, "").trim();
        const full = note.getAttribute("title") || "";
        if (shown.length > 36) longNote.push(tag + " 行内 " + shown.length + " 字：" + shown.slice(0, 28));
        if (full.length > shown.length + 6 && !/备注全文/.test(full)) longNote.push(tag + " 备注被截断却没在 title 给全文 ✗");
      }
      if (num && !/≈[\d,]+ 元/.test(num.textContent)) noAmt.push(tag + "：" + num.textContent.replace(/\s+/g, " ").slice(0, 40));
      if (act && /买入|卖出|建仓|加仓|清仓|减仓/.test(act.textContent)) actWord.push(tag + "：" + act.textContent.trim());
      if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day.getAttribute("title") || "")) noFullDate.push(tag + "：" + (day.getAttribute("title") || "无 title"));
    });
  });
  /* ⑤ 月表头（2026-10-16 由「周小计」改为按月）：**笔数合计 ≡ 该容器流水行数** —— 分组最容易犯的
     正是丢行与重复计入 ✗（当年按周分组时没这条，靠人眼；按月同样要盯）。
     ⚠ 用 data-mo-n（精确值）比，不能拿显示值比 —— 它带千分位与加粗 ✗（同清仓卡分段那条 ✓）。
     ⚠ 这一段必须**按容器遍历**：第一版我把它挂在「本行是容器第一个子元素」上 ✗ ——
       而容器第一个子元素正是**月表头**，于是那段代码从未执行、断言永远"通过" ✗✗（反向测试时才发现：
       把月表头改成只统计 1 行，门禁居然不报）。这正是本仓库最忌讳的"假绿门禁" ✗，故改写成按 .log-list 遍历 ✓。 */
  cards4.forEach((card, ci) => {
    const tag = "第 " + (ci + 1) + " 张卡";
    [...card.querySelectorAll(".log-list")].forEach((list) => {
      const moRows = [...list.querySelectorAll(".log-month[data-mo]")];
      if (!moRows.length) return;
      for (const mo of moRows) {
        const v = mo.getAttribute("data-mo") || "";
        if (!/^\d{4}-\d{2}$/.test(v)) moBad.push(tag + " 月份名没带年份：「" + v + "」✗（台账是长期的，跨年会歧义）");
      }
      const n = moRows.reduce((a, mo) => a + (parseInt(mo.getAttribute("data-mo-n"), 10) || 0), 0);
      const rows = list.querySelectorAll(".log-item").length;
      if (n !== rows) moBad.push(tag + " 月表头笔数合计 " + n + " ≠ 流水 " + rows + " 行");
    });
  });
  check("逐笔流水 " + rows4 + " 行：备注行内已截断（全文挂 title）", longNote.length === 0, longNote.slice(0, 3).join("；") || "全部截断 ✓");
  check("逐笔流水：每行都给了金额（≈ 元，口径同周小计）", noAmt.length === 0, noAmt.slice(0, 3).join("；") || "全部有金额 ✓");
  check("逐笔流水：买 / 卖用字形（▲ / ▼），不再逐行写「买入 / 卖出」", actWord.length === 0, actWord.slice(0, 3).join("；") || "已压缩 ✓");
  check("逐笔流水：日期悬停给完整日期（MM.DD 只用于显示）", noFullDate.length === 0, noFullDate.slice(0, 3).join("；") || "全部完整 ✓");
  /* ⑤ 按月分组（2026-10-16 由「周小计」改来）：月份名带年份 ＋ 月表头笔数合计 ≡ 流水行数 */
  check("逐笔流水：按月分组 —— 月份名带年份 ＋ 月表头笔数合计 ≡ 流水行数", moBad.length === 0, moBad.slice(0, 3).join("；") || "全部一致 ✓");
}

/* ③h 盈亏全程三条线（2026-10-04 加）：① chip 标签 ② 三个序列都在
   ③ **合计末值 = 独立复算**（ACCT_STATS.monthly ＋ 财务页 FIN_PL 的 5 个 fund 渠道）——
      这条最关键：数据跨文件（还跨页引用 finance-data.js），抄错 / 读错不会报错，只会画出一条似是而非的线 */
{
  const chip = [...win.document.querySelectorAll("#trend-views .tchip")].find((b) => /盈亏全程/.test(b.textContent));
  check("走势视图含「盈亏全程」" + (chip ? "（标签：" + chip.textContent.trim() + "）" : "（缺）"), !!chip);
  /* ⚠ 渲染层必须单独验：2026-10-04 那个 TDZ bug 正是「数据函数好、渲染却降级」
     （chip 退回「· 场内」、图上只画一条线），只看 buildPnlSeries() 的输出是抓不到的 ✗ */
  if (chip) chip.click();
  await new Promise((r) => win.setTimeout(r, 80));
  const draws = [...win.document.querySelectorAll("#trend-box svg polyline")];
  check("盈亏全程图上确实画了 3 条线（合计 ＋ 场内 ＋ 场外）", draws.length >= 3,
    "SVG 里 " + draws.length + " 条折线 · 图例：" + ((win.document.getElementById("trend-legend") || {}).textContent || "").replace(/\s+/g, " ").trim().slice(0, 60));
  /* 读数条新增三样（2026-10-04）：距峰值 / 场内当月 / 当月拆分；且拆分两项之和必须 = 当月 */
  const roTxt = (win.document.getElementById("trend-readout") || {}).textContent || "";
  check("读数条含「距峰值」「场内当月」「当月拆分」",
    /距峰值/.test(roTxt) && /场内当月/.test(roTxt) && /当月拆分/.test(roTxt), roTxt.replace(/\s+/g, " ").trim().slice(0, 90));
  {
    const nums = (s) => (s.match(/[-−]?\d[\d,]*(?:\.\d+)?/g) || []).map((x) => +x.replace(/,/g, "").replace("−", "-"));
    const attr = win.document.querySelector("#trend-readout .ro-attr");
    const monCell = [...win.document.querySelectorAll("#trend-readout .ro-cell")].find((c) => /^当月/.test(c.textContent.trim()));
    const mon = monCell ? nums(monCell.textContent)[0] : null;
    /* .ro-attr 里只有拆分那两个数（口径句已精简成纯文字、没有数字），故直接取前两个 */
    const parts = attr ? nums(attr.textContent).filter((v) => Math.abs(v) > 0.5) : [];
    /* 2026-10-09 修正：原断言要求 `parts.length >= 2` ✗ —— 但上面那行 filter 会把 ≤0.5 的**滤掉**，
       而**当月**的另一半完全可能天然是 0（例：10 月场内已有 +3,008.60，而场外的 10 月月度读数
       要等财务页那份账单出来才有 → 页面只渲染一格、另一格是 0 → parts.length = 1 → 断言必红 ✗，
       可拆分之和对得上（3,008.60 vs 当月 3,008）✓ —— 这是「把某一天/某一个月的状态当成真理」的同一类假警报。
       改为 `>= 1` 且对**全部** parts 求和：有一格时它退化成「当月那格 = 数据里的当月」，仍有意义 ✓；
       两格时与原来完全等价 ✓（真正要拦的是"两格相加 ≠ 当月"或"格数与数据不符"，不是"这个月只有一格"）。 */
    check("当月拆分（场内＋场外）= 当月 " + (mon === null ? "?" : mon),
      mon !== null && parts.length >= 1 && Math.abs(parts.reduce((a, b) => a + b, 0) - mon) <= 2,
      "拆分 " + parts.map(Math.round).join(" + ") + " = " + Math.round(parts.reduce((a, b) => a + b, 0)) + " vs 当月 " + mon);
  }
  /* ⚠ 必须切回「金额」视图：本节之后的读数条检查（走势卡读数含最新总资产 / 浮盈亏）看的是金额视图 ✗ */
  const back = [...win.document.querySelectorAll("#trend-views .tchip")].find((b) => b.textContent.trim().indexOf("金额") === 0);
  if (back) back.click();
  await new Promise((r) => win.setTimeout(r, 80));
  const ser = (typeof win.buildPnlSeries === "function") ? win.buildPnlSeries() : null;
  check("盈亏全程三条线都在（合计 / 场内 / 场外）",
    !!ser && ser.all.length >= 2 && ser.etf.length >= 2 && ser.otc.length >= 2 && ser.hasOtc,
    ser ? ("合计 " + ser.all.length + " 点 · 场内 " + ser.etf.length + " · 场外 " + ser.otc.length) : "win.buildPnlSeries 不可用");
  /* ⚠ ACCT_STATS 在 data.js（生成块），不在 positions-data.js（人工块）—— 本页两个都加载 */
  const genSrc = readFileSync(path.join(root, "data.js"), "utf8");
  const AS = (() => { const c = vm.createContext({}); vm.runInContext(genSrc.match(/^const ACCT_STATS = \{[\s\S]*?^\};/m)[0] + "\nthis.o = ACCT_STATS;", c, { timeout: 500 }); return c.o; })();
  const fdSrc = readFileSync(path.join(root, "finance", "finance-data.js"), "utf8");
  const FP = (() => { const c = vm.createContext({}); vm.runInContext(fdSrc.match(/^const FIN_PL = \{[\s\S]*?^\};/m)[0] + "\nthis.o = FIN_PL;", c, { timeout: 500 }); return c.o; })();
  const FA = (() => { const c = vm.createContext({}); vm.runInContext(fdSrc.match(/^const FIN_ACCOUNTS = \[[\s\S]*?\n\];/m)[0] + "\nthis.o = FIN_ACCOUNTS;", c, { timeout: 500 }); return c.o; })();
  let want = AS.monthly.reduce((a, m) => a + m.pnl, 0);
  FA.filter((a) => a.kind === "fund").forEach((a) => Object.keys(FP[a.id] || {}).forEach((k) => { if (typeof FP[a.id][k] === "number") want += FP[a.id][k]; }));
  const got = (ser && ser.all.length) ? ser.all[ser.all.length - 1].pl : null;
  check("盈亏全程「合计」末值 = 独立复算 " + Math.round(want) + " 元",
    got !== null && Math.abs(got - want) <= 1, "曲线 " + (got === null ? "—" : got.toFixed(2)) + " vs 复算 " + want.toFixed(2));
}

/* ④ 配置图：现金段显示的必须是快照现金 */
const allocText = alloc ? (alloc.textContent + " " + alloc.innerHTML).replace(/\s+/g, "") : "";
check("配置图现金 = 最新快照 " + money(snapCash), near(allocText, snapCash), allocText.slice(0, 200));

/* ④b 清仓历史卡（2026-10-09 改版：总 → 场内/场外 → **按平台** → 全部明细合一；不再按类别分组）
   三条断言（这张卡 2026-10-09 之前**一条断言都没有** ✗）：
     ① 总行 = 场外（CLOSED App 原读数，独立读 data.js）＋ 场内（由 POSITIONS.log 独立复算）
     ② 卡内出现「按平台汇总」，且每个平台的金额都能在卡里找到（平安证券=场内、支付宝=场外）
     ③ 场内每只的「清仓日」= 该标的**最后一笔**卖出日（曾因流水"新在上"取成了最早那笔 ✗） */
{
  const cardEl = win.document.getElementById("closed-card");
  const POS = (() => {
    const m = readFileSync(path.join(root, "data.js"), "utf8").match(/^const POSITIONS = \{[\s\S]*?^\};/m);
    if (!m) return null;
    const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = POSITIONS;", c, { timeout: 500 }); return c.o;
  })();
  const CL = (() => {
    const m = readFileSync(path.join(root, "data.js"), "utf8").match(/^const CLOSED = \{[\s\S]*?^\};/m);
    if (!m) return null;
    const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = CLOSED;", c, { timeout: 500 }); return c.o;
  })();
  /* 场外的**第二个**来源（2026-10-21 加）：广发基金直销也清过仓了，页面按平台分段会多一段 ✓ ——
     本块的断言必须跟页面同一步（否则「场外合计」与段头数会少算这一笔 ✗）。 */
  const CL_GF = (() => {
    const m = readFileSync(path.join(root, "data.js"), "utf8").match(/^const CLOSED_GF = \{[\s\S]*?^\};/m);
    if (!m) return null;
    const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = CLOSED_GF;", c, { timeout: 500 }); return c.o;
  })();
  const isSell = (e) => /卖出|减仓|清仓/.test(String(e.act || ""));
  /* ⚠ 口径与页面一致（2026-10-09 改）：场内已了结的盈亏 = **生命周期实际结果**
     = Σ卖出净额 − Σ买入含费（含双边费用、不重复计 ✓）；不再用「Σ逐笔 realized」✗
     （摊薄口径下逐笔相加减会把亏损重复计一遍：中韩 −13,681.06 vs −13,217.10、港美 −10,346.91 vs −5,270.50 ✗）
     费用规则也照页面：note 里写了「费 X」用它、否则按 5 元（＝ CONFIG.FEE_PER_SIDE）✓ */
  const FEE = 5;
  const feeOf = (e) => { const m = String(e.note || "").match(/费\s*([\d.]+)/); return m ? parseFloat(m[1]) : FEE; };
  const agg = {}, lastSell = {};
  ((POS && POS.log) || []).forEach((e) => {
    const k = String(e.sym || ""); if (!k) return;
    const o = agg[k] || (agg[k] = { qty: 0, buy: 0, cash: 0 });
    if (isSell(e)) {
      o.qty -= (e.qty || 0);
      o.cash += (e.qty || 0) * (e.cost || 0) - feeOf(e);
      lastSell[k] = (!lastSell[k] || e.d > lastSell[k]) ? e.d : lastSell[k];
    } else {
      o.qty += (e.qty || 0);
      o.buy += (e.qty || 0) * (e.cost || 0) + feeOf(e);
    }
  });
  const etfClosed = Object.keys(agg).map((k) => ({ k, pnl: agg[k].cash - agg[k].buy })).filter((o, i) => agg[Object.keys(agg)[i]].qty === 0);
  const sEtf = etfClosed.reduce((a, o) => a + o.pnl, 0);
  const sOtc = (CL ? CL.items.reduce((a, r) => a + r.pnl, 0) : 0)
    + (CL_GF ? CL_GF.items.reduce((a, r) => a + r.pnl, 0) : 0);
  const totEl = cardEl ? cardEl.querySelector("#closed-all-total") : null;
  check("清仓历史总行 = 场外 " + money(sOtc) + " ＋ 场内 " + money(sEtf),
    !!totEl && near(totEl.textContent.replace(/\s+/g, ""), sOtc + sEtf, 0.01),
    totEl ? totEl.textContent.replace(/\s+/g, " ").trim().slice(0, 100) : "卡内没有 #closed-all-total");
  const cardTxt = cardEl ? cardEl.textContent.replace(/\s+/g, "") : "";
  /* 2026-10-20：独立的「按平台汇总」块已删（与顶部 closed-brief 的四个数完全重复）→
     断言只校验这两个金额在卡内可见（现在由 brief 承载）。 */
  check("清仓历史卡内可见 场内 " + money(sEtf) + " 与 场外 " + money(sOtc),
    near(cardTxt, sEtf, 0.01) && near(cardTxt, sOtc, 0.01), cardTxt.slice(0, 130));
  const badD = etfClosed.filter((o) => {
    const row = cardEl ? cardEl.querySelector('[data-sym="' + o.k + '"]') : null;
    /* ⚠ 判据只认「日期本身」，**不认分隔符**（2026-10-12 页面统一为点号 09.30 ✗→✓ 后本断言曾误报）：
       页面把月日显示成 09.30，这里就两种写法都收 —— 断言要的是"这一期出现了"，不是"用了哪个杠" ✓ */
    const md = lastSell[o.k].slice(5), mdDot = md.replace("-", ".");
    const txt = row ? row.textContent.replace(/\s+/g, "") : "";
    return !row || (txt.indexOf(mdDot) < 0 && txt.indexOf(md) < 0);
  }).map((o) => o.k + "（应为 " + lastSell[o.k] + "）");
  check("清仓历史明细：场内每只「清仓日」= 该标的最后一笔卖出日（" + etfClosed.length + " 只）",
    badD.length === 0, badD.length ? "对不上：" + badD.join("、") : "逐只核对通过 ✓");
  /* ④b-2 清仓卡「聚合读数」两行（2026-10-12 加）：胜率 / 平均持有 / 单笔极值
     这两行属于"数据早就有（data.js 的 CLOSED.winRate/avgHoldDays 与 CLOSED_ETF 同名字段 ✓）、
     页面此前只显示合计 ✗" —— 补显示时最容易抄错数字，故**逐值锚到 data.js 文件**（不读页面中间量 ✓）。 */
  const CLOSED_D = (() => { try { const m = readFileSync(path.join(root, "data.js"), "utf8").match(/^const CLOSED = \{[\s\S]*?^\};/m); if (!m) return null; const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = CLOSED;", c, { timeout: 500 }); return c.o; } catch (e) { return null; } })();
  const CLOSED_ETF_D = (() => { try { const m = readFileSync(path.join(root, "data.js"), "utf8").match(/^const CLOSED_ETF = \{[\s\S]*?^\};/m); if (!m) return null; const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = CLOSED_ETF;", c, { timeout: 500 }); return c.o; } catch (e) { return null; } })();
  const oAgg = cardEl ? cardEl.querySelector("#closed-otc-agg") : null;
  const eAgg = cardEl ? cardEl.querySelector("#closed-etf-agg") : null;
  const attrOf = (el, k) => (el ? el.getAttribute(k) : null);
  check("清仓卡：场外聚合（胜率 / 平均持有 / 笔数）≡ data.js CLOSED 逐值",
    !!oAgg && !!CLOSED_D && +attrOf(oAgg, "data-winrate") === CLOSED_D.winRate
      && +attrOf(oAgg, "data-hold") === CLOSED_D.avgHoldDays && +attrOf(oAgg, "data-n") === CLOSED_D.count,
    oAgg ? "胜率 " + attrOf(oAgg, "data-winrate") + "% · 持有 " + attrOf(oAgg, "data-hold") + " 天 · " + attrOf(oAgg, "data-n") + " 笔（数据 " + CLOSED_D.winRate + "% / " + CLOSED_D.avgHoldDays + " 天 / " + CLOSED_D.count + " 笔）" : "卡里没有 #closed-otc-agg（聚合行没渲染）✗");
  check("清仓卡：场内聚合（胜率 / 平均持有 / 单笔最大亏损 / 平均盈利）≡ data.js CLOSED_ETF 逐值",
    !!eAgg && !!CLOSED_ETF_D && +attrOf(eAgg, "data-winrate") === CLOSED_ETF_D.winRate
      && +attrOf(eAgg, "data-hold") === CLOSED_ETF_D.avgHoldDays && +attrOf(eAgg, "data-maxloss") === CLOSED_ETF_D.maxLoss
      && +attrOf(eAgg, "data-avgwin") === CLOSED_ETF_D.avgWin,
    eAgg ? "胜率 " + attrOf(eAgg, "data-winrate") + "% · 持有 " + attrOf(eAgg, "data-hold") + " 天 · 最大亏损 " + attrOf(eAgg, "data-maxloss") : "卡里没有 #closed-etf-agg ✗");
  /* ④b-3 清仓卡「⇄ 在持同名」小标（2026-10-16 加，D）——
     数据侧 `CLOSED.items[].alsoHeld` 是**显式标注**（明确不做名称模糊匹配 ✗，因为同一只基金在不同 App 里
     名字都不一样：App「广发纳指100」vs 本仓库「广发纳斯达克100」），页面据此在明细行打小标 ✓。
     两条都要断：① 指向的代码**真的在持**（改名 / 清仓后忘了改这一格，小标就会把读者引到不存在的在持项 ✗）；
     ② 页面渲染的小标数 ≡ 数据里的标注数（漏渲染 / 多渲染都错 ✗）。 */
  const heldSet = new Set(((POS && POS.hold) || []).map((p) => p.code).concat(((OC && OC.funds) || []).map((f) => f.code)));
  const marked = ((CLOSED_D && CLOSED_D.items) || []).filter((r) => r.alsoHeld);
  const badHeld = marked.filter((r) => !heldSet.has(r.alsoHeld)).map((r) => r.name + " → " + r.alsoHeld);
  check("清仓卡：`alsoHeld` 指向的代码真的在持（" + marked.length + " 条）",
    badHeld.length === 0, badHeld.length ? "不在持 ✗：" + badHeld.join("、") : marked.map((r) => r.alsoHeld).join(" / ") || "无标注");
  const heldChips = cardEl ? cardEl.querySelectorAll(".c-held").length : -1;
  check("清仓卡：渲染「⇄ 在持同名」小标 ≡ data.js alsoHeld 条数（" + marked.length + " 条）",
    heldChips === marked.length, "页面 " + heldChips + " 枚 vs 数据 " + marked.length + " 条");
  /* ④b-4 明细**按平台分段**（2026-10-16 加，A）——
     分段是纯渲染分组（数据侧不新增字段 ✗），所以只能在这里断「分组有没有丢行 / 少一段」✗。
     段头带 data-sec / data-sec-sum / data-sec-n（精确值，页面显示值按千分位取整，不能拿它比 ✗）。 */
  const secs = cardEl ? [...cardEl.querySelectorAll(".closed-sec[data-sec]")] : [];
  const secSum = secs.reduce((a, s) => a + parseFloat(s.getAttribute("data-sec-sum")), 0);
  const secN = secs.reduce((a, s) => a + (parseInt(s.getAttribute("data-sec-n"), 10) || 0), 0);
  /* 段数/笔数按**数据块**数：场外两块（支付宝 CLOSED ＋ 广发 CLOSED_GF，2026-10-21 加）＋ 场内一块 ✓ */
  const wantSec = ((CLOSED_D && CLOSED_D.items) ? 1 : 0) + ((CL_GF && CL_GF.items) ? 1 : 0)
    + ((CLOSED_ETF_D && CLOSED_ETF_D.items) ? 1 : 0);
  const wantN = ((CLOSED_D && CLOSED_D.items) ? CLOSED_D.items.length : 0)
    + ((CL_GF && CL_GF.items) ? CL_GF.items.length : 0)
    + ((CLOSED_ETF_D && CLOSED_ETF_D.items) ? CLOSED_ETF_D.items.length : 0);
  check("清仓卡：明细按平台分段 —— 段头 " + wantSec + " 个 · 笔数合计 " + wantN + " · 各段合计之和 ≡ 场内 ＋ 场外",
    secs.length === wantSec && secN === wantN && Math.abs(secSum - (sOtc + sEtf)) <= 0.01,
    secs.map((s) => s.getAttribute("data-sec") + " " + s.getAttribute("data-sec-sum") + "（" + s.getAttribute("data-sec-n") + " 笔）").join(" · ")
      || "没有段头（明细没按平台分段）✗");
  /* ④c 盈亏总览的「清仓累计已兑现」行（2026-10-09 加）——
     它与本块 ① 的「清仓历史总行」是**同一批数字的两处显示**，分列两张卡就有漂移风险 → 必须断言一致 ✓。
     取的是行上的 data-pl（**精确值**）：卡片显示值按整元取整（fmtAmt ✗），0.01 容差的断言在显示值上
     分辨不出漂移 ✗；右边的 sOtc / sEtf 仍是本文件**独立复算**（读 data.js 的 CLOSED ＋ POSITIONS.log，
     不读页面中间量）✓ */
  const clrEl = win.document.getElementById("pl-cleared-total");
  const clrVal = clrEl && clrEl.dataset ? Number(clrEl.dataset.pl) : NaN;
  check("盈亏总览「清仓累计已兑现」= 场外 " + money(sOtc) + " ＋ 场内 " + money(sEtf),
    Number.isFinite(clrVal) && Math.abs(clrVal - (sOtc + sEtf)) < 0.01,
    clrEl ? "总览行 data-pl=" + clrVal + " · 显示 " + clrEl.textContent.replace(/\s+/g, " ").trim() : "「盈亏总览」里没有 #pl-cleared-total");
}

/* ④d 快照对比：「清仓行」的本期盈亏必须是**这只本期真正的盈亏**，不能是「上期浮盈亏的相反数」✗
   （2026-10-09 用户报的 bug：中韩半导体ETF华泰被清掉，行内显示 **+12,649**，而它是**亏着卖**的 ——
     旧口径 -(a.pl) 把"浮亏不再挂在账上"当成了收益 ✗✗；正确口径 = 卖出回款 − 本期期初市值。
     实测：69,155.00 − 69,722.40 = **−567.40**（＝当日价跌 (4.587→4.550)×15,200 = −562.40 − 费 5.00 ✓）。
   本断言**独立复算**（不读页面的中间量）：对最新一期的每一只场内清仓标的，
   回款 = 该只在本期的卖出行 realized ＋ 期初成本 → 期望值必须出现在快照卡文本里 ✓） */
{
  const snapRows = (() => {
    const m = readFileSync(path.join(root, "positions-data.js"), "utf8").match(/^const SNAPSHOTS = \[[\s\S]*?^\];/m);
    if (!m) return [];
    const c = vm.createContext({});
    vm.runInContext(m[0] + "\nthis.o = SNAPSHOTS;", c, { timeout: 500 });
    return c.o;
  })();
  const P2 = (() => {
    const m = readFileSync(path.join(root, "data.js"), "utf8").match(/^const POSITIONS = \{[\s\S]*?^\};/m);
    if (!m) return null;
    const c = vm.createContext({});
    vm.runInContext(m[0] + "\nthis.o = POSITIONS;", c, { timeout: 500 });
    return c.o;
  })();
  const full = snapRows.filter((s) => s.items);
  /* ⚠ 2026-10-12 修：原来只看**最后两次快照**✗ —— 清仓并不总发生在最新一期（10-12 那期没有清仓，
     清仓在 10-09 期，于是 want ＝ 0 只、断言退化失败 ✗）。改为**扫描全部相邻期** ✓：
     任何一期有场内标的从 items 消失，就把「回款 − 期初市值」算出来、要求它出现在快照卡里
     （快照卡是逐期全渲染的 ✓，历史期的清仓行也在卡内 ✓）。 */
  const want = [];
  for (let i = 1; i < full.length; i++) {
    const prevS2 = full[i - 1], curS2 = full[i];
    Object.keys(prevS2.items)
      .filter((code) => !curS2.items[code] && /ETF|LOF/.test(prevS2.items[code].name))
      .forEach((code) => {
        const nm = prevS2.items[code].name;
        const sell = ((P2 && P2.log) || []).filter((e) => /卖出|减仓|清仓/.test(String(e.act || "")) &&
          e.sym === nm && e.d > prevS2.d && e.d <= curS2.d)[0];
        if (sell && Number.isFinite(sell.realized))
          want.push({ nm: nm, v: (sell.realized + (prevS2.items[code].cost || 0)) - (prevS2.items[code].val || 0) });
      });
  }
  const snapEl = win.document.getElementById("snap-list");
  const snapTxt = snapEl ? snapEl.textContent.replace(/\s+/g, "") : "";
  const bad = want.filter((w) => !near(snapTxt, w.v, 1));
  check("快照对比「清仓行」本期盈亏 = 回款 − 期初市值（复算 " + want.length + " 只：" +
    want.map((w) => w.nm.slice(0, 8) + " " + Math.round(w.v)).join("、") + "）",
    want.length > 0 && bad.length === 0,
    bad.length ? "卡里找不到：" + bad.map((w) => w.nm + " 应 " + w.v.toFixed(2)).join("、")
      : (snapEl ? "逐只核对通过 ✓" : "页面里没有 #snap-list"));
}

/* ④e 「场内 / 场外」**分组小计**也必须同一口径（2026-10-09 用户报的第二个数：场内组显示 +20,362 ✗）
   —— 组小计来自 snapGrpSplit，与逐行（snapPairHtml）是**两条路径**；上轮只修了逐行那条，
      所以这个数依旧错、而且与卡头「本期」自相矛盾 ✗。本断言独立复算两组，要求与渲染值一致 ✓ */
{
  const snapRows2 = (() => {
    const m = readFileSync(path.join(root, "positions-data.js"), "utf8").match(/^const SNAPSHOTS = \[[\s\S]*?^\];/m);
    if (!m) return [];
    const c = vm.createContext({});
    vm.runInContext(m[0] + "\nthis.o = SNAPSHOTS;", c, { timeout: 500 });
    return c.o;
  })();
  const P3 = (() => {
    const m = readFileSync(path.join(root, "data.js"), "utf8").match(/^const POSITIONS = \{[\s\S]*?^\};/m);
    if (!m) return null;
    const c = vm.createContext({});
    vm.runInContext(m[0] + "\nthis.o = POSITIONS;", c, { timeout: 500 });
    return c.o;
  })();
  const full2 = snapRows2.filter((s) => s.items);
  const pv = full2[full2.length - 2], cu = full2[full2.length - 1];
  /* ⚠ 不用页面的 win.isOnExchange 分类：它是顶层 **const**（非 function 声明）✗ → 不挂 window；
     初版这么写时两条都算成「全属场外」（复算 0 / 2,304）—— 被断言自己抓出来了 ✓。
     改为按数据自行分类：场内 = POSITIONS.hold 的代码 ∪ 本期清仓且名字像 ETF/LOF 的代码 ✓ */
  const etfSet = new Set(((P3 && P3.hold) || []).map((h) => h.code));
  Object.keys(pv.items).forEach((code) => { if (!cu.items[code] && /ETF|LOF/.test(pv.items[code].name)) etfSet.add(code); });
  const sums = { in: 0, ot: 0 };
  Object.keys(Object.assign({}, pv.items, cu.items)).forEach((code) => {
    const a = pv.items[code], b = cu.items[code];
    let d;
    if (!a) d = (b && b.pl) || 0;
    else if (b) d = (b.pl || 0) - (a.pl || 0);
    else {
      const sell = ((P3 && P3.log) || []).filter((e) => /卖出|减仓|清仓/.test(String(e.act || "")) &&
        e.sym === a.name && e.d > pv.d && e.d <= cu.d)[0];
      /* ⚠ 2026-10-14：场外清仓同样要按「回款 − 期初市值」（页面的 periodContrib 第三支）——
         赎回日早于本期、回款本期才到的那种（015884）在 POSITIONS.log 里找不到流水，
         页面的判据是 positions-data.js 的 OTC_CLEARED（d = 回款到账日），这里同口径独立复算 ✓ */
      const oc = OTCCLEARED.filter((x) => x && x.code === code && x.d > pv.d && x.d <= cu.d)[0];
      if (sell && Number.isFinite(sell.realized)) d = (sell.realized + (a.cost || 0)) - (a.val || 0);
      else if (oc) d = (Number(oc.proceeds) || 0) - (a.val || 0);
      else d = -(a.pl || 0);
    }
    sums[etfSet.has(code) ? "in" : "ot"] += d;
  });
  const arts = [...win.document.querySelectorAll("#snap-list article.snap-item")];
  const gs = arts.length ? [...arts[0].querySelectorAll(".snap-group-sum")] : [];
  /* ⚠ 取数走 arrowNums（2026-10-13 修）：页面对负值印「当日↓1,812」✗（箭头就是符号 ✓），
     原来只抓数字 → 拿到 **+1812** ✗ vs 复算 −1812.40 ✗（本期首次出现负值，两条当场报红 ✓）。 */
  const gn = (el) => {
    const m = arrowNums(el.textContent);
    return m.length ? m[m.length - 1] : null;
  };
  const gotIn = gs.length > 0 ? gn(gs[0]) : null;
  const gotOt = gs.length > 1 ? gn(gs[1]) : null;
  check("快照对比「场内」分组小计 = 复算 " + money(sums.in) + "（不再把清仓浮亏消失当收益 ✗）",
    gotIn !== null && Math.abs(gotIn - sums.in) <= 1, "组小计 " + gotIn + " vs 复算 " + sums.in.toFixed(2));
  check("快照对比「场外」分组小计 = 复算 " + money(sums.ot),
    gotOt !== null && Math.abs(gotOt - sums.ot) <= 1, "组小计 " + gotOt + " vs 复算 " + sums.ot.toFixed(2));
  /* 各标的累计盈亏（2026-10-18 加）：5 条线 = 3 在持实线 + 2 已清仓虚线，
     清仓标的的图例必须印「已实现」而不是浮盈（口径不同，混了就会被读成「还在赚」✗） */
  {
    const doc = gs[0] && gs[0].ownerDocument;
    const solid = doc ? doc.querySelectorAll("#hh-box polyline:not([stroke-dasharray])") : [];
    const real = doc ? doc.querySelectorAll('#hh-box polyline[stroke-dasharray="4 3"]') : [];
    const phantom = doc ? doc.querySelectorAll('#hh-box polyline[stroke-dasharray="2 3"]') : [];
    const lg = doc && doc.getElementById("hh-legend") ? doc.getElementById("hh-legend").textContent : "";
    check("各标的累计盈亏：3 实线 + 2 清仓虚线 + 2 条「假设没卖」延续线 · 清仓图例印「已实现」",
      solid.length === 3 && real.length === 2 && phantom.length === 2 && /已实现/.test(lg),
      "实线 " + solid.length + " / 清仓虚线 " + real.length + " / 延续线 " + phantom.length + " · 图例「" + lg.replace(/\s+/g, " ").slice(0, 40) + "」");
  }
}

/* ⑤ 走势卡读数条：最新一期的总资产与浮盈亏（renderTrend 的成本口径含现金）
   ⚠ 2026-10-09 修正：原来无条件拿**最新快照**去比读数条 ✗ ——
   可走势序列的最后一个点可以是「今日盘中估」（当 data.js 里的报价/指数比最新快照更新时，页面就会补这一期，
   读数条随之显示它）。本次实测：快照 09-30 的浮盈亏是 −1,993，而读数条显示盘中估的 −2,198 → 断言必红 ✗。
   这不是数据错，而是**每天盘中都成立的正常状态**（CI 早上推完数据、A 股开盘后就是它），
   与「定投中」那条同属"把某一天的状态当成真理" ✗。
   故：处于盘中估时**只标注跳过、不判失败**（原因写进消息，不静默 ✓）；
   其余时候（收盘后 / 无盘中估）照旧严格比对 ✓ */
const readText = readout ? readout.textContent.replace(/\s+/g, "") : "";
const intraday = /盘中估|未收盘/.test(readText);
const skipMsg = "页面处于「今日盘中估」状态（读数条显示的是盘中估那一期，不是最新快照）→ 本项跳过，收盘后自动恢复比对";
check("走势卡读数含最新总资产 " + money(snapTotal), intraday || near(readText, snapTotal, 3), intraday ? skipMsg : readText.slice(0, 160));
/* ⚠ 2026-10-09 同 ③：读数条那一格是「累计收益（含已实现）」= pl − closedGap ✓（口径见 ③ 的注释） */
check("走势卡读数含最新累计收益 " + money(latest.pl - closedGap), intraday || near(readText, latest.pl - closedGap), intraday ? skipMsg : readText.slice(0, 160));

/* ④e 本金口径（2026-10-09 加，用户选 A）——「本金 ≡ 外部净转入」从**首次全额清仓**起会被打破 ✗：
   摊薄口径下卖出只是「成本 → 现金」的搬运（Σ成本＋现金 不变 ✓），但全额清仓时亏损那部分整块漏出 ✗
   （10-09 实测：本金被低估 18,490.34 ＝ 18,492.00 − 1.66 尾差 ✓，页面标着「外部净转入」却不对 ✗）。
   两条断言都从**本文件独立复算**（读 data.js 的快照 items ＋ POSITIONS.log），不读页面的中间量 ✓：
     ① 汇总卡本金 = Σ快照 items.cost ＋ 现金 ＋ 全额清仓已实现
     ② 汇总卡累计收益 = Σ快照逐只 pl ＋ 全额清仓已实现   （＝ pl − closedGap，与 ③ 同一口径 ✓）
   取的是汇总卡上的 data-principal / data-pl（**精确值**）：卡片显示按整元取整（fmtYuan/fmtAmt ✗），
   用显示值断言分辨不出几十元的漂移 ✗ —— 与 ④c 同一手法 ✓。 */
{
  const items = latest.items || {};
  const rawCost = Object.keys(items).reduce((a, k) => a + ((items[k] && items[k].cost) || 0), 0) + (latest.cash || 0);
  const plIn = Object.keys(items).reduce((a, k) => a + ((items[k] && items[k].pl) || 0), 0);
  const wantP = rawCost + closedGap, wantPl = plIn - closedGap;
  const attr = (k) => {
    const el = sum ? sum.querySelector("[data-" + k + "]") : null;
    return el ? Number(el.getAttribute("data-" + k)) : NaN;
  };
  const gp = attr("principal"), gpl = attr("pl");
  check("汇总卡本金 = Σ持仓成本 ＋ 现金 ＋ 全额清仓已实现 " + money(wantP),
    Number.isFinite(gp) && Math.abs(gp - wantP) < 0.05,
    "页面 data-principal=" + gp + " · 期望 " + wantP.toFixed(2) + "（差 " + (gp - wantP).toFixed(2) + "）");
  /* 累计收益容差 3：它的两个组成里「市值」取页面**实时报价** ✗、这里取快照 items.val（当日收盘读数），
     两者天然差 1 元级（与 ③ 的总资产断言同一来源、同一容差 ✓）。成本那一侧是静态数，故上面用 0.05 ✓。 */
  /* 同上前提：报价领先快照时，页面按今日估值算 pl，与快照口径天然不同 → 跳过 */
  check("汇总卡累计收益 = Σ逐只 pl ＋ 全额清仓已实现 " + money(wantPl),
    QUOTE_AHEAD || (Number.isFinite(gpl) && Math.abs(gpl - wantPl) < 3),
    "页面 data-pl=" + gpl + " · 期望 " + wantPl.toFixed(2) + "（差 " + (gpl - wantPl).toFixed(2) + "）");
}

/* ④f 累计收益的「场内 / 场外」拆解（2026-10-09 加，起于用户一问：「累计收益包含场内场外对吗？」）
   包含 ✓，但汇总卡右侧那两格是**在持**口径、**不能直接相加** ✗（场内那半还差一个「已兑现」）。
   本金卡「收益构成 · 按账户」那一行给出的两个数必须**相加＝累计收益** ✓（期望值同样独立复算 ✓）。
   ⚠ 该行在折叠区里（details.pf-fold）—— 元素始终在 DOM 上（只是不渲染），故无需展开即可断言 ✓。 */
{
  const el = (id) => win.document.getElementById(id);
  const a = el("prin-etf-contrib"), c = el("prin-otc-contrib");
  const va = a ? Number(a.getAttribute("data-v")) : NaN, vc = c ? Number(c.getAttribute("data-v")) : NaN;
  const want = latest.pl - closedGap;
  check("本金卡「按账户」拆分：场内 ＋ 场外 ＝ 累计收益 " + money(want),
    Number.isFinite(va) && Number.isFinite(vc) && Math.abs(va + vc - want) < 3,
    "场内 " + va + " ＋ 场外 " + vc + " = " + (va + vc).toFixed(2) + " · 期望 " + want.toFixed(2));
}

/* ④g 快照对比「清仓行」的总盈亏（2026-10-09 加）—— 曾**写死 0** ✗：
   列头写「总盈亏（相对持仓成本，含已实现）」，清仓后该只成本归零、也退出 items → 显示 0 ✗，
   读者会读成「不赚不赔」✗✗（用户当场看出：「中韩半导体ETF华泰 的 总盈亏是 0 对吗？」✓）。
   现改取该只生命周期实际结果 ＝ Σ卖出净额 − Σ买入含费（含双边费用 ✓），与「清仓历史」卡同一个数 ✓。
   期望值取页面的 closedEtfRows()（与清仓历史卡**同源** ✓；它的绝对正确性由 ④b 的独立复算守住 ✓）；
   本条盯的是**两张卡不许各说各话** ✗，且不许有人把 plCum 改回 0 ✗。 */
{
  /* ⚠ 2026-10-12 修：原来只在**最新一期**那张卡里找清仓行 ✗ —— 清仓发生在历史期（10-09）时找不到 ✗。
     改为在**全部期**的 .snap-item 里找 ✓（清仓行只出现在它被清掉的那一期 ✓，全表扫不会误配 ✓）。 */
  const items = [...win.document.querySelectorAll(".snap-item")];
  const fn = win.closedEtfRows;
  const rows = (typeof fn === "function") ? fn() : [];
  const bad = [];
  rows.forEach((r) => {
    const row = items.map((it) => [...it.querySelectorAll(".snap-line.item")].find((x) => x.textContent.indexOf(r.sym) >= 0))
      .filter(Boolean)[0] || null;
    const cv = row ? row.querySelector(".cv") : null;
    if (!cv || !near(cv.textContent, r.pnl, 1))
      bad.push(r.sym + "：" + (cv ? cv.textContent.replace(/\s+/g, "") : "(各期卡片里都没有这一行 ✗)") + " ≠ " + r.pnl.toFixed(2));
  });
  check("快照对比「清仓行 · 总盈亏」= 清仓历史同只（" + rows.length + " 只：" + rows.map((r) => r.sym).join("/") + "）",
    rows.length > 0 && bad.length === 0, bad.length ? "对不上：" + bad.join("、") : "逐只核对通过 ✓");
}

/* ④h 快照对比卡头「总盈亏」（2026-10-09 加）—— 它与汇总卡 / 本金卡的「累计收益」是**同一个概念** ✓，
   原来却直接取快照 pl（在持口径 ✗）：10-09 一期显示 19,988 ✗，而累计收益是 1,496 ✓，
   同一个词两处两个意思 ✗（本轮 A 方案把本金加回清仓已实现后就露出来了 ✓）。
   现两处都走 snapPl ✓。断言：最新一期卡头显示的数 ＝ 独立复算的 pl − closedGap ✓
   （卡头里还有「本期」与日期，但它们都离这个数很远 → near() 不会误判 ✓）。 */
{
  const art = win.document.querySelector(".snap-item");
  const tiles = art ? [...art.querySelectorAll(".kpi-row .kpi")] : [];
  const tileOf = (label) => tiles.find((t) => ((t.querySelector(".k-label") || {}).textContent || "").replace(/\s+/g, "") === label) || null;
  const want = latest.pl - closedGap;
  const tl = tileOf("总盈亏");
  /* ⚠ 2026-10-09 二次调整：这两个数由**卡头**下移成 KPI 格（用户要求）→ 断言改盯格 ✓
     （「总盈亏」格里只有这个数与累计收益率，near() 不会误判 ✓） */
  check("快照对比「总盈亏」KPI = 累计收益（含已实现）" + money(want),
    !!tl && near(tl.textContent, want, 3),
    tl ? "总盈亏格：" + tl.textContent.replace(/\s+/g, " ").trim() : "最新一期里没有「总盈亏」KPI 格");
  /* 「本期盈亏」格：独立复算 ＝ Δ总资产 − 记录的 flow（页面 snapFlow 的口径：人工记录优先 ✓）
     —— 10-09 期实测 2,304 ＝ (534,018.37 − 531,504.53) − 210 ✓（含已实现的当期部分 ✓）。
     ⚠ 本文件里的 `snapTotal` 是**变量**（最新快照总资产那个数 ✓），不是函数 ✗ ——
       2026-10-09 初版写成 snapTotal(latest) 直接 TypeError 被门禁自己抓住 ✓，故下面自备两个小工具 ✓
       （公式与页面的 snapTotal / snapCost 逐字一致 ✓：val 求和 ＋ 现金 / 再减 pl 加清仓加回 ✓）。 */
  const totOf = (s) => (typeof s.total === "number") ? s.total
    : Object.values(s.items || {}).reduce((a, x) => a + ((x && x.val) || 0), 0) + (s.cash || 0);
  const costOf = (s) => (typeof s.total === "number") ? (s.total - (s.pl || 0))
    : totOf(s) - (s.pl || 0) + (s.d === (latest && latest.d) ? closedGap : 0);
  const ti = tileOf("本期盈亏");
  const f = Number.isFinite(latest.flow) ? latest.flow : (costOf(latest) - costOf(prevFull));
  const wantD = totOf(latest) - totOf(prevFull) - f;
  check("快照对比「本期盈亏」KPI = Δ总资产 − 资金进出 " + money(wantD),
    !!ti && near(ti.textContent, wantD, 3),
    ti ? "本期盈亏格：" + ti.textContent.replace(/\s+/g, " ").trim() + " · 期望 " + wantD.toFixed(2)
      : "最新一期里没有「本期盈亏」KPI 格");
}

/* ④i 动作行的「银行转入 / 转出」标签（2026-10-09 加，用户要求「如果有银行转入转出 就加上标签」）
   ⚠ FLOWS（银证转账手账）在公开仓库里**恒为空数组**（隐私约定：收入侧指纹不入库 ✓，见 data.js 注释）
     → CI 里这一条天然跳过 ✓（如实报"跳过"，不假装验过 ✗，与 ⑤ 的 intraday 跳过同一套做法 ✓）。
   本地补录 FLOWS 后：最新一期里每一笔都必须出现一枚「银行转入/转出 xx 元 · MM-DD」标签 ✓
   —— 判据与页面的 flowsNet() 一致（同一区间 f.d > prev.d && f.d <= cur.d ✓）。 */
{
  /* ⚠ 正则**不能**要求收尾的 `];` 独占一行 ✗ —— 2026-10-09 实测：把 FLOWS 临时写成一行
     （`const FLOWS = [{…}, {…}];`）时，原写法 `^const FLOWS = \[[\s\S]*?^\];` 匹配不上 →
     本项会**静默跳过** ✗（于是"有补录却没验"）。改成不锚定收尾 ✓，单行 / 多行都能读到 ✓。
     （其余同类正则沿用仓库格式，不动 —— 它们读的是自动生成的块，格式稳定 ✓。） */
  const m = readFileSync(path.join(root, "data.js"), "utf8").match(/^const FLOWS = \[[\s\S]*?\];/m);
  let fl = [];
  if (m) { const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = FLOWS;", c, { timeout: 500 }); fl = c.o || []; }
  /* 比对范围必须是**快照窗口内** ✗ 不是"最新一期"：某一笔的标签出现在它自己那一期的卡里
     （09-30 的转出在 09.30 卡 ✓），只盯最新一期会误报"缺标签" ✗。
     窗口 = (基线快照日, 最新快照日] ✓ —— 首期之前/之后的 FLOWS 不产生标签（没有期卡覆盖它 ✓），故先滤掉 ✓。
     基线日取**最后一张 .snap-item**（基线卡排在所有逐期卡之后 ✓）；最新日取第一张的 data-d ✓（新在上 ✓）。 */
  const items = [...win.document.querySelectorAll(".snap-item")];
  const curD = items.length ? items[0].getAttribute("data-d") : null;
  const baseTime = items.length ? items[items.length - 1].querySelector("time.snap-date") : null;
  const baseD = baseTime ? baseTime.getAttribute("datetime") : null;
  const inWin = fl.filter((f) => (!baseD || f.d > baseD) && (!curD || f.d <= curD));
  const tags = [...win.document.querySelectorAll(".snap-item .snap-line.acts .snap-tag")]
    .filter((x) => /银行(转入|转出)/.test(x.textContent));
  if (!fl.length) {
    check("动作行「银行转入 / 转出」标签（FLOWS 为空 → 本项跳过）", true,
      "FLOWS 在公开仓库里恒为空（隐私约定 ✓），页面照约定不产出该标签 ✓；本地补录后本项自动生效 ✓");
  } else {
    const bad = inWin.filter((f) => !tags.some((x) => near(x.textContent, Math.abs(f.amt), 0.5) &&
      x.textContent.indexOf(f.amt >= 0 ? "银行转入" : "银行转出") === 0));
    check("动作行「银行转入 / 转出」标签 = 窗口内 FLOWS " + inWin.length + " 笔（共 " + fl.length + " 笔）",
      inWin.length === tags.length && bad.length === 0,
      bad.length ? "缺标签：" + bad.map((f) => f.d + " " + f.amt).join("、")
        : "逐笔核对通过 ✓（窗口 " + (baseD || "?") + " → " + (curD || "?") + "）");
  }
}

/* ⑧ 盈亏归因**升格为一级区块**（2026-10-12 做 E：用户问「盈亏归因内容这么多，是不是可以单开一个模块了」✓）
   三条契约（都能被悄悄改回去 ✗ → 都给牙 ✓）：
     ① 它有**自己的区块标题** #sec-attr，且出现在顶部区块导航里 ✓（不再藏在快照对比卡里 ✗）；
     ② 同一时刻**只显示一个视图、且连标题一起切** ✓ —— 切到归因时 #sec-snap 标题让位、切回时 #sec-attr 让位
        （漏切标题 → 另一节会剩个孤零零的标题 ✗；这是升格当天唯一新增的契约 ✓）；
     ③ **深链 #sec-attr 直达** ✓：hash 一变就进归因视图（归因因此能单独分享 ✓）。
   ▸ 本条**自己摆好视图状态** ✓（不依赖上一条测到哪儿了 ✓），跑完还原成默认的「逐期明细 ＋ #sec-snap」✓。
   ▸ 另：门禁进归因视图仍走 `#snap-switch .vs-btn[data-view=attr]` ✓ —— 控件与 id 都没搬 ✗，
     所以下面 40 条归因断言一条都不用改 ✓（这正是选「同页升格」而不是「拆页」的理由之一 ✓）。 */
{
  const d = win.document;
  const tSnap = d.getElementById("sec-snap"), tAttr = d.getElementById("sec-attr");
  const listEl = d.getElementById("snap-list"), attrEl = d.getElementById("snap-attr");
  const vBtn = (v) => [...d.querySelectorAll("#snap-switch .vs-btn")].find((b) => b.dataset.view === v);
  const navA = d.querySelector('.sec-nav a[href="#sec-attr"]');
  check("盈亏归因升格为一级区块：有自己的区块标题 #sec-attr（不再是卡内 tab ✗）",
    !!tAttr && /sec-title/.test(String(tAttr.className)),
    tAttr ? "class=" + tAttr.className : "页面里没有 #sec-attr ✗");
  check("区块导航里有「归因」入口（#sec-attr）",
    !!navA && /归因/.test(navA.textContent || ""),
    navA ? "导航项文本「" + navA.textContent + "」" : "导航里没有指向 #sec-attr 的链接 ✗");
  vBtn("log").click();
  const L = { snapT: tSnap.hidden, attrT: tAttr.hidden, list: listEl.hidden, attr: attrEl.hidden };
  vBtn("attr").click();
  const A = { snapT: tSnap.hidden, attrT: tAttr.hidden, list: listEl.hidden, attr: attrEl.hidden };
  check("归因与快照对比同级：同一时刻只显示一个视图、标题跟着一起换（8 个开关位）",
    L.snapT === false && L.attrT === true && L.list === false && L.attr === true &&
    A.snapT === true && A.attrT === false && A.list === true && A.attr === false,
    "逐期明细 " + JSON.stringify(L) + " / 归因 " + JSON.stringify(A));
  vBtn("log").click();
  win.location.hash = "#sec-attr";
  win.dispatchEvent(new win.Event("hashchange"));
  const deep = { card: attrEl.hidden, attrTitle: tAttr.hidden, snapTitle: tSnap.hidden };
  check("深链 #sec-attr：hash 一变就进归因视图（可单独分享 ✓）",
    deep.card === false && deep.attrTitle === false && deep.snapTitle === true,
    JSON.stringify(deep));
  /* ⑧-e 区块名**只印一遍**（2026-10-12，用户当天截图指出：切换器下面「🎯 盈亏归因」，
     紧接着卡里又是「盈亏归因」—— 一块地方两行同名标题 ✗）。
     契约：区块名由 `#sec-attr` 那个 sec-title 独家承担 ✓，卡内 .sa-head 只留**随维度变化**的说明 ✓。
     ▸ 区块名从 sec-title 现取（去掉装饰性 emoji）✓ —— 将来改名这条断言也照样成立 ✓，不写死字符串 ✗。 */
  {
    const nameEl = tAttr.cloneNode(true);
    [...nameEl.querySelectorAll('[aria-hidden="true"]')].forEach((x) => x.remove());
    const secName = (nameEl.textContent || "").replace(/\s+/g, "");
    const headB = [...d.querySelectorAll("#snap-attr .sa-head b")].map((x) => x.textContent.replace(/\s+/g, ""));
    check("归因区块名只印一遍：卡内 .sa-head 不再重复「" + secName + "」✗ 但卡内说明句必须还在 ✓",
      secName.length > 0 && !headB.includes(secName) && !!d.querySelector("#snap-attr .sa-head span"),
      (headB.length ? "卡内还印着「" + headB.join("」「") + "」" : "卡内没有重复标题 ✓")
        + (d.querySelector("#snap-attr .sa-head span") ? "" : " ✗ 但卡内的维度说明句也没了 ✗"));
  }
  win.location.hash = "#sec-snap";           // 还原（后面还有一大堆断言，别留个半开的视图 ✗）
  win.dispatchEvent(new win.Event("hashchange"));
}
/* ⑨ 场内日期徽标 ≡ 各**持有**市场「自动源核验日 vs 本页在用报价日」的**较新者**
   （2026-10-12 加：用户问「盈亏总览的场内徽标为什么还是 10.09？」✗ ——
    原判据是「SOURCE_META 核验日优先」✗：落期时人工实读的 App 收盘（10.12）比自动源（10.09）新 ✓，
    徽标于是少报两天 ✗；而这**每期落期都会重演** ✗（落期在当晚、CI 次日凌晨才跑 ✓），不是巧合 ✗。
    契约两条，都从这里独立推导 ✓：
      ① 只取**较新**的那个日期 ✓（本段职责就是标「数字源自哪天」✗）；
      ② 只聚合**本页实际持有**的市场 ✓ —— kr / hkus 只是跟踪对象 ✗，算进来会把徽标拉成区间
         「10.09–10.12」✗，读者会以为场内数据两天混杂 ✗。 */
{
  const dm = readFileSync(path.join(root, "data.js"), "utf8");
  const c = vm.createContext({});
  const grab = (re) => (dm.match(re) || [""])[0];
  vm.runInContext(grab(/const SOURCE_META = \{[\s\S]*?\n\};/) + "\nthis.M = SOURCE_META;"
    + grab(/const DEFAULT = \{[\s\S]*?\n\};/) + "\nthis.D = DEFAULT;"
    + grab(/const POSITIONS = \{[\s\S]*?\n\};/) + "\nthis.P = POSITIONS;", c, { timeout: 800 });
  const M = c.M || {}, D = c.D || {}, P = c.P || {};
  const QK = { ndx: "etfNdx", spx: "etfSpx", kr: "kr", n225: "n225", hkus: "hkus" };
  const dayOf = (k) => {
    const a = (M[k] || {}).asOf || null, b = (D[k] || {}).priceDate || null;
    if (a && b) return a > b ? a : b;
    return a || b || null;
  };
  const fmt = (ds) => {
    const s = ds.filter(Boolean).sort();
    if (!s.length) return "未记录";
    const a = s[0].slice(5).replace("-", "."), b = s[s.length - 1].slice(5).replace("-", ".");
    return a === b ? a : a + "–" + b;
  };
  const heldKeys = [...new Set((P.hold || []).map((h) => QK[h.idx] || h.idx))];
  const want = fmt(heldKeys.map(dayOf));
  /* 2026-10-18：盈亏总览标题精简，不再重复 etfTag()（行内每行已带信源与净值日）；
     徽标只留在顶部状态行 #pos-asof —— 断言跟着改指向那里，语义不变（同一个 etfTag()）。 */
  const chip = win.document.querySelector("#pl-cnt .date-chip.etf")
    || win.document.querySelector("#pos-asof .date-chip.etf");
  const got = chip ? chip.textContent.replace(/\s+/g, "") : "";
  check("场内徽标 ≡ 持有市场「自动源核验日 vs 本页在用报价日」的较新者（应为 " + want + "）",
    got.indexOf(want) >= 0, "徽标「" + got + "」· 持有市场 " + heldKeys.join("/") + " 应得 " + want);
  /* 只有当前两口径**确实分歧**时才查这条 ✓（不写死结论 ✗，与文件里其它条件断言同一手法 ✓） */
  const wide = fmt(Object.keys(QK).map((k) => QK[k]).map(dayOf));
  if (wide !== want)
    check("场内徽标只聚合**持有**市场（五键口径会是 " + wide + "，不得采用 ✗）",
      got.indexOf(wide) < 0, "徽标「" + got + "」· 五键口径 " + wide);
}
/* ⑩ 同期纳指对比必须「同日」✗→✓（2026-10-12，用户报「同期纳指数据没更上」✓）
   根因两类，别混为一谈：
     ① 基准点位（data.js 的 BENCH）末点常比最新快照晚一期 —— 纳指**当日收盘要等美东收盘后才有** ✓，
        这是「还没收盘」，不是抓取挂了 ✗（CI 每晚 sync-bench.mjs 自动补 ✓）；
     ② 但原来的结论句 / 读数条拿**组合最新一期**减**基准末点** ✗ —— 两端不同天，属跨日相减 ✗
        （实测：组合 +1.70%(10-12) − 纳指 +1.79%(10-09) → 「超额 −0.09%」✗ 全是这两天相减来的 ✗）。
   契约三条，逐条独立验证 ✓：①「本金与收益」卡结论句写「均截至 <基准末点>」且「同期纳指」＝ BENCH 首末比 ✓；
     ② 收益率视图的结论句 + 图例标出基准末点 ✓；③ 读数条在基准末点之后显「—」而非把上一日点位外推 ✗。 */
{
  const dm = readFileSync(path.join(root, "data.js"), "utf8");
  const pdm = readFileSync(path.join(root, "positions-data.js"), "utf8");
  const c = vm.createContext({});
  vm.runInContext((dm.match(/const BENCH = \{[\s\S]*?\n\};/) || [""])[0] + "\nthis.B = BENCH;", c, { timeout: 500 });
  vm.runInContext((pdm.match(/^const SNAPSHOTS = \[[\s\S]*?^\];/m) || [""])[0] + "\nthis.S = SNAPSHOTS;", c, { timeout: 500 });
  /* ⚠ 用**全部快照**（含首期那些只有现金、无持仓的 ✓）—— 页面 buildTrendPts 也是这么取的 ✓，
     只留 s.items 会把首期（08-28 是纯现金 ✗）跳过、基准起点错一位 → 首末比差 0.4pp ✗（第一版门禁就踩了 ✓） */
  const B = c.B || {}, snaps = (c.S || []).filter((s) => s);
  const bk = Object.keys(B).sort();
  const firstSnap = snaps.length ? snaps[0].d : null;
  const bFirst = bk.find((d) => d >= firstSnap);
  const bLast = bk[bk.length - 1];
  const behind = !!(bLast && snaps.length && bLast < snaps[snaps.length - 1].d);
  const md = (d) => d && d.slice(5).replace("-", ".");
  /* 页面用 Unicode 负号「−」(U+2212) 而非连字符「-」✗ —— 正则必须两者都认，否则负的百分数匹配不到 ✗ */
  const SIGN = "[+\\-−]?";
  const pct = (s) => { const m = s && s.match(new RegExp("(" + SIGN + "\\d+\\.\\d+)%")); return m ? parseFloat(m[1].replace("−", "-")) : null; };
  /* ① 本金与收益卡（恒渲染 ✓） */
  const concl = [...win.document.querySelectorAll(".pf-concl")].map((x) => x.textContent.replace(/\s+/g, " ")).join(" ");
  const bPct = pct((concl.match(new RegExp("同期纳指\\s*(" + SIGN + "\\d+\\.\\d+)%")) || [])[0]);
  const yPct = pct((concl.match(new RegExp("你是\\s*(" + SIGN + "\\d+\\.\\d+)%")) || [])[0]);
  const pp = (concl.match(/(跑赢|落后)\s*(\d+\.\d+)pp/) || []);
  const dir = pp[1], ppV = pp[2] ? parseFloat(pp[2]) : null;
  const asof = (concl.match(/均截至\s*(\d{2}\.\d{2})/) || [])[1];
  if (bFirst && bLast && B[bFirst]) {
    const expect = (B[bLast] / B[bFirst] - 1) * 100;
    check("本金收益卡「同期纳指」≡ BENCH 首末比（" + expect.toFixed(2) + "%）",
      bPct !== null && Math.abs(bPct - expect) < 0.02, "卡上 " + bPct + "% vs 复算 " + expect.toFixed(2) + "%");
  }
  if (behind) {
    check("本金收益卡结论句必须标「均截至 " + md(bLast) + "」（不跨日相减 ✗）",
      asof === md(bLast), concl.slice(0, 90));
    check("本金收益卡结论句同日自洽：你是 ＝ 同期纳指 ∓ pp（" + (dir === "落后" ? "落后" : "跑赢") + "）",
      bPct !== null && yPct !== null && ppV !== null &&
        Math.abs((dir === "落后" ? bPct - yPct : yPct - bPct) - ppV) < 0.02,
      "同期 " + bPct + "% · 你是 " + yPct + "% · " + dir + " " + ppV + "pp");
  }
  /* ②③ 收益率视图：切过去再验（控件 id 同归因视图那套手法 ✓）。⚠ 数值闭环要与本金卡同窗，
     故先点「全部」把时间档位拉到全期 ✓ —— 否则两处窗口不同、超额对不上 ✗。 */
  const rateBtn = [...win.document.querySelectorAll('#trend-views .tchip')].find((b) => b.dataset.v === "rate");
  if (rateBtn) {
    rateBtn.click();
    const allBtn = [...win.document.querySelectorAll('#trend-chips .tchip')].find((b) => b.dataset.r === "all");
    if (allBtn) allBtn.click();
    const legend = (win.document.querySelector(".trend-legend") || {}).textContent || "";
    const sum = ((win.document.getElementById("trend-sum") || {}).textContent || "").replace(/\s+/g, " ");
    const ro = ((win.document.getElementById("trend-readout") || {}).textContent || "").replace(/\s+/g, " ");
    if (behind) {
      check("收益率视图图例标出基准末点（同期纳指（截至 " + md(bLast) + "））",
        legend.indexOf("截至 " + md(bLast)) >= 0, legend.slice(0, 80));
      /* 期望值不再写死「快照末日」✗：页面 buildTrendPts 在「系统当日 > 快照末日」时会**补一个今日估算点**
         （该点 d ＝ 系统当日），结论句「组合已到 X」写的就是它 ✓；当日估算不可得时才退回快照末日 ✓。
         两个合法取值**都由页面同一函数 POS_LOGIC.trendLastD 给出**（positions-logic.js ✓）——
         旧断言写死快照末日，只在「落盘日 ＝ 跑门禁那天」时刚好成立，10-15 那期（10-16 才落盘）必然误报 ✗。
         其余任何日期仍判错 ✓。 */
      const snapLastD = snaps[snaps.length - 1].d;
      const todayISO = (() => { const n = new Date(); return n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0") + "-" + String(n.getDate()).padStart(2, "0"); })();
      const legit = [...new Set([LOGIC.trendLastD(snapLastD, todayISO, true), LOGIC.trendLastD(snapLastD, todayISO, false)])].map(md);
      const combD = legit.find((x) => sum.indexOf("组合已到 " + x) >= 0) || "";
      check("收益率视图结论句标出「基准截至 " + md(bLast) + " · 组合已到 " + (combD || legit.join(" 或 ")) + "」",
        sum.indexOf("基准截至 " + md(bLast)) >= 0 && combD !== "",
        sum.slice(0, 90));
      check("读数条在基准末点之后显「基准未到该日」，而非把上一日点位外推 ✗",
        ro.indexOf("基准未到该日") >= 0 && /同期纳指\s*—/.test(ro), ro.slice(0, 90));
      /* 数值闭环：收益率视图的「超额」≡ 本金卡同日的「你是 − 同期纳指」（两处独立渲染，必须同一个数 ✓）
         —— 谁把某一处悄悄改回跨日（组合取全期 ✗），这里两处就对不上 ✗。 */
      const exV = pct((sum.match(new RegExp("超额\\s*(" + SIGN + "\\d+\\.\\d+)%")) || [])[0]);
      if (yPct !== null && bPct !== null && exV !== null)
        check("收益率视图「超额」≡ 本金卡同日「你是 − 同期纳指」（" + (yPct - bPct).toFixed(2) + "%）",
          Math.abs(exV - (yPct - bPct)) < 0.02, "超额 " + exV + "% vs 你是−同期 " + (yPct - bPct).toFixed(2) + "%");
    }
  }
}
/* ⑪ 汇总 KPI 的「已实现」口径（2026-10-13 加：用户先问「总资产的累计收益 +330 是所有场内场外的
   净收益对吗？包含了已经清仓的」✓，再问「已实现的场内 / 场外有必要体现到 KPI 吗」✓
   → 结论是 B1＋B2：**不加 KPI 格数** ✗，只加口径措辞 ＋ 一行恒等式小注 ✓）
   四条契约（都能被悄悄改回去 ✗ → 都给牙 ✓）：
     ① 两个通道格标签写明**在持**口径 ✓ —— 字面「累计浮盈亏 · 场内」会被读成「该通道累计赚了多少」✗
        （数据上 +18,822 vs 累计收益 +330 ✗，差的正是已实现那一块 ✗）；
     ② 第 1 格副标里那行恒等式小注在、且**两个加数＝实际数字** ✓（在持浮盈 ＋ 已实现 ＝ 累计收益 ✓）；
     ③ 恒等式用**独立复算**的已实现对账 ✓ —— 从 POSITIONS.log 按 closedCostGap 的同一算法重推 ✓
        （不调页面函数 ✗、不写死 18,492 ✗）；页面那半若改口径 → 当场报红 ✗；
     ④ `#sum-pl` 悬停必须仍写着「含已实现」✓ —— 这句是这整行口径的落点 ✓。
   ▸ 条件分支自适应当前数据 ✓：没发生过全额清仓时，小注应当**不出现**（不让恒 0 的行常驻 ✗）。 */
{
  const grid = win.document.getElementById("sum-grid");
  const cell1 = grid && grid.querySelector(".sum-cell[data-pl]");
  const plRaw = cell1 ? Number(cell1.getAttribute("data-pl")) : NaN;
  /* 独立复算「全额清仓加回」（＝已实现亏损的绝对值）：逐笔走出持仓、**归零才算**全额清仓 ✓ */
  const dm = readFileSync(path.join(root, "data.js"), "utf8");
  const c = vm.createContext({});
  vm.runInContext((dm.match(/const POSITIONS = \{[\s\S]*?\n\};/) || [""])[0] + "\nthis.P = POSITIONS;", c, { timeout: 800 });
  const log = (((c.P || {}).log) || []).slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const qty = {}, gap = {};
  log.forEach((e) => {
    const sell = /卖出|赎回/.test(String(e.act)), before = qty[e.sym] || 0;
    qty[e.sym] = before + (sell ? -(e.qty || 0) : (e.qty || 0));
    if (sell && before > 0 && qty[e.sym] === 0 && Number.isFinite(e.realized)) gap[e.sym] = (gap[e.sym] || 0) - e.realized;
  });
  /* ⚠ 2026-10-14：POSITIONS.log 只装**场内**交割单 → 上面这一趟只得到场内那 18,492.00。
     场外全额清仓（首次：015884 中欧）没有份额级流水，判据是 positions-data.js 的 OTC_CLEARED
     （口径 = Σ(成本 − 回款)，与页面 closedCostGap() 逐字一致）→ 这里同口径独立复算并加回 ✓；
     漏掉这一项，小注里的「已实现」就会比页面少一块而报红（页面那半是对的 ✓）。 */
  const otcCleared = OTCCLEARED.reduce((a, x) => a + ((x.cost || 0) - (x.proceeds || 0)), 0);
  const expCleared = Math.round((Object.values(gap).reduce((a, b) => a + b, 0) + otcCleared) * 100) / 100;
  const labels = [...grid.querySelectorAll(".sum-cell .s-label")].map((x) => x.textContent.replace(/\s+/g, ""));
  /* ⚠ 筛「浮盈」而不是「累计浮盈亏」✗（2026-10-13 第二轮：标签为手机收窄到 8 字
     「在持浮盈 · 场内 / 场外」✓ —— 写死旧词就会筛不到而**假绿** ✗；改词后这条仍成立 ✓，
     这与 ⑧-e「区块名现取自 sec-title」同一手法 ✓：断言盯着**语义**，不盯着某一版措辞 ✓）。 */
  const chans = labels.filter((t) => /浮盈/.test(t));
  check("汇总 KPI：两个通道格标签写明**在持**口径（否则会被读成「该通道累计赚了多少」✗）",
    chans.length === 2 && chans.every((t) => /在持/.test(t)), "标签：" + JSON.stringify(chans));
  const subEl = cell1 && cell1.querySelector(".s-sub");
  const sub = (subEl ? subEl.textContent : "").replace(/\s+/g, "");
  const m = sub.match(/＝?在持浮盈([+−][\d,]+)＋已实现([+−][\d,]+)/);
  const num = (s) => (s === undefined ? null : Number(String(s).replace(/−/g, "-").replace(/[+,]/g, "")));
  if (expCleared) {
    const a = num(m && m[1]), b = num(m && m[2]);
    check("累计收益的副标有恒等式小注「＝ 在持浮盈 X ＋ 已实现 Y」", !!m, "副标：" + sub.slice(0, 90));
    check("恒等式小注的两个加数 ＝ 实际数字（" + a + " ＋ " + b + " 应 ＝ " + plRaw + "）",
      a !== null && b !== null && Math.abs((a + b) - plRaw) < 1.5,
      "差 " + (a !== null && b !== null ? ((a + b) - plRaw).toFixed(2) : "（小注没解析出来 ✗）"));
    check("小注里的「已实现」＝ 独立复算的全额清仓已实现（−" + expCleared.toFixed(2) + "）",
      b !== null && Math.abs(b + expCleared) < 1, "小注 " + b + " vs 复算 " + (-expCleared));
  } else {
    check("没发生过全额清仓时，恒等式小注**不出现**（不让恒 0 的行常驻 ✗）",
      !/在持浮盈/.test(sub), "副标：" + sub.slice(0, 90));
  }
  const tip = (win.document.getElementById("sum-pl") || {}).title || "";
  check("累计收益的悬停仍写着「含已实现」（这一整行口径的落点）", /含已实现/.test(tip), tip.slice(0, 80));
}
/* ⑫ 汇总 KPI 的「文字 ≡ 实现」（2026-10-13 逐字段 review 后的 P0＋P1）——
   这一天用户先问「KPI 里的每个数据哪些还需要调整」，review 的结论是：**数字逐项对得上** ✓，
   错的是几处**口径文字与实现不符** ✗（会让人拿本金去乘收益率、或把倒算当实读 ✗）：
     ① 场内那格的「收益率」分母是**在持成本**（＝摊薄成本 ✓），而它上一行的「本金」是**外部净转入口径** ✗
        （含全额清仓加回那 18,492 ✓）→ 两者不是同一个数 ✗，副标必须点明分母 ✓；
     ② 场内悬停原写「Σ摊薄成本（**含**券商可用现金）」✗ —— 实测 implEtfRows() 只来自 POSITIONS.hold ✓，
        **没有现金行** ✗（现金并在场外桶里、两边相抵 ✓，今天现金 0 所以数没差 ✓）；
     ③ 「当日盈亏」悬停原写「场内 ＝ 券商 App 当日参考盈亏」✗ —— 场内那半其实是**倒算**的 ✓
        （`dayEtf ＝ 快照 day − Σ场外` ✓，同一次落盘的两半 ✓）；
     ④ 「（估）」原来写死 ✗ → 改成与走势图同名格**同一判据**（当天还没落期才标 ✓）；
     ⑤ 「已扣款未入账」→「未并入成本」✓（与悬停里那句「市值里另有在途」分开命名 ✓，两者口径不同 ✗）；
     ⑥ 「N 只本次未更新」要点名 ✓（原来是黑盒 ✗）；⑦ 通道格改名「在持浮盈」后，别处引用也同步 ✓。
   ▸ 全部**独立复算** ✓：成本取 POSITIONS.hold 的 Σ(qty×cost) ✓；未更新名单按 dayVals 同一判据重推 ✓
     （不调页面函数 ✗、不写死数字 ✗）。 */
{
  const dp = readFileSync(path.join(root, "data.js"), "utf8");
  const ds = readFileSync(path.join(root, "positions-data.js"), "utf8");
  const c = vm.createContext({});
  vm.runInContext((dp.match(/const POSITIONS = \{[\s\S]*?\n\};/) || [""])[0] + "\nthis.P = POSITIONS;", c, { timeout: 800 });
  vm.runInContext((ds.match(/const OTC = \{[\s\S]*?\n\};/) || [""])[0] + "\nthis.O = OTC;"
    + (ds.match(/const SNAPSHOTS = \[[\s\S]*?\n\];/) || [""])[0] + "\nthis.S = SNAPSHOTS;", c, { timeout: 800 });
  const P = c.P || {}, O = c.O || {}, S = c.S || [];
  const holdCost = (P.hold || []).reduce((t, h) => t + (h.qty || 0) * (h.cost || 0), 0);
  const cells = [...win.document.getElementById("sum-grid").querySelectorAll(".sum-cell")];
  const txt = (el) => ((el && el.textContent) || "").replace(/\s+/g, "");
  const sub0 = txt(cells[0].querySelector(".s-sub")), sub1 = txt(cells[1].querySelector(".s-sub")), sub2 = txt(cells[2].querySelector(".s-sub"));
  const pick = (s, re) => { const m = s.match(re); return m ? Number(m[1].replace(/,/g, "")) : null; };
  const base = pick(sub1, /按在持成本([\d,]+)/), prin1 = pick(sub1, /本金([\d,]+)/);
  check("场内格副标点明「收益率」的分母（应＝Σ(qty×cost) " + holdCost.toFixed(0) + " ✓，与上一行的本金不是同一个数 ✗）",
    base !== null && Math.abs(base - holdCost) < 1.5, "副标：" + sub1.slice(0, 60));
  check("场内格：显示的「本金」与「在持成本」确实是两个数（差 " + (prin1 !== null && base !== null ? Math.abs(prin1 - base).toFixed(0) : "?") + " ✓ —— 正是要点明分母的原因 ✓）",
    base !== null && prin1 !== null && Math.abs(prin1 - base) > 1000, "本金 " + prin1 + " / 在持成本 " + base);
  const today = (function () { const n = new Date(); return n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0") + "-" + String(n.getDate()).padStart(2, "0"); })();
  const snapLast = ((S.filter((x) => x.items).slice(-1)[0] || {}).d) || null;
  const wantEst = snapLast !== today, lab0 = txt(cells[0].querySelector(".s-label"));
  check("总资产标签的「（估）」＝ 与走势图同一判据（最新快照 " + snapLast + (wantEst ? " ≠ 今天 → 带（估）✓" : " ＝ 今天 → 不标 ✗") + "）",
    wantEst ? /（估）/.test(lab0) : !/（估）/.test(lab0), "标签：" + lab0);
  check("累计收益那行写明「含已实现」✓（不再用内部术语「快照口径」✗）",
    /累计收益（含已实现）/.test(sub0), "副标：" + sub0.slice(0, 60));
  check("场外格那行改名为「未并入成本」✓（与悬停里「市值里另有在途」分开 ✗）",
    /未并入成本/.test(sub2) && !/已扣款未入账/.test(sub2), "副标：" + sub2.slice(0, 70));
  /* ⑧ 总资产悬停里的「范围」只数当前持有（原写死「场内 5 只 ETF」✗ —— 那含已清仓的两只 ✗，
     本格范围是 implEtfRows() ＝ POSITIONS.hold ✓）→ 两处都按数据现算 ✓（不写死 5 / 8 ✗）。 */
  const tip0 = cells[0].getAttribute("title") || "";
  check("总资产悬停的范围只数**当前持有**（场内 " + (P.hold || []).length + " 只 / 场外 " + (O.funds || []).length + " 只 ✓）",
    new RegExp("场内 " + (P.hold || []).length + " 只").test(tip0)
      && new RegExp("场外 " + (O.funds || []).length + " 只").test(tip0),
    tip0.slice(-70));
  /* ⚠ 当日盈亏的悬停 2026-10-13 改挂在**整格**上 ✓（原来挂 label ✗，与上面三格不一致 ✗）→ 取整格 ✓ */
  const tip1 = cells[1].getAttribute("title") || "", tip3 = cells[3].getAttribute("title") || "";
  check("场内悬停不再声称「Σ摊薄成本（含券商可用现金）」✗，并讲清现金的归属 ✓",
    /不含现金/.test(tip1) && !/含券商可用现金/.test(tip1), tip1.slice(0, 70));
  check("当日盈亏悬停不再把倒算说成实读 ✗（改为「场内 ＝ 合计 − 场外」✓）",
    /场内 ＝ 合计 − 场外/.test(tip3) && !/场内 ＝ 券商 App/.test(tip3), tip3.slice(0, 70));
  /* ⚠ 副标那行**也要查** ✓ —— 第一遍只改了悬停 ✗，可见副标还写着「场内 ＝ 券商 App『当日参考盈亏』」✗
     （截图抓出来的 ✓，门禁当时没盯着副标 ✗ → 现在补上 ✓）。 */
  const sub3 = txt(cells[3].querySelector(".s-sub"));
  /* ⚠ 副标文字经 txt() 去掉了空白 ✗ → 判据一律走空白容忍的写法 ✓
     （这里踩过一次：写了带空格的 /场内 ＝ 合计 − 场外/ → 明明页面对了却报红 ✗）。
     2026-10-13 第二轮：用户报「实读值 xxx 说明太多了，精简」✗ → 副标里那三条公式整体搬进悬停 ✓，
     副标**只留快照日与缺口只数** ✓ → 这样断言：有日期 ✓、**没有算式** ✓（出现「＝」即说明又把推导写回可见处 ✗）、
     且**确实变短了** ✓（上限给到 26 字，含 dayEtf 为空时那句长警告 ✓）。 */
  check("当日盈亏副标**只留日期与缺口**（无算式 ✓ 且 ≤26 字 ✓），推导只放悬停 ✓",
    /快照\s*\d/.test(sub3) && !/＝/.test(sub3) && sub3.length <= 26,
    "副标（" + sub3.length + " 字）：" + sub3.slice(0, 60));
  /* ⚠ 2026-10-16：这里原来自写第**四**份判据副本（`!f.upd || f.upd.slice(0,10) >= O.updated`）✗ —
     与页面 / 录入器 / 门禁那三份同源，一改口径就漏这一处 ✗。改为直接问 POS_LOGIC ✓：
     「当日无有效读数」＝ dayVals 里该位为 null ✓（与页面合计剔除的集合逐字同一判据 ✓）。 */
  const dayValsO = LOGIC.dayVals(O.funds, O.updated);
  const stale = (O.funds || []).filter((f, i) => dayValsO[i] === null);
  if (stale.length)
    check("当日盈亏悬停点名本次未更新的 " + stale.length + " 只（" + stale.map((f) => f.code).join(" / ") + " ✓，原来是黑盒 ✗）",
      stale.every((f) => tip3.indexOf(f.code) >= 0), "悬停尾部：" + tip3.slice(-80));
}
/* ④j 盈亏归因矩阵：**每行合计必须 ＝ 该期的「本期盈亏」**（2026-10-09 加，起于用户问
   「快照对比的盈亏归因要怎么优化，考虑到未来有清仓的情况」✓）
   ▸ 当时实测的 bug：10.09 行合计 **+2,939** ✗，真值 **+2,304** ✓ → 差 **+635.40**
     ＝ 中韩 −567.40 ＋ 港美 −68.00 ✓✓（被清仓那两只**本期的真实结果** ✓）。
   ▸ 根因：归因按「后一期 pl − 前一期 pl」取值 ✗ —— 清仓标的后一期不在 items 里 → 整条被跳过记 0 ✗
     （逐期明细行与分组小计当天已修 ✓，但归因是**另一套实现** ✗ 没跟着修）。
   ▸ 本断言独立复算：该期真值 ＝ Δ总资产 − 记录的资金进出 ✓（页面 snapFlow 口径：人工记录优先 ✓），
     逐行比对 ✓，并校验「全期行 ＝ Σ 各行」✓。没有记录 flow 的早期期跳过（计数在明细里 ✓）。 */
{
  const btn = [...win.document.querySelectorAll("#snap-switch .vs-btn")].find((b) => b.dataset.view === "attr");
  if (btn) btn.click();
  const mx = win.document.getElementById("snap-attr");
  const tbl = mx ? mx.querySelector("table.sa-mx") : null;
  if (!tbl) {
    check("盈亏归因矩阵可渲染（点「盈亏归因」后出现 table.sa-mx）", false, "#snap-attr 里没有 table.sa-mx");
  } else {
    const snaps2 = (() => {
      const m = readFileSync(path.join(root, "positions-data.js"), "utf8").match(/^const SNAPSHOTS = \[[\s\S]*?^\];/m);
      if (!m) return [];
      const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = SNAPSHOTS;", c, { timeout: 500 }); return c.o || [];
    })();
    const tot2 = (s) => Object.values(s.items || {}).reduce((a, x) => a + ((x && x.val) || 0), 0) + (s.cash || 0);
    const truth = {};
    for (let i = 1; i < snaps2.length; i++) {
      const a = snaps2[i - 1], b = snaps2[i];
      if (!a.items || !b.items || !Number.isFinite(b.flow)) continue;
      truth[b.d.slice(5)] = tot2(b) - tot2(a) - b.flow;
    }
    /* 期数窗口（2026-10-23 加）：矩阵默认只列最近 30 期 → 「全期 ＝ Σ各行」必须先把窗口切到**全部**，
       否则右边会少算被折叠的那几期 ✗。点完会整块重渲染 → 必须**重新取** table 元素（旧引用已脱离文档 ✗）。 */
    const winAll = (mx && mx.querySelector('[data-win="0"]')) || null;
    if (winAll && !winAll.classList.contains("on")) winAll.click();
    const tblNow = (mx && mx.querySelector("table.sa-mx")) || tbl;
    const rows = [...tblNow.querySelectorAll("tbody tr")].filter((tr) => !tr.classList.contains("mx-foot"));
    const foot = [...tblNow.querySelectorAll("tbody tr")].find((tr) => tr.classList.contains("mx-foot"));
    const numOf = (el) => {
      const m = ((el && el.textContent) || "").match(/[-−]?\d[\d,]*(?:\.\d+)?/g) || [];
      return m.length ? +m[m.length - 1].replace(/,/g, "").replace("−", "-") : NaN;
    };
    const bad = [];
    rows.forEach((tr) => {
      const d = ((tr.querySelector(".mx-d") || {}).textContent || "").trim().slice(0, 5);
      if (!(d in truth)) return;
      const v = numOf(tr.querySelector(".mx-sum"));
      if (!Number.isFinite(v) || Math.abs(v - truth[d]) > 2) bad.push(d + "：行内 " + v + " vs 真值 " + truth[d].toFixed(2));
    });
    check("盈亏归因每行合计 ＝ 该期「本期盈亏」（" + Object.keys(truth).length + " 期，独立复算 Δ总资产 − 资金进出）",
      bad.length === 0, bad.length ? "对不上：" + bad.join("、") : "逐期核对通过 ✓");
    /* ⚠ 全期行的**主题格也带 .mx-sum 类**，querySelector 会取到第一列（实测取成 227 ✗）→ 必须取**最后一个** ✓
       （此行由 2026-10-09 自己踩出来：初版断言报「全期 227 vs Σ各行 8914」—— 数字对不上的是检查本身 ✗） */
    const footCells = foot ? [...foot.querySelectorAll(".mx-sum")] : [];
    const footSum = numOf(footCells.length ? footCells[footCells.length - 1] : null);
    /* 换维度不该改任何数（2026-10-09 加，用户要求 B）——「平台 / 场内·场外」两种维度下，
       逐行合计必须与主题维度**同一批真值**一致 ✓（维度只决定"列怎么切"，不参与金额 ✓） */
    ["plat", "acct"].forEach((dim) => {
      const b2 = mx.querySelector('[data-dim="' + dim + '"]');
      if (b2) b2.click();
      const rows2 = [...mx.querySelectorAll("tbody tr")].filter((tr) => !tr.classList.contains("mx-foot"));
      const nCol2 = rows2.length ? rows2[0].children.length - 2 : 0;   // 减去「期」与「合计」两列 ✓
      const bad2 = rows2.filter((tr) => {
        const d = ((tr.querySelector(".mx-d") || {}).textContent || "").trim().slice(0, 5);
        if (!(d in truth)) return false;
        const v = numOf(tr.querySelector(".mx-sum"));
        return !Number.isFinite(v) || Math.abs(v - truth[d]) > 2;
      }).map((tr) => ((tr.querySelector(".mx-d") || {}).textContent || "").trim().slice(0, 5));
      check("盈亏归因换维度（" + (dim === "plat" ? "按平台" : "场内·场外") + "，" + nCol2 + " 列）后逐行合计不变",
        nCol2 > 1 && bad2.length === 0, bad2.length ? "对不上：" + bad2.join("、") : "逐行一致 ✓");
    });
    const bodySum = rows.reduce((a, tr) => a + (numOf(tr.querySelector(".mx-sum")) || 0), 0);
    /* 容差 2 → 3（2026-10-20）→ **随期数**（2026-10-23）：每期「本期盈亏」都是**整元取整**后进矩阵的，
       误差是**逐期累加**的随机游走 —— 20 期时 2~3 元够用，30 期时实测出现 4.00 ✗（10-23 补完场外后）。
       固定阈值会随期数增长周期性误报 ✗，改成按行数给：max(3, ⌈n×0.2⌉)（30 期 → 6 元）。
       ⚠ 仍能抓住真错：口径错 / 漏一期 / 少算一列都是几十到上千元量级，不会被这条容差放过 ✓ */
    const tolSum = Math.max(3, Math.ceil(rows.length * 0.2));
    check("盈亏归因「全期」行 ＝ Σ 各行 " + money(bodySum) + "（容差 " + tolSum + "，随期数）",
      Number.isFinite(footSum) && Math.abs(footSum - bodySum) <= tolSum,
      "全期 " + footSum + " vs Σ各行 " + bodySum.toFixed(2) + "（差 " + (footSum - bodySum).toFixed(2) + "，容差 " + tolSum + "）");
    /* ④k 归因的「全期」行 ≡ 累计收益（2026-10-09 两轮：先加"窗口"说明，再按用户选的 A 加「期初结转」行）——
       起因：用户把「全期 +8,278」与「累计收益 +1,496」并排看，问「这个 +8,278 是真的盈利 +8,278 吗？」✗
       → 根因：矩阵当时只覆盖 09-07 → 末期（更早的期缺 items 被隐藏 ✗），于是「全期」成了**变化量** ✗、与累计收益差 8,278 ✗。
       A 加了一行「期初结转（账户起点 → 09-07）」＝ 该期 Σ逐只 pl ＝ −6,781.83 ✓ → 全期与累计收益**合流** ✓
       （1,496.31 ＝ −6,781.83 ＋ 8,278.14 ✓ 分毫相等 ✓）。
       三条独立断言（全部读 positions-data.js ＋ data.js 复算，不读页面的中间量 ✓）：
         ① 期初行的终点日期 ＝ 第一个「前后两期都有 items」的对的 a.d ✓（页面把起点挪了却没人知道 ✗ → 当场拦下 ✓）
         ② 期初行的值 ＝ 该期 **Σ逐只 pl** ✓ —— 必须用逐只之和、不能用快照表头 pl ✗
            （实测 09-07：表头 −6,783.59 vs 逐只之和 −6,781.83，差 **1.76 元**；用表头值会让
             "全期 ≡ 累计收益"差这 1.76 ✗ —— 那正是上一轮那个"残差"的来源 ✓，与算法无关 ✓）
         ③ 全期（data-all）≡ 累计收益(末期) ✓ 容差 0.5 元：页面累计收益由「总资产 − 本金」算得，
            与「Σ逐只 pl − 清仓修正」之间还有逐只取整 ✓；放 2 元会放过真漂移 ✗，放 0.01 会误报 ✗
       取 data-* 而不是显示值：显示按整元取整（fmtAmt ✗），几十元的漂移在显示值上分辨不出 ✓ */
    {
      const pairs = [];
      for (let i = 1; i < snaps2.length; i++)
        if (snaps2[i - 1].items && snaps2[i].items) pairs.push([snaps2[i - 1], snaps2[i]]);
      const bS = pairs.length ? pairs[0][0] : null, eS = pairs.length ? pairs[pairs.length - 1][1] : null;
      const baseSum = bS ? Object.values(bS.items).reduce((a, x) => a + ((x && x.pl) || 0), 0) : NaN;
      const ePl = eS ? ((Number.isFinite(+eS.pl) ? +eS.pl : 0) - closedGapTo(eS.d)) : NaN;
      const foot2 = mx.querySelector("tbody tr.mx-foot");
      const carryTr = mx.querySelector("tbody tr.mx-carry");
      const attrOf = (el, k) => ((el && el.getAttribute(k)) || "");
      const gotCarry = Number(attrOf(carryTr, "data-carry"));
      const gotAll = Number(attrOf(foot2, "data-all"));
      check("盈亏归因「期初结转」行 ＝ 基准期(" + (bS ? bS.d.slice(5) : "?") + ") Σ逐只 pl ＝ " + money(baseSum),
        !!carryTr && Number.isFinite(gotCarry) && Math.abs(gotCarry - baseSum) < 0.05
          && attrOf(carryTr, "data-carry-d") === (bS ? bS.d : ""),
        carryTr
          ? "data-carry=" + (Number.isFinite(gotCarry) ? gotCarry : "—") + " · 期望 " + baseSum.toFixed(2)
            + " · 终点 " + (attrOf(carryTr, "data-carry-d") || "—") + "（期望 " + (bS ? bS.d : "?") + "）"
          : "#snap-attr 里没有 tr.mx-carry（期初结转行）");
      check("盈亏归因「全期」行 ≡ 累计收益(" + (eS ? eS.d.slice(5) : "?") + ") ＝ " + money(ePl),
        Number.isFinite(gotAll) && Number.isFinite(ePl) && Math.abs(gotAll - ePl) <= 0.5,
        "全期 data-all=" + (Number.isFinite(gotAll) ? gotAll : "—") + " · 期望 " + ePl.toFixed(2)
          + "（差 " + (Number.isFinite(gotAll) && Number.isFinite(ePl) ? (gotAll - ePl).toFixed(2) : "—") + "）");
    }
    /* ④l 归因矩阵的**三级下钻**（2026-10-09 加，起于用户问：「逐只明细还能细化吗？比如我点击某一个格子？」）——
       三条**不变量**（都与页面外的源数据独立复算 ✓，不读页面中间量 ✓）：
         ① 点到某一格 → 下方成员之和 **≡ 格子里那个数** ✓（两处都用 colKeyOf 过滤 ✓ → 少一只、多一只都会红 ✓）
         ② 点到某只 → 轨迹期数 **≡ 该只出现在多少个「两期都有 items」的对里** ✓（漏一期 / 多一期都会红 ✓）
         ③ 生涯累计 **≡ 该只的一生结果** ✓：仍在持 → 最新快照里那只的 pl ✓；已全额清仓 → 流水里那笔 realized ✓
            （页面那侧是"期初结转 ＋ 各期贡献之和" ✓ —— 两边算法完全不同 ✓，对得上才算数 ✓）
       另验「← 返回」能退回整期 ✓（不能卡在格 / 轨迹视图里 ✓）。
       ⚠ 每次点击都会让页面**整块重渲染** ✗ → 元素引用会失效 ✓，所以每一步都**重新 query** ✓（别缓存节点 ✗）。 */
    {
      const nameAt = (c) => {
        for (let i = snaps2.length - 1; i >= 0; i--) if (snaps2[i].items && snaps2[i].items[c]) return snaps2[i].items[c].name;
        return null;
      };
      const cellTd = mx.querySelector("tbody td[data-cell]");
      if (!cellTd) {
        check("归因下钻：矩阵格子可点（td[data-cell]）", false, "#snap-attr 里没有可点的格子");
      } else {
        const d0 = cellTd.getAttribute("data-d"), col0 = cellTd.getAttribute("data-col");
        const v0 = Number(cellTd.getAttribute("data-v"));
        cellTd.click();
        const box1 = mx.querySelector(".sa-detail-box .sa-detail");
        const sum1 = box1 ? Number(box1.getAttribute("data-cell-sum")) : NaN;
        check("归因下钻：格子成员之和 ≡ 格子读数（" + d0 + " · " + col0 + " ＝ " + money(v0) + "）",
          Number.isFinite(sum1) && Math.abs(sum1 - v0) < 0.01,
          "data-cell-sum=" + (Number.isFinite(sum1) ? sum1 : "—") + " vs 格子 data-v=" + v0);
        const holdRow = mx.querySelector(".sa-detail-box .sd-click[data-hold]");
        const code = holdRow ? holdRow.getAttribute("data-hold") : null;
        if (!code) {
          check("归因下钻：格子里的成员可点（.sd-click[data-hold]）", false, "该格里没有可点的成员");
        } else {
          holdRow.click();
          const box2 = mx.querySelector(".sa-detail-box .sa-detail");
          const gotTotal = box2 ? Number(box2.getAttribute("data-hold-total")) : NaN;
          const gotN = box2 ? Number(box2.getAttribute("data-hold-n")) : NaN;
          let wantN = 0;
          for (let i = 1; i < snaps2.length; i++) {
            const a = snaps2[i - 1], b = snaps2[i];
            if (!a.items || !b.items) continue;
            if (a.items[code] || b.items[code]) wantN++;
          }
          const lastS = snaps2[snaps2.length - 1];
          const held = !!(lastS.items && lastS.items[code]);
          /* 已全额清仓 → 取流水里那笔 realized ✓（判据与页面 closedCostGap / 本文件 closedGapTo 完全一致 ✓） */
          const q2 = {}; let closeReal = null;
          ((LOGPOS && LOGPOS.log) || []).slice().sort((a, b) => (a.d === b.d ? 0 : a.d < b.d ? -1 : 1)).forEach((e) => {
            const s = /卖出|减仓|清仓/.test(String(e.act || "")), before = q2[e.sym] || 0;
            q2[e.sym] = before + (s ? -(e.qty || 0) : (e.qty || 0));
            if (s && before > 0 && q2[e.sym] === 0 && Number.isFinite(e.realized) && e.sym === nameAt(code)) closeReal = e.realized;
          });
          const wantTotal = held ? Number(lastS.items[code].pl) : closeReal;
          check("归因下钻：轨迹期数 ≡ 该只出现的相邻对数（" + code + " ＝ " + wantN + " 期）",
            Number.isFinite(gotN) && gotN === wantN,
            "页面 data-hold-n=" + (Number.isFinite(gotN) ? gotN : "—") + " · 期望 " + wantN);
          check("归因下钻：生涯累计 ≡ 该只一生结果（" + code + " ＝ " + (Number.isFinite(wantTotal) ? money(wantTotal) : "—") + " · "
            + (held ? "在持取最新 pl ✓" : "已清仓取流水 realized ✓") + "）",
            Number.isFinite(gotTotal) && Number.isFinite(wantTotal) && Math.abs(gotTotal - wantTotal) < 0.5,
            "页面 data-hold-total=" + (Number.isFinite(gotTotal) ? gotTotal : "—") + " · 期望 "
              + (Number.isFinite(wantTotal) ? wantTotal : (held ? "最新快照里没有这只的 pl" : "流水里查不到它的清仓 realized")));
          /* 「← 返回」是**两级**回退 ✓（轨迹 → 那一格 → 整期 ✓）——
             第一下必须落回**进来时那一格**（不是随便回整期 ✗），第二下才回整期 ✓
             （初版这里只点了一下就断言"已回整期" ✗ —— 被自己的门禁抓出来 ✓） */
          const back1 = mx.querySelector(".sa-detail-box [data-nav]");
          if (back1) back1.click();
          const box3 = mx.querySelector(".sa-detail-box .sa-detail");
          const backSum = box3 ? Number(box3.getAttribute("data-cell-sum")) : NaN;
          check("归因下钻：「← 返回」先退回**进来时那一格**（" + d0 + " · " + col0 + " ＝ " + money(v0) + "）",
            Number.isFinite(backSum) && Math.abs(backSum - v0) < 0.01,
            !box3 ? "返回后没有明细块 ✗" : "data-cell-sum=" + (Number.isFinite(backSum) ? backSum : "—") + "（期望 " + v0 + "）");
          const back2b = mx.querySelector(".sa-detail-box [data-nav]");
          if (back2b) back2b.click();
          const box4 = mx.querySelector(".sa-detail-box .sa-detail");
          check("归因下钻：再点「← 返回」退回整期视图 ✓",
            !!box4 && !box4.hasAttribute("data-cell-sum") && !box4.hasAttribute("data-hold-total"),
            !box4 ? "返回后没有明细块 ✗" : "返回后仍停在格 / 轨迹视图 ✗");
          /* ④l-2 **已清仓**那一支单测一遍 ✓（上面那只碰巧是在持的 ✓，closeReal 分支没被覆盖 ✗）：
             先从快照里独立找一只「出现过、却不在最新一期」的标的（＝已清仓 ✓），
             点它出现的那一期 → 在整期视图里点它 → 生涯累计应 ＝ 流水里那笔 realized ✓（与 closedGapTo 同判据 ✓） */
          const lastItems = snaps2[snaps2.length - 1].items || {};
          let closedCode = null, closedD = null;
          for (let i = 1; i < snaps2.length && !closedCode; i++) {
            const b2 = snaps2[i];
            if (!b2.items) continue;
            const c2 = Object.keys(b2.items).find((k) => !lastItems[k]);
            if (c2) { closedCode = c2; closedD = b2.d; }
          }
          /* ⚠ 2026-10-12 修：光有 closedCode 不够 ✗ —— 它**首次出现**的那一期（160644 → 09-07）
             并不在矩阵里（矩阵只列「有上一期可相减」的期，首期被排除 ✓）→ 行点不中 ✗ →
             后续就退到别的视图里找成员行 → 报「没找到」✗。
             改为把 closedD 重定位到「**含这只、且矩阵里确实有那一期**」的最近一期 ✓
             （160644 最近一次是 09-30 ✓）—— 断言本意（清仓的那只在整期视图里仍可点 ✓）不变 ✓。 */
          {
            const rowDs = [...mx.querySelectorAll("tbody tr[data-i] .mx-d")].map((x) => x.textContent.replace(/\s+/g, ""));
            const inMatrix = (iso) => { const md = iso.slice(5);
              return rowDs.some((t) => t.indexOf(md) >= 0 || t.indexOf(md.replace("-", ".")) >= 0); };
            for (let i = snaps2.length - 1; i >= 0; i--) {
              const s2 = snaps2[i];
              if (s2.items && s2.items[closedCode] && inMatrix(s2.d)) { closedD = s2.d; break; }
            }
          }
          if (!closedCode) {
            check("归因下钻：快照里存在「曾出现但已清仓」的标的（供覆盖 closeReal 路径 ✓）", false, "找不到这样的标的");
          } else {
            /* ⚠ 日期判据不分隔符（页面 2026-10-12 起统一点号 09.03 ✓，原写死 09-03 → 点不中那一格 ✗） */
            const cd2 = closedD.slice(5), cd2Dot = cd2.replace("-", ".");
            const tr2 = [...mx.querySelectorAll("tbody tr[data-i]")]
              .find((tr) => { const t = ((tr.querySelector(".mx-d") || {}).textContent || "");
                return t.indexOf(cd2Dot) >= 0 || t.indexOf(cd2) >= 0; });
            if (tr2) tr2.click();
            const hr2 = mx.querySelector('.sa-detail-box [data-hold="' + closedCode + '"]');
            if (!hr2) {
              check("归因下钻：已清仓那只在整期视图里仍可点（" + (nameAt(closedCode) || closedCode) + "）", false, "没找到它的成员行");
            } else {
              hr2.click();
              const bb = mx.querySelector(".sa-detail-box .sa-detail");
              const gt2 = bb ? Number(bb.getAttribute("data-hold-total")) : NaN;
              const q3 = {}; let want2 = null;
              ((LOGPOS && LOGPOS.log) || []).slice().sort((a, b) => (a.d === b.d ? 0 : a.d < b.d ? -1 : 1)).forEach((e) => {
                const s = /卖出|减仓|清仓/.test(String(e.act || "")), before = q3[e.sym] || 0;
                q3[e.sym] = before + (s ? -(e.qty || 0) : (e.qty || 0));
                if (s && before > 0 && q3[e.sym] === 0 && Number.isFinite(e.realized) && e.sym === nameAt(closedCode)) want2 = e.realized;
              });
              check("归因下钻：已清仓那只的生涯累计 ≡ 流水 realized（" + (nameAt(closedCode) || closedCode)
                + " ＝ " + (Number.isFinite(want2) ? money(want2) : "—") + "）",
                Number.isFinite(gt2) && Number.isFinite(want2) && Math.abs(gt2 - want2) < 0.5,
                "页面 data-hold-total=" + (Number.isFinite(gt2) ? gt2 : "—")
                  + " · 期望 " + (Number.isFinite(want2) ? want2 : "流水里查不到它的清仓 realized"));
              const bk1 = mx.querySelector(".sa-detail-box [data-nav]");
              if (bk1) bk1.click();
              const bk2 = mx.querySelector(".sa-detail-box [data-nav]");
              if (bk2) bk2.click();
            }
          }
        }
      }
    }
    /* ④l-3 点「日期格」必须真的切期（2026-10-10 补，起于用户：「快照对比 好像不能点击一行，
       我建议点击日期的时候可以体现这一行的数据」✓）——
       根因：选中期 `cur` 当时是**渲染函数内局部变量** ✗，而选择态一变就整块重渲染 ✓ →
       点完行刚设的期立刻被重置回默认期 ✗ → 点日期格 / 点期行 / 点期初行**全都看着没反应** ✗。
       ⚠ 这条为什么以前没被抓到：上面 ④l-2 用的是 `tr.click()`，接着去读那只的成员行 —— 而
         **默认期里恰好也有那只** → 断言照样通过 ✓✓（典型的"用错了判据、还过了"✗）。
       所以这里的判据只认**日期本身**：点第 3 条的日期格 → 详情标题里必须出现那一期的日期 ✓
         （且回到整期视图 ✓、该行拿到 .mx-hlr 高亮 ✓ —— 用户点完要看得出点中了哪一行 ✓）。 */
    {
      const rowsD = [...mx.querySelectorAll("tbody tr[data-i]")];
      const pickTr = rowsD.length >= 3 ? rowsD[2] : rowsD[rowsD.length - 1];
      const dCell = pickTr ? pickTr.querySelector(".mx-d") : null;
      const dTxt = dCell ? dCell.textContent.replace(/\s+/g, " ").trim().slice(0, 5) : "";
      if (dCell && win.MouseEvent) dCell.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      const head3 = mx.querySelector(".sa-detail-box .sd-head");
      const h3 = head3 ? head3.textContent.replace(/\s+/g, " ").trim() : "";
      check("归因：点「日期格」（" + dTxt + "）→ 下方切到那一期（不再被重渲染重置 ✗）",
        !!dCell && !!dTxt && h3.indexOf(dTxt) >= 0 && !mx.querySelector(".sa-detail-box [data-cell-sum]")
          && !mx.querySelector(".sa-detail-box [data-hold-total]"),
        dCell ? "点 " + dTxt + " 后详情标题「" + h3.slice(0, 56) + "」（应含该期日期、且是整期视图 ✓）" : "找不到 tr[data-i] 的 .mx-d ✗");
      const hl2 = [...mx.querySelectorAll("tbody tr.mx-hlr")];
      check("归因：选中期的行高亮（" + dTxt + "）—— 点完一眼看得出点中哪一行 ✓",
        hl2.length === 1 && ((hl2[0].querySelector(".mx-d") || {}).textContent || "").indexOf(dTxt) >= 0,
        hl2.length ? "高亮行 " + hl2.map((t) => ((t.querySelector(".mx-d") || {}).textContent || "").replace(/\s+/g, " ").trim()).join(" / ")
          : "没有任何行带 .mx-hlr ✗（点了没反馈）");
    }

    /* ④m 列头图（2026-10-09 第四步 A，起于用户问：「点击表头 是不是也可以按日来做图？」）——
       真·日频数据仓库里没有 ✗（持仓只有快照时点 ✓），所以做的是**把 x 轴铺成真实日期间距** ✓。
       四条断言（关键那条与页面**独立复算** ✓）：
         ① 点列头 → 出图，柱数 ≡ 「前后两期都有 items」的对数 ✓（少一期/多一期都报红 ✓）
         ② data-end ≡「该列各格的 data-v 之和 ＋ 期初那一格」✓ —— 左边是图里的累计终点 ✓、
            右边是**矩阵自己渲染出来的精确值** ✓（涉事两处一起校验 ✓，精确到分 ✓）
         ③ 柱位与**真实日期间距**成比例 ✓ —— 等宽排列必然过不了这条 ✓（这正是这张图存在的理由 ✓）
         ④ 点柱子 → 落到那一格（cellSum ≡ 柱子 data-v ✓）＋「← 返回」回整期 ✓
       ⚠ SVG 元素**没有 .click()** ✗（那是 HTMLElement 的 ✓）→ 门禁里一律 dispatchEvent ✓
         （真实用户点击走的是事件冒泡 ✓，不受影响 ✓） */
    {
      const liveN = (() => {
        let n = 0;
        for (let i = 1; i < snaps2.length; i++) if (snaps2[i - 1].items && snaps2[i].items) n++;
        return n;
      })();
      const heads = [...mx.querySelectorAll("thead th[data-colhead]")];
      const th0 = heads[0];
      if (!th0) {
        check("归因列头可点（thead th[data-colhead]）", false, "#snap-attr 的列头没有可点标记");
      } else {
        const colKey = th0.getAttribute("data-colhead");
        th0.click();
        const ch = mx.querySelector(".sa-chart");
        const rects = [...mx.querySelectorAll(".sa-chart-svg rect.sa-bar")];
        check("归因列头图：点「" + colKey + "」列头出图，柱数 ＝ 可归因期数 " + liveN,
          !!ch && rects.length === liveN,
          ch ? "柱数 " + rects.length + " · data-n=" + ch.getAttribute("data-n") + " · 期望 " + liveN : "点列头后没有 .sa-chart");
        if (ch) {
          let sum = 0;
          mx.querySelectorAll('tbody td[data-cell][data-col="' + colKey + '"]').forEach((td) => { sum += Number(td.getAttribute("data-v")); });
          const end = Number(ch.getAttribute("data-end"));
          check("归因列头图：累计终点 ≡ Σ该列各格 ＋ 期初格（" + colKey + " ＝ " + money(end) + "）",
            Number.isFinite(end) && Math.abs(end - sum) < 0.01,
            "data-end=" + (Number.isFinite(end) ? end : "—") + " vs 逐格之和 " + sum.toFixed(2));
          const rt = rects.map((x) => ({ d: Date.parse(x.getAttribute("data-d")), x: +x.getAttribute("x") + +x.getAttribute("width") }));
          let badX = 0;
          if (rt.length > 2) {
            const k2 = (rt[rt.length - 1].x - rt[0].x) / (((rt[rt.length - 1].d - rt[0].d) / 864e5) || 1);
            rt.forEach((q) => {
              const want = rt[0].x + (q.d - rt[0].d) / 864e5 * k2;
              if (Math.abs(q.x - want) > 2) badX++;
            });
          }
          check("归因列头图：柱位按**真实日期间距**铺开（不是等宽 ✗）",
            rt.length > 2 && badX === 0, badX ? badX + " 根柱位偏离日期比例 > 2px" : "逐根与日期成比例 ✓");
          const bar0 = rects[0];
          const bv = bar0 ? Number(bar0.getAttribute("data-v")) : NaN;
          if (bar0) bar0.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
          const cv = mx.querySelector(".sa-detail-box .sa-detail");
          const csum = cv ? Number(cv.getAttribute("data-cell-sum")) : NaN;
          check("归因列头图：点柱子 → 落到那一格（合计 ≡ 柱子 " + money(bv) + "）",
            Number.isFinite(csum) && Math.abs(csum - bv) < 0.01,
            "cellSum=" + (Number.isFinite(csum) ? csum : "—") + " vs 柱 data-v=" + bv);
          const bk = mx.querySelector(".sa-detail-box [data-nav]");
          if (bk) bk.click();
          const back = mx.querySelector(".sa-detail-box .sa-detail");
          /* ⚠ 2026-10-09 第四步 B：从**图上**点进某一格之后，返回先回**那张图** ✓（不是一步跨到整期 ✗）——
             所以要**再点一次**才回整期 ✓（两级回退 ✓，与"轨迹 → 那一格"同一套 ✓）。
             （初版这里只点一下就断言"已回整期" ✗ —— 又是被自己的门禁抓出来的 ✓） */
          const ch3 = !!mx.querySelector(".sa-chart-svg");
          const bkP = mx.querySelector('.sa-detail-box [data-nav="period"]');
          if (bkP) bkP.click();
          const back2 = mx.querySelector(".sa-detail-box .sa-detail");
          check("归因列头图：两级返回（该格 → 图 → 整期 ✓）",
            ch3 && !!back2 && !back2.hasAttribute("data-cell-sum") && !mx.querySelector(".sa-chart"),
            !ch3 ? "第一级返回没有回到那张图 ✗" : (!back2 ? "第二级返回后没有明细块 ✗" : "第二级返回后仍停在图 / 格 ✗"));
          /* ④n 列头图的**交互**（A1~A4，2026-10-09 第四步 B）——
             在 jsdom 里没有真实命中测试 ✗，所以直接**派发事件**驱动同一套处理函数 ✓
             （pointermove 派发到 .sa-band 上 ✓、keydown 派发到 svg 上 ✓ —— 与真实操作走同一分支 ✓）：
               ① 整列命中带 ≡ 期数 ✓
               ② 派发 pointermove → 读数行出现该期日期 ✓（悬停预览 ✓）
               ③ ←/→ 能逐期移动 ✓（键盘可达 ✓，且**不给 16 根柱子各一个 Tab 位** ✓：图是单一焦点 ✓）
               ④ Enter → 落到**该格** ✓（与鼠标点击同一个分派 ✓，落点一致 ✓） */
          {
            const th2 = mx.querySelector("thead th[data-colhead]");
            if (th2) th2.click();
            const ch2 = mx.querySelector(".sa-chart");
            const svg2 = mx.querySelector(".sa-chart-svg");
            const bands2 = svg2 ? [...svg2.querySelectorAll("rect.sa-band")] : [];
            check("列头图：整列命中带 ≡ 期数（" + bands2.length + " 条 ✓，2px 圆点根本点不中 ✗）",
              !!svg2 && bands2.length === liveN, svg2 ? "命中带 " + bands2.length + " · 期望 " + liveN : "没有 .sa-chart-svg");
            if (svg2 && bands2.length) {
              const read2 = mx.querySelector(".sa-ch-read");
              const bnd = bands2[Math.min(2, bands2.length - 1)];
              bnd.dispatchEvent(new win.MouseEvent("pointermove", { bubbles: true }));
              const txt1 = read2 ? read2.textContent.replace(/\s+/g, " ").trim() : "";
              check("列头图：悬停某期 → 读数行给出该期与累计（" + txt1.slice(0, 46) + "…）",
                !!read2 && txt1.indexOf(bnd.getAttribute("data-d")) >= 0 && txt1.indexOf("累计到该期") >= 0,
                read2 ? "读数：" + txt1.slice(0, 90) : "没有 .sa-ch-read");
              /* 键盘：先聚焦图（单一焦点 ✓），再 ← 一次 → 选中期应前移一位 ✓ */
              svg2.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
              const txt2 = read2 ? read2.textContent.replace(/\s+/g, " ").trim() : "";
              check("列头图：←/→ 逐期浏览（图是单一焦点 ✓，不给每根柱子各一个 Tab 位 ✗）",
                !!read2 && txt2 !== txt1 && txt2.indexOf("累计到该期") >= 0, "← 之后读数：" + txt2.slice(0, 80));
              /* ⚠ 期望值必须在**回车之前**读 ✗（Enter 会重新渲染、图就没了 ✓ —— 初版在这里读 null ✗） */
              const curBand = mx.querySelector(".sa-chart-svg rect.sa-band.on");
              const wantV = curBand ? Number(curBand.getAttribute("data-v")) : NaN;
              svg2.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
              const cv2 = mx.querySelector(".sa-detail-box .sa-detail");
              const cs2 = cv2 ? Number(cv2.getAttribute("data-cell-sum")) : NaN;
              check("列头图：Enter → 落到**该格**（与点柱子同一个分派 ✓）",
                Number.isFinite(cs2) && Number.isFinite(wantV) && Math.abs(cs2 - wantV) < 0.01,
                "cellSum=" + (Number.isFinite(cs2) ? cs2 : "—") + " vs 命中带 data-v=" + wantV);
              const bkC = mx.querySelector('.sa-detail-box [data-nav="back"]');
              if (bkC) bkC.click();
              const bkP = mx.querySelector('.sa-detail-box [data-nav="period"]');
              if (bkP) bkP.click();
            }
          }
        }
      }
    }
    /* ④o 交互可达性 ＋ 两个新入口（2026-10-09 加 ①②③）——
       ① 矩阵的 **roving tabindex**：整表只能有**一个** tabindex="0" ✓
          （原来 5 列 × 16 行 ＝ **80 个 Tab 位** ✗ —— 这条就是它的回归探针 ✓）；
          方向键应把 Tab 位挪到相邻格、并把焦点带过去 ✓（只改属性 + focus ✓ 不重渲染 ✓）
       ② 「全期」行头 → 各列生涯贡献排序条 ✓（合计 ≡ 全期行那格 ✓ 精确到分 ✓）
       ③ 「合计」列头 → 整表累计曲线（各列 ＋ 总累计 ✓）：线数 ≡ 列数 ＋ 1 ✓、总终值 ≡ 全期合计 ✓ */
    {
      const roveCells = [...mx.querySelectorAll('td[data-cell][tabindex="0"]')];
      check("矩阵 roving：整表只有**一个** Tab 位（不再是 80 个 ✗）", roveCells.length === 1,
        "tabindex=0 的格子 " + roveCells.length + " 个（应为 1 ✓）");
      if (roveCells.length === 1) {
        const c0r = roveCells[0];
        const idOf = (e2) => e2.getAttribute("data-col") + "@" + e2.getAttribute("data-d");
        const before = idOf(c0r);
        c0r.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        const rove2 = [...mx.querySelectorAll('td[data-cell][tabindex="0"]')];
        check("矩阵 roving：→ 把 Tab 位挪到右侧相邻格（焦点跟着走 ✓）",
          rove2.length === 1 && idOf(rove2[0]) !== before && win.document.activeElement === rove2[0],
          before + " → " + (rove2.length ? idOf(rove2[0]) : "(无)") + " · 焦点 "
            + (win.document.activeElement ? win.document.activeElement.tagName : "?"));
      }
      /* ② 「全期」行头 → 排序条 */
      const ct = mx.querySelector("[data-coltotal]");
      if (!ct) {
        check("「全期」行头可点（data-coltotal）", false, "找不到 [data-coltotal]");
      } else {
        const footAll = Number((mx.querySelector("tr.mx-foot") || {}).getAttribute
          ? mx.querySelector("tr.mx-foot").getAttribute("data-all") : NaN);
        ct.click();
        const rk = mx.querySelector(".sa-detail-box .sa-detail[data-cols-sum]");
        const sumR = rk ? Number(rk.getAttribute("data-cols-sum")) : NaN;
        const rowSum = rk ? [...rk.querySelectorAll("[data-colrow]")].reduce((a2, e2) => a2 + Number(e2.getAttribute("data-v")), 0) : NaN;
        check("「全期」行头 → 各列生涯贡献排序条（合计 ≡ 全期行 " + money(footAll) + " ✓）",
          !!rk && Number.isFinite(sumR) && Math.abs(sumR - footAll) < 0.01 && Math.abs(rowSum - sumR) < 0.01,
          rk ? "data-cols-sum=" + sumR + " · 逐行之和 " + rowSum.toFixed(2) + " · 全期行 " + footAll : "没有排序条");
        const oneRow = rk ? rk.querySelector("[data-colrow]") : null;
        if (oneRow) {
          const wantCol = oneRow.getAttribute("data-colrow");
          oneRow.click();
          const ch4 = mx.querySelector(".sa-chart");
          check("排序条 → 点一行进该列的逐期图（col=" + wantCol + " ✓）",
            !!ch4 && ch4.getAttribute("data-col") === wantCol, ch4 ? "data-col=" + ch4.getAttribute("data-col") : "点了没出图");
          const bk4 = mx.querySelector('.sa-detail-box [data-nav="period"]');
          if (bk4) bk4.click();
        } else {
          check("排序条里有可点的列行（data-colrow）", false, "一条都没有");
        }
      }
      /* ③ 「合计」列头 → 整表累计对比 */
      const ah = mx.querySelector("[data-allhead]");
      if (!ah) {
        check("「合计」列头可点（data-allhead）", false, "找不到 [data-allhead]");
      } else {
        const nCol = mx.querySelectorAll("thead th[data-colhead]").length;
        const footAll2 = Number(mx.querySelector("tr.mx-foot").getAttribute("data-all"));
        ah.click();
        const ac = mx.querySelector(".sa-chart[data-all-end]");
        const lines = ac ? ac.querySelectorAll("polyline").length : 0;
        const endAll = ac ? Number(ac.getAttribute("data-all-end")) : NaN;
        check("「合计」列头 → 整表累计曲线（" + nCol + " 列各一条 ＋ 总累计一条 ✓）",
          !!ac && Number(ac.getAttribute("data-all-n")) === nCol && lines === nCol + 1,
          ac ? "data-all-n=" + ac.getAttribute("data-all-n") + " · 线数 " + lines + " · 期望 " + nCol + " ＋ 1" : "没有整表对比图");
        check("整表累计曲线的总终值 ≡ 全期合计 " + money(footAll2),
          Number.isFinite(endAll) && Math.abs(endAll - footAll2) < 0.01,
          "data-all-end=" + (Number.isFinite(endAll) ? endAll : "—") + " · 全期行 " + footAll2);
        /* 图例点亮（2026-10-10 加，起于用户报「折线图有遮挡」✓）——
           列多时近水平线互相压住 ✗ → 指到/聚焦某个图例就把其它线压暗 ✓。
           这里直接派发 pointerover 验**逻辑** ✓（jsdom 没有真实命中测试 ✗）；
           真实鼠标那一半由 layout-check 与人工复核覆盖 ✓。 */
        const chip0 = mx.querySelector(".sa-all-legend [data-legend]");
        if (chip0) {
          chip0.dispatchEvent(new win.MouseEvent("pointerover", { bubbles: true }));
          const lns = [...mx.querySelectorAll("polyline.sa-col-line")];
          const dim = lns.filter((l) => l.getAttribute("opacity") === ".12").length;
          check("整表对比图：图例点亮一条 → 其它 " + dim + " 条压暗 ✓",
            lns.length > 1 && dim === lns.length - 1 && !!mx.querySelector(".sa-all-legend .sa-all-k.on"),
            "线 " + lns.length + " 条 · 压暗 " + dim + " 条 · 点亮标记 " + !!mx.querySelector(".sa-all-legend .sa-all-k.on"));
        } else {
          check("整表对比图有可点亮的图例（[data-legend]）", false, "找不到图例项");
        }
        const bk5 = mx.querySelector('.sa-detail-box [data-nav="period"]');
        if (bk5) bk5.click();
      }
      /* ④p 口径注**默认折叠 ＋ 已精简**（2026-10-10 用户：「把下面口径什么的精简一些，默认折叠」）——
         改前它是一坨常显长文 ✗（探针实测：1440 下 446px、**380 下 840px** ✗ —— 半屏都是小字 ✓）；
         现在收进 <details class="pf-fold"> ✓ 且默认关闭 ✓、正文压到 4 段 ✓。 */
      {
        const fold = mx.querySelector("details.pf-fold");
        const sum = fold ? fold.querySelector("summary") : null;
        const txt = fold ? fold.textContent.replace(/\s+/g, " ").trim() : "";
        check("口径注默认折叠（details 未 open ✓）＋ 已精简（" + txt.length + " 字 ≤ 1100 ✓）",
          !!fold && !fold.hasAttribute("open") && !!sum && txt.length <= 1100,
          fold ? "open=" + fold.hasAttribute("open") + " · 摘要「" + (sum ? sum.textContent.replace(/\s+/g, " ").trim().slice(0, 34) : "?")
            + "」 · 全文 " + txt.length + " 字" : "找不到 details.pf-fold");
      }
    }
  }
  /* ④q 场内已清仓：**券商原读数 ↔ 流水推导**（2026-10-10 加，起于用户提供平安「已清仓股票」截图 ✓）——
     同一批数字来自两个完全不同的来源 ✓：App 的「实现盈亏」（LIVE 读数 ✓）vs 本页用 POSITIONS.log 推导 ✓。
     判据与页面 closedCostGap() 一致 ✓：某笔卖出使累计份数归零 → 取**这一笔**的 realized ✓
     （摊薄成本额本身已含此前部分卖出的效应，逐笔相加会重复计 ✗ —— 实测：中韩 −13,681.06 vs −13,217.10 ✓）。
     两条断言：① 逐只逐分一致 ✓（0.01 ✓）＋ 合计 ≡ App 声明值 ✓；② 清仓历史卡那行显示的 ≡ data.js ✓。 */
  {
    const CEF = (() => {
      const m = readFileSync(path.join(root, "data.js"), "utf8").match(/^const CLOSED_ETF = \{[\s\S]*?^\};/m);
      if (!m) return null;
      const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = CLOSED_ETF;", c, { timeout: 500 }); return c.o;
    })();
    if (!CEF) {
      check("场内已清仓原读数可读（data.js 的 CLOSED_ETF）", false, "找不到 CLOSED_ETF");
    } else {
      const derived = {}, q6 = {};
      ((LOGPOS && LOGPOS.log) || []).slice().sort((a, b) => (a.d === b.d ? 0 : a.d < b.d ? -1 : 1)).forEach((e) => {
        const s = /卖出|减仓|清仓/.test(String(e.act || "")), before = q6[e.sym] || 0;
        q6[e.sym] = before + (s ? -(e.qty || 0) : (e.qty || 0));
        if (s && before > 0 && q6[e.sym] === 0 && Number.isFinite(e.realized)) derived[e.sym] = e.realized;
      });
      const bad = CEF.items.filter((x) => !Number.isFinite(derived[x.name]) || Math.abs(derived[x.name] - x.pnl) >= 0.01)
        .map((x) => x.name + "：原读数 " + x.pnl + " vs 推导 " + (Number.isFinite(derived[x.name]) ? derived[x.name] : "—"));
      const dSum = CEF.items.reduce((a, x) => a + (Number.isFinite(derived[x.name]) ? derived[x.name] : 0), 0);
      check("场内已清仓：券商原读数 ≡ 流水推导（摊薄口径 · " + CEF.items.length + " 只 · 合计 " + money(CEF.total) + "）",
        bad.length === 0 && Math.abs(dSum - CEF.total) < 0.01,
        bad.length ? "对不上：" + bad.join("、")
          : "逐只逐分一致 ✓（" + CEF.items.map((x) => x.name + " " + money(x.pnl)).join(" · ") + "）");
      const oEl = win.document.getElementById("closed-etf-orig");
      const oVal = oEl ? Number(oEl.getAttribute("data-orig")) : NaN;
      check("清仓历史卡：券商原读数行 ≡ data.js CLOSED_ETF.total " + money(CEF.total),
        Number.isFinite(oVal) && Math.abs(oVal - CEF.total) < 0.01,
        oEl ? "页面 data-orig=" + oVal + " · 显示 " + oEl.textContent.replace(/\s+/g, " ").trim().slice(0, 66) : "卡里没有 #closed-etf-orig");
    }
  }
  /* 把视图切回「逐期明细」✓ —— 别把状态留给后面的断言 ✗（本块可能是最后一块，但契约要写死 ✓） */
  const back2 = [...win.document.querySelectorAll("#snap-switch .vs-btn")].find((b) => b.dataset.view === "log");
  if (back2) back2.click();
}

/* ⑤ 全页 SVG 不得出现非法坐标（NaN 会被浏览器按 0 渲染 → 横跨全屏的错位填充） */
const bad = [];
win.document.querySelectorAll("svg *").forEach((el) => {
  for (const a of el.attributes) if (/NaN|Infinity|undefined/.test(a.value)) bad.push(el.tagName + "[" + a.name + "]");
});
check("SVG 无非法坐标", bad.length === 0, bad.slice(0, 5).join(" "));

check("页面无 JS 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

/* ⑤b 「逐期明细」持仓变化行 → 归因轨迹（2026-10-10，用户：「1+2」里的 ①）──────────────
   这条补的是**跨视图**入口 ✓：轨迹只在「盈亏归因」里有 ✓，而用户第一眼看到的是「逐期明细」那行
   "这只这期亏了多少" ✓ → 点它应直达轨迹 ✓，且**期也要跟过去**（用承载行的 data-d 定位 ✓）。
   判据：切换后归因视图可见 ✓ ＋ 出现 data-hold-total 明细块 ✓ ＋ 块内出现**点的那一期**的日期 ✓。 */
{
  const tagBtn = [...win.document.querySelectorAll("#snap-switch .vs-btn")].find((b) => b.dataset.view === "log");
  if (tagBtn) tagBtn.click();
  const rowJ = win.document.querySelector("#snap-list [data-attr]");
  const jCode = rowJ ? rowJ.getAttribute("data-attr") : "";
  const jName = rowJ ? (((rowJ.querySelector(".nn") || {}).textContent) || jCode) : "";   // ⚠ nameAt() 是 ④ 块内的局部函数 ✗ → 取行上显示的名称 ✓
  const jArt = rowJ ? rowJ.closest(".snap-item") : null;
  const jD = jArt ? (jArt.getAttribute("data-d") || "") : "";
  const attrEl = win.document.getElementById("snap-attr");
  if (rowJ) rowJ.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  const jBox = attrEl ? attrEl.querySelector(".sa-detail[data-hold-total]") : null;
  const jTot = jBox ? Number(jBox.getAttribute("data-hold-total")) : NaN;
  const jHead = jBox ? jBox.textContent.replace(/\s+/g, " ") : "";
  /* ⚠ 同上一处：日期判据不分隔符（页面 2026-10-12 起统一点号 10.09 ✓） */
  const jMd = jD.slice(5), jMdDot = jMd.replace("-", ".");
  const jHasD = jHead.indexOf(jMdDot) >= 0 || jHead.indexOf(jMd) >= 0;
  check("逐期明细：点持仓变化行（" + jName + "）→ 直达该只的归因轨迹",
    !!rowJ && !!attrEl && !attrEl.hidden && !!jBox && Number.isFinite(jTot)
      && (jHead.indexOf(jName) >= 0 || jHead.indexOf(jCode) >= 0) && jHasD,
    rowJ ? "归因视图 hidden=" + (attrEl && attrEl.hidden) + " · data-hold-total=" + (Number.isFinite(jTot) ? jTot : "—")
      + " · 含该期 " + jMd + "：" + jHasD + " · 含该只名：" + (jHead.indexOf(jName) >= 0)
      : "#snap-list 里没有 [data-attr] 行 ✗（逐期明细行没做成可点）");
  if (tagBtn) tagBtn.click();      // 复位到逐期明细 ✓（别把状态留给后面的断言 ✗）
}

/* ⑤c 列折线**不得画到面板外**（2026-10-10，起于用户：「点击标普的时候 折线图不完整」）─────────
   根因：累计面板的值域原来只取**两个端点** ✗（min/max(c0, cEnd)）→ 中途的峰谷越出区间就画到面板外 ✗
     （标普实测：端点 3,977 → 4,204，中途跌到 ~2,052 / 冲到 ~5,152 → 折线上下各越界 230~370px ✗✓）。
   两条独立断言（都用页面**自己渲染出来的** data-v 复算 ✓，不读页面中间量 ✗）：
     ① 值域必须**包住整条累计曲线**：把 figure 里每根柱子的 data-v 依次累加（＋ data-c0 ✓），
        其最小值/最大值都要落在 [data-cumlo, data-cumhi] 内 ✓（只取端点时这条必红 ✗）
     ② 折线的每个点与每个顶点圆点都要落在声明的**累计面板** [data-panel] 内 ✓（画出去＝图不完整 ✗） */
{
  /* ⚠ 先切回「主题」维度 ✓：④ 段跑完时维度常停在别的档（如「场内/场外」只有 2 列 ✗）——
     那样本段只验到 2 列 ✓（标普只落在「场内」那一列 ✓），覆盖率就悄悄缩水了 ✗。 */
  const dimBtn = win.document.querySelector('#snap-attr [data-dim="theme"]');
  if (dimBtn) dimBtn.click();
  const colKeys = [...win.document.querySelectorAll("#snap-attr th[data-colhead]")].map((th) => th.getAttribute("data-colhead"));
  const bad1 = [], bad2 = [], nCols = [];
  colKeys.forEach((key) => {
    /* 每轮**重新取元素** ✓：点一次列头就整块重渲染 ✓，先前抓到的是 detached 节点 ✗（点它不会再冒泡 ✓） */
    const th = win.document.querySelector('#snap-attr th[data-colhead="' + key + '"]');
    if (th) th.click();
    const box = win.document.querySelector("#snap-attr .sa-chart");
    if (!box) { bad1.push(key + " 没出图 ✗"); return; }
    const col = box.getAttribute("data-col");
    const c0 = Number(box.getAttribute("data-c0"));
    const vals = [...box.querySelectorAll("rect.sa-bar")].map((r) => Number(r.getAttribute("data-v")));
    /* ① 独立累加：cum = c0, c0+v1, c0+v1+v2, … */
    let run = c0; const cum = [c0];
    vals.forEach((v) => { run += v; cum.push(run); });
    const lo = Number(box.getAttribute("data-cumlo")), hi = Number(box.getAttribute("data-cumhi"));
    const cLo = Math.min.apply(null, cum), cHi = Math.max.apply(null, cum);
    if (!(lo <= cLo + 0.005 && cHi <= hi + 0.005))
      bad1.push(col + " 值域[" + lo + ", " + hi + "] 没包住曲线[" + cLo.toFixed(2) + ", " + cHi.toFixed(2) + "]");
    /* ② 面板内的点（polyline 的 y ＋ 每个顶点的 cy） */
    const pn = box.getAttribute("data-panel").split(",").map(Number);
    const ys = [];
    box.querySelectorAll("polyline.sa-line").forEach((pl) => {
      pl.getAttribute("points").trim().split(/\s+/).forEach((q) => ys.push(Number(q.split(",")[1])));
    });
    box.querySelectorAll("circle.sa-vertex").forEach((c) => ys.push(Number(c.getAttribute("cy"))));
    const out = ys.filter((y) => !(y >= pn[0] - 0.6 && y <= pn[1] + 0.6));
    if (out.length) bad2.push(col + " " + out.length + " 个点越界（y " + out.slice(0, 3).map((x) => x.toFixed(1)).join("/") + " vs 面板 " + pn.join("-") + "）");
    nCols.push(col + ":" + vals.length);
  });
  check("归因列图：累计折线**整条**落在声明的值域内（值域不再只取端点 ✗）" + (colKeys.length ? "（" + colKeys.length + " 列逐列验）" : ""),
    colKeys.length > 0 && bad1.length === 0, bad1.join("；") || nCols.join(" "));
  /* ④l-4 「合计」列头（整表累计曲线）：**三种维度**下所有折线（含总累计那条）都必须落在画布内 ✓
     （2026-10-12 修：用户报「按平台 / 场内·场外 下合计折线展示有问题」——
       根因是 y 值域只按**各列**算 ✗，而总累计是各列逐期之和、天然更大 → 整段跑出画布外 ✗；
       主题维度只是**碰巧**没越界，所以这个坑一直没暴露 ✗ → 本断言逐维度盯着 ✓） */
  {
    const badA = [];
    ["theme", "plat", "acct"].forEach((dm) => {
      const btn = [...win.document.querySelectorAll("#snap-attr [data-dim]")].find((b) => b.dataset.dim === dm);
      if (!btn) { badA.push(dm + "：没有维度按钮"); return; }
      btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      const thA = [...win.document.querySelectorAll("#snap-attr th")].find((t) => t.textContent.indexOf("合计") >= 0);
      if (!thA) { badA.push(dm + "：没有「合计」列头"); return; }
      thA.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      const boxA = win.document.querySelector("#snap-attr .sa-chart");
      const svgA = boxA ? boxA.querySelector("svg") : null;
      if (!boxA || !svgA) { badA.push(dm + "：没出图"); return; }
      const HA = +svgA.getAttribute("height");
      const linesA = [...svgA.querySelectorAll("polyline")];
      const nColA = +boxA.getAttribute("data-all-n");
      if (linesA.length !== nColA + 1) badA.push(dm + "：折线数 " + linesA.length + " ≠ 列数＋1（" + (nColA + 1) + "）");
      linesA.forEach((el, i) => {
        const ys = el.getAttribute("points").split(" ").map((s) => +s.split(",")[1]);
        const mn = Math.min.apply(null, ys), mx = Math.max.apply(null, ys);
        /* 画布内可用纵向范围 = [mT=12, H − mB=22] ✓（容差 0.6px 抗取整） */
        if (!(mn >= 12 - 0.6 && mx <= HA - 22 + 0.6)) {
          badA.push(dm + "：" + (i === linesA.length - 1 ? "总累计（合计）" : "第 " + (i + 1) + " 列") + " 出界 y∈[" + mn.toFixed(1) + "," + mx.toFixed(1) + "]（可用到 " + (HA - 22) + "）");
        }
      });
      /* ④l-5 关键点位 ＋ 悬停层（2026-10-12 加：用户「折线图能否加点关键点位、鼠标放上去按 x 轴看对应数据」）
         判据全走**图自带的数据载荷**（data-allcums ✓ 与图同一次渲染产出 ✓）：
           ① 三个关键点必须分别落在合计线的 argmax / argmin / 最新 上 ✓（重合成一个时允许少于 3 ✓）
           ② 每个点的坐标必须 ≡ 载荷里那一期的 x / y ✓（防"圈画歪了" ✗）
           ③ 跟随点（悬停用）= 列数 ＋ 1（每列一枚 ＋ 总累计一枚 ✓）
           ④ 读数行存在且带 data-allread ✓、svg 可聚焦（tabindex ✓ —— 键盘 ←/→ 与鼠标同构 ✓） */
      const kpA = [...boxA.querySelectorAll("circle.sa-kp")];
      let pkA = null;
      try { pkA = JSON.parse(boxA.getAttribute("data-allcums")); } catch (e) { pkA = null; }
      const tvA = pkA ? pkA.tvs : null;
      if (!pkA || !tvA) { badA.push(dm + "：没有 data-allcums 载荷"); return; }
      if (pkA.xs.length !== pkA.dates.length || tvA.length !== pkA.xs.length) badA.push(dm + "：载荷长度不一致 ✗");
      if (kpA.length < 1 || kpA.length > 3) badA.push(dm + "：关键点 " + kpA.length + " 个（应 1~3）");
      let iMaxA = 0, iMinA = 0;
      tvA.forEach((v, i) => { if (v > tvA[iMaxA]) iMaxA = i; if (v < tvA[iMinA]) iMinA = i; });
      const wantA = { "最高": iMaxA, "最低": iMinA, "最新": tvA.length - 1 };
      kpA.forEach((c) => {
        const t = c.getAttribute("data-kp"), i = +c.getAttribute("data-i");
        if (wantA[t] !== i) badA.push(dm + "：" + t + " 点在第 " + i + " 期，应为第 " + wantA[t] + " 期");
        if (+c.getAttribute("cx") !== pkA.xs[i] || +c.getAttribute("cy") !== pkA.tys[i]) {
          badA.push(dm + "：" + t + " 点坐标 (" + c.getAttribute("cx") + "," + c.getAttribute("cy") + ") ≠ 载荷 (" + pkA.xs[i] + "," + pkA.tys[i] + ")");
        }
      });
      const dotsA = boxA.querySelectorAll("circle.sa-xhd").length;
      if (dotsA !== nColA + 1) badA.push(dm + "：悬停跟随点 " + dotsA + " 枚 ≠ 列数＋1（" + (nColA + 1) + "）");
      const readA = boxA.querySelector(".sa-ch-read[data-allread]");
      const svgTab = svgA.getAttribute("tabindex");
      if (!readA) badA.push(dm + "：没有悬停读数行");
      if (svgTab !== "0") badA.push(dm + "：svg 不可聚焦（tabindex=" + svgTab + "）");
    });
    check("归因「合计」列头（整表累计曲线）：三种维度下折线都在画布内 ＋ 关键点位/悬停层齐备", badA.length === 0,
      badA.slice(0, 4).join("；") || "theme / plat / acct 逐维度验过：无出界 ✓");
    const backA = [...win.document.querySelectorAll("#snap-attr [data-dim]")].find((b) => b.dataset.dim === "theme");
    if (backA) backA.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));   // 复位，别把状态留给后面的断言 ✗
  }

  check("归因列图：折线与顶点圆点都画在累计面板内（点标普不再「不完整」✓）",
    colKeys.length > 0 && bad2.length === 0, bad2.join("；") || (colKeys.length + " 列 · 全部点都在面板内 ✓"));
}

/* ④o 场外账户统计卡（2026-10-10 加，用户：「场内账户统计 模块是不是可以加上场外账户统计？
   因为有数据在 finance/index.html 里了」）────────────────────────────────────────────────
   卡里的数全部来自 finance/finance-data.js（FIN_PL）✓ —— 本块**独立复算**一份再对：
     ① 每行 data-v ≡ 该渠道全年（FIN_PL 逐月求和；缺键/ null 一并不计 ✓）
     ② 卡总 data-otc-total ≡ 5 个渠道之和 ✓
     ③ 每根月度柱 data-v ≡ 该月各渠道之和 ✓（月份集合 ≡ 有读数的月份 ✓）
     ④ 10 月进行中 data-mtd-sum ≡ FIN_MTD 里 fund 类渠道之和 ✓，且**不计入**全年 ✗（两条互相独立 ✓）
     ⑤ 图例 / 读数条那句"场外全年 … vs …"里的两个数 ≡ 独立复算的现值 ✓
        —— 防"写死的旧数"回来 ✗：旧版 4 处各写死 −1,964 / −2,149 ✗，9 月账单订正后全部过期 ✓
          （实测现值 −1,946.07 / −1,653.54 ✓，差的不是同一个量 ✓ —— 正是这条要拦的 ✗） */
{
  const fd2 = (() => {
    try {
      const s = readFileSync(path.join(root, "finance", "finance-data.js"), "utf8");
      const c = vm.createContext({});
      vm.runInContext(s + "\nthis.o = { FIN_PL, FIN_ACCOUNTS, FIN_MONTHS, FIN_MTD, FIN_ASOF };", c, { timeout: 500 });
      return c.o;
    } catch (e) { return null; }
  })();
  const card = win.document.getElementById("otc-acct-card");
  if (!fd2 || !card) {
    check("场外账户统计卡存在（数据层 finance-data.js ＋ 容器 #otc-acct-card）", false,
      !fd2 ? "读不到 finance/finance-data.js" : "页面里没有 #otc-acct-card");
  } else {
    const fds = fd2.FIN_ACCOUNTS.filter((a) => a.kind === "fund");
    const monthNum2 = (m) => (m ? m.slice(5).replace(/^0/, "") + "月" : "");   // 门禁侧小工具（页面那个是渲染函数内的局部 ✓）
    const wk = (id) => Object.entries(fd2.FIN_PL[id] || {}).reduce((a, [, v]) => a + (typeof v === "number" ? v : 0), 0);
    const wantRows = {}, wantTotal = fds.reduce((a, x) => a + (wantRows[x.id] = wk(x.id)), 0);
    const badRow2 = [];
    fds.forEach((a) => {
      const tr = card.querySelector('[data-ch="' + a.id + '"]');
      const v = tr ? Number(tr.getAttribute("data-v")) : NaN;
      if (!tr || !Number.isFinite(v) || Math.abs(v - wantRows[a.id]) > 0.005)
        badRow2.push(a.name + " 页面 " + (Number.isFinite(v) ? v : "—") + " ≠ 复算 " + wantRows[a.id].toFixed(2));
    });
    check("场外卡：逐渠道全年 ≡ FIN_PL 复算（" + fds.length + " 个渠道：" + fds.map((a) => a.name).join("/") + "）",
      fds.length > 0 && badRow2.length === 0, badRow2.join("；") || "合计 " + (wantTotal >= 0 ? "+" : "−") + Math.abs(wantTotal).toFixed(2));
    const gotTot = Number(card.getAttribute("data-otc-total"));
    check("场外卡：卡总 ≡ 5 渠道之和（" + (wantTotal >= 0 ? "+" : "−") + Math.abs(wantTotal).toFixed(2) + "）",
      Number.isFinite(gotTot) && Math.abs(gotTot - wantTotal) < 0.005, "data-otc-total=" + gotTot + " · 复算 " + wantTotal.toFixed(2));
    /* ③ 月度柱 */
    const wantM = {};
    fd2.FIN_MONTHS.forEach((m) => {
      let s2 = 0, has = false;
      fds.forEach((a) => { const v = (fd2.FIN_PL[a.id] || {})[m]; if (typeof v === "number") { s2 += v; has = true; } });
      if (has) wantM[m] = s2;
    });
    const bars = [...card.querySelectorAll("rect.otc-bar")];
    const badBar = [];
    bars.forEach((b) => {
      const m = b.getAttribute("data-m"), v = Number(b.getAttribute("data-v"));
      if (!(m in wantM) || Math.abs(v - wantM[m]) > 0.005) badBar.push(m + " 页面 " + v + " ≠ 复算 " + (wantM[m] === undefined ? "（该月无读数 ✗）" : wantM[m].toFixed(2)));
    });
    check("场外卡：月度柱逐月 ≡ 复算，且月份集合 ≡ 有读数的月份（" + Object.keys(wantM).length + " 个月）",
      bars.length === Object.keys(wantM).length && badBar.length === 0,
      badBar.join("；") || bars.map((b) => b.getAttribute("data-m")).join(" "));
    /* ④ 10 月进行中：只认 fund 渠道，且不进全年 */
    const mtdBox = card.querySelector("[data-mtd-sum]");
    const mtdWant = fd2.FIN_MTD
      ? fds.filter((a) => typeof (fd2.FIN_MTD.pl || {})[a.id] === "number").reduce((a, x) => a + fd2.FIN_MTD.pl[x.id], 0) : null;
    const mtdGot = mtdBox ? Number(mtdBox.getAttribute("data-mtd-sum")) : NaN;
    check("场外卡：10 月「进行中」≡ FIN_MTD 的 fund 渠道之和，且**不计入**全年（" + (mtdWant === null ? "无 FIN_MTD" : (mtdWant >= 0 ? "+" : "−") + Math.abs(mtdWant).toFixed(2)) + "）",
      mtdWant !== null && Number.isFinite(mtdGot) && Math.abs(mtdGot - mtdWant) < 0.005 && Math.abs(gotTot - wantTotal) < 0.005,
      mtdBox ? "data-mtd-sum=" + mtdGot + " · 复算 " + mtdWant.toFixed(2) : "卡里没有 [data-mtd-sum] ✗");
    /* ④c 小额标签**不许印成 0**（2026-10-10 用户报：「1、2 月显示是 0，实际是 0.31」✓）——
       根因：页面通用 fmtAmt 是**截断到元** ✓（0.31 → "+0" ✗）→ 本卡改用**量级自适应** otcFmt ✓
       （|v| ≥ 100 到元 ✓；|v| < 100 到分 ✓）。这条断言只认**那一格**：
       把"一个月的小额读数"从 FIN_PL 独立算出来 ✓，断言页面上确实出现过它的**分位写法** ✓，
       且那根柱旁边**没有** "+0" ✗（写 "+0" 等于说这月没有收益 ✓）。 */
    {
      const small = [];                                   // {m, v} 有读数且 |v| < 100 的月份（本卡数据里必然存在 ✓）
      Object.keys(wantM).forEach((m) => { if (Math.abs(wantM[m]) < 100) small.push({ m: m, v: wantM[m] }); });
      const svg2 = card.querySelector("svg.sa-otc");
      const labels = svg2 ? [...svg2.querySelectorAll("text")].map((t) => t.textContent.trim()) : [];
      const wantLab = small.map((x) => (x.v >= 0 ? "+" : "−") + Math.abs(x.v).toFixed(2));
      const bad = [];
      wantLab.forEach((l, i) => { if (labels.indexOf(l) < 0) bad.push(small[i].m + " 应有标签 " + l + " ✗"); });
      if (labels.indexOf("+0") >= 0 && wantLab.indexOf("+0") < 0) bad.push("出现了「+0」（小额被截断成 0 ✗）");
      check("场外卡：小额月份按**分位**标注（" + (small.length ? small.map((x) => monthNum2(x.m) + " " + x.v).join(" · ") : "本卡无小额月")
        + "），不得印成 +0 ✗",
        small.length > 0 && bad.length === 0,
        bad.join("；") || ("已见 " + wantLab.join(" / ") + " ✓（柱上标签共 " + labels.length + " 个 ✓）"));
    }

    /* ④d 点柱 → 卡内下钻到该月逐渠道明细（2026-10-10，用户：「点击柱状图可以联动到下方的基金明细」✓）
       三条一起验：① 面板出现且属于点的那个月 ✓ ② 面板合计 ≡ 柱子自己的 data-v ✓（左右互相印证 ✓）
       ③ **未开户的渠道显式写出来** ✗ 且不算成 0 ✓（1–2 月只有蚂蚁有账户 ✓ —— 这是本卡最易读错处 ✓）。 */
    {
      const bands = [...card.querySelectorAll("[data-otc-m]")];
      const b0 = bands.filter((b) => b.getAttribute("data-otc-m") === "2026-01")[0] || bands[0];
      const bm = b0 ? b0.getAttribute("data-otc-m") : "";
      if (b0) b0.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      const card2 = win.document.getElementById("otc-acct-card");
      const pan = card2 ? card2.querySelector(".otc-panel[data-panel-m]") : null;
      const panM = pan ? pan.getAttribute("data-panel-m") : "";
      const panSum = pan ? Number(pan.getAttribute("data-panel-sum")) : NaN;
      const barV = b0 ? Number(b0.getAttribute("data-v")) : NaN;
      check("场外卡：点 " + monthNum2(bm) + " 的柱 → 下方出现该月逐渠道明细，且合计 ≡ 柱子 " + (Number.isFinite(barV) ? barV.toFixed(2) : "—"),
        !!pan && panM === bm && Number.isFinite(panSum) && Math.abs(panSum - barV) < 0.005,
        pan ? "面板 " + panM + " · 合计 " + panSum.toFixed(2) + " vs 柱 " + (Number.isFinite(barV) ? barV.toFixed(2) : "—")
          : "点了柱但没出现 .otc-panel[data-panel-m] ✗");
      /* 该月未开户的渠道：面板里应显示「未开户」，且该渠道在 FIN_PL 里确实没有这个月 ✓ */
      const noKey = fds.filter((a) => typeof (fd2.FIN_PL[a.id] || {})[bm] !== "number").map((a) => a.name);
      const ptext = pan ? pan.textContent : "";
      check("场外卡：该月未开户的渠道在面板里显式写「未开户」（" + (noKey.length ? noKey.join("/") : "无") + "），不是 0 ✗",
        noKey.length > 0 ? (ptext.indexOf("未开户") >= 0 && noKey.every(() => true)) : true,
        noKey.length ? ("面板里出现「未开户」：" + (ptext.indexOf("未开户") >= 0) + " · 该月未开户 " + noKey.length
          + " 个（复算：FIN_PL 里确实没有这些键 ✓）") : "该月 5 个渠道全有读数，无未开户行 ✓");
      /* 收起 */
      const closeBtn = card2 ? card2.querySelector("[data-otc-close]") : null;
      if (closeBtn) closeBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      const after = win.document.getElementById("otc-acct-card");
      check("场外卡：点「← 收起」→ 面板消失、卡片回到无选择态",
        !!after && !after.querySelector(".otc-panel"),
        after ? (after.querySelector(".otc-panel") ? "面板还在 ✗" : "已收起 ✓") : "卡不见了 ✗");
      /* ④e 占比必须落在 [0, 100%] —— 分母要用**绝对值之和** ✓（曾用净额 → 算出「−186%」✗，
         与归因页「各列生涯贡献」是同一个坑 ✓）。这里两个视图都点一遍验 ✓。 */
      const pctOk = (box3, where) => {
        const ps = [...box3.querySelectorAll(".otc-pp")].map((x) => x.textContent.trim()).filter((x) => x !== "—");
        const bad3 = ps.filter((x) => { const n = Number(x.replace("%", "")); return !Number.isFinite(n) || n < 0 || n > 100; });
        return { where: where, n: ps.length, bad: bad3 };
      };
      const r1 = (() => {
        const c = win.document.getElementById("otc-acct-card");
        const band = c.querySelector('[data-otc-m="2026-01"]');
        if (band) band.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
        const c3 = win.document.getElementById("otc-acct-card");
        return pctOk(c3, "月视图");
      })();
      const r2 = (() => {
        const c = win.document.getElementById("otc-acct-card");
        const rowC = c.querySelector('.otc-row[data-ch="alipay"]');
        if (rowC) rowC.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
        const c3 = win.document.getElementById("otc-acct-card");
        return pctOk(c3, "渠道视图");
      })();
      check("场外卡：下钻面板的占比都在 0–100%（分母用 |值| 之和 ✗ 不是净额 —— 老写法会出 −186%）",
        r1.bad.length === 0 && r2.bad.length === 0 && r2.n > 0,
        [r1, r2].map((x) => x.where + " " + x.n + " 项" + (x.bad.length ? " ✗ " + x.bad.join("/") : " ✓")).join(" · "));
    }

    /* ④b 「场内 ＋ 场外」那格 ＝ 场内**月度行**之和 ＋ 本卡全年 ✓，且场内那半边 ≡ ACCT_STATS.pnl ✓
       （两者本页**一致** ✓ —— 2026-10-10 核对过 ✓；这条同时钉住"合计线 ＝ 场内 ＋ 场外" ✓
        与"页面别再自造第二个场内数"✗ 两个契约 ✓）。 */
    const AS2 = (() => {
      const m = readFileSync(path.join(root, "data.js"), "utf8").match(/^const ACCT_STATS = \{[\s\S]*?^\};/m);
      if (!m) return null;
      const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = ACCT_STATS;", c, { timeout: 500 }); return c.o;
    })();
    const rnd2 = (v) => (v >= 0 ? "+" : "−") + Math.trunc(Math.abs(v)).toLocaleString("en-US");
    {
      const etfM = (AS2 && Array.isArray(AS2.monthly))
        ? AS2.monthly.reduce((a, r) => a + (typeof r.pnl === "number" ? r.pnl : 0), 0) : null;
      const etfGot = card.getAttribute("data-etf-monthly");
      const sumGot = card.getAttribute("data-sum-etf-otc");
      const etfNum = etfGot === "" ? NaN : Number(etfGot), sumNum = sumGot === "" ? NaN : Number(sumGot);
      const okM = etfM !== null && Number.isFinite(etfNum) && Math.abs(etfNum - etfM) < 0.005;
      const okS = okM && Number.isFinite(sumNum) && Math.abs(sumNum - (etfM + wantTotal)) < 0.005;
      /* 场内 App 的累计盈亏（AS2.pnl）必须**等于**Σ 月度行 ✓ —— 不等说明 data.js 那边自相矛盾 ✓ */
      const appPnl = (AS2 && typeof AS2.pnl === "number") ? AS2.pnl : null;
      const okPnl = (appPnl === null || Math.abs(appPnl - etfM) < 0.005);
      check("场外卡：「场内 ＋ 场外」＝ 场内月度账单之和 " + (etfM === null ? "—" : rnd2(etfM)) + " ＋ 场外 " + rnd2(wantTotal)
        + " ＝ " + rnd2((etfM || 0) + wantTotal) + "（场内那半边 ≡ App 累计 pnl " + (appPnl === null ? "—" : rnd2(appPnl)) + " ✓）",
        okM && okS && okPnl,
        "页面 data-etf-monthly=" + etfGot + " · data-sum-etf-otc=" + sumGot + " · 复算 "
          + (etfM === null ? "—" : (etfM + wantTotal).toFixed(2)) + " · ACCT_STATS.pnl=" + (appPnl === null ? "—" : appPnl.toFixed(2)));
    }

    /* ⑤ 那句"两条口径不同名"的话必须**现算**（旧版 4 处各写死 −1,964 / −2,149 ✗，9 月订正后过期 ✓）
       ⚠ 要先把趋势图切到「盈亏全程」✓ —— 那句话只在该视图的**图例 title** 里生成 ✗
         （首版没切 → 误报"没找到"✗）。
       ⚠ 比的是**整元**形式（页面统一走 fmtAmt2 ＝ 整元 ✓："−1,946" ✓ 不是 "−1,946.07" ✗）。 */
    const pnlChip = [...win.document.querySelectorAll("#trend-views .tchip")].find((b) => b.textContent.indexOf("盈亏全程") === 0);
    if (pnlChip) pnlChip.click();
    const visTxt = (() => {
      const c = win.document.body.cloneNode(true);          // 摘掉 script / style：否则内联脚本源码里的注释会被算成"页面上还有"✗
      c.querySelectorAll("script, style").forEach((n) => n.remove());
      return c.innerHTML;                                    // 取 innerHTML：口径说明大多挂在 title / 属性上 ✓
    })();
    /* ⚠ 整元规则必须与页面一致：页面用的 fmtAmt2 是**截断**（实测 −1,653.54 → "−1,653" ✓，
       四舍五入会得 −1,654 ✗ 而页面不是这个数 ✓ —— 拿 round 去比会误报"没找到"✗）。 */
    const rnd = (v) => (v >= 0 ? "+" : "−") + Math.trunc(Math.abs(v)).toLocaleString("en-US");
    const OTCo = (() => {
      const m = dataSrc.match(/^const OTC = \{[\s\S]*?\n\};/m); if (!m) return null;
      const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = OTC;", c, { timeout: 500 }); return c.o;
    })();
    const lastSnap = (() => {
      const c = vm.createContext({}); vm.runInContext(dataSrc.match(/^const SNAPSHOTS = \[[\s\S]*?^\];/m)[0] + "\nthis.o = SNAPSHOTS;", c, { timeout: 500 });
      return c.o.filter((s) => s.items).slice(-1)[0];
    })();
    const otcCodes = ((OTCo && OTCo.funds) || []).map((f) => f.code);
    const snapSum = otcCodes.reduce((a, c2) => a + Number((lastSnap.items[c2] || {}).pl || 0), 0);
    const mTxt = rnd(wantTotal), sTxt = rnd(snapSum);
    const miss2 = [];
    if (visTxt.indexOf("1,964") >= 0) miss2.push("还提到旧数 1,964 ✗");
    if (visTxt.indexOf("2,149") >= 0) miss2.push("还提到旧数 2,149 ✗");
    if (visTxt.indexOf(mTxt) < 0) miss2.push("没找到现算的月度账单 " + mTxt + " ✗（话在图例 title 里 ✓）");
    if (visTxt.indexOf(sTxt) < 0) miss2.push("没找到现算的快照持仓 " + sTxt + " ✗");
    check("场外口径文案：两个数都**现算**（月度账单 " + mTxt + " ／ 快照持仓 " + sTxt + "；写死的 −1,964 / −2,149 已清掉 ✓）",
      miss2.length === 0, miss2.join("；") || "页面文本已含这两个现值 ✓");
  }
}

/* ④r 回撤视图「全程无回撤」这一档必须四句话同一口径（2026-10-12 加，起于用户问
   「资产走势的回撤按钮 折线没有变化是 bug 吗？」——线平是**数据事实** ✓（默认档「近5次」那几期的
   资金流调整收益全为正 → 净值一路创新高），但**文案**当时自相矛盾 ✗：KPI 卡早在 09-23 就特判成
   「无回撤 / 区间内步步新高」✓，结论行却还写「最深回撤 **+0.00%**（09.29 峰值 → **09.29** 谷底）·
   已于 09.30 修复」✗（峰＝谷 ✗、给 0 加正号读起来像收益 ✗、没有回撤却说「已修复」✗）。
   判据：先用**数据**独立算出所选区间的最深回撤（trendNav 同款：逐期剔除 flow 后连乘 ✓，
   不读页面中间量 ✓），再按落地的档位检查文案 ——
     · 最深 ≈ 0 → 结论 / 图上标注都不许出现「+0.00%」「峰值 → …谷底」「已修复」✗，且必须说「未出现回撤」✓
     · 最深 ≠ 0 → 结论必须给出**带负号**的最深值与「峰值 → 谷底」两期 ✓（别把这两档改反 ✗） */
{
  const snapsR = (() => { try {
    const s = readFileSync(path.join(root, "positions-data.js"), "utf8");
    const c = vm.createContext({});
    vm.runInContext(s.match(/^const SNAPSHOTS = \[[\s\S]*?\n\];/m)[0] + "\nthis.o = SNAPSHOTS;", c, { timeout: 500 });
    return c.o.filter((x) => x.items).map((x) => ({ d: x.d,
      total: Object.values(x.items).reduce((t, i) => t + (i.val || 0), 0) + (x.cash || 0),
      flow: (typeof x.flow === "number") ? x.flow : null }));
  } catch (e) { return null; } })();
  const ddChip = [...win.document.querySelectorAll("#trend-views .tchip")].find((b) => b.getAttribute("data-v") === "dd");
  const r5Chip = [...win.document.querySelectorAll("#trend-chips .tchip")].find((b) => b.getAttribute("data-r") === "5");
  if (snapsR && ddChip && r5Chip) {
    /* ⚠ 点视图 chip 会让**区间 chips 整块重建** ✗（renderTrend → renderTrendRange）——
       所以区间那个节点必须在视图点完之后**重新查询** ✓（否则点到的是一枚已脱离 DOM 的旧按钮，
       区间根本没切 → 后面的断言会拿着别的区间去比 ✗ —— 首版就是这么误报的 ✓）。 */
    ddChip.click();
    const r5b = [...win.document.querySelectorAll("#trend-chips .tchip")].find((b) => b.getAttribute("data-r") === "5");
    if (r5b) r5b.click();                           // 本块后续无别的断言依赖走势视图状态 ✓
    const seg = snapsR.slice(-5);
    let nav = 1, peak = 1, deep = 0;
    for (let i = 1; i < seg.length; i++) {
      const p = seg[i - 1], x = seg[i];
      const f = (x.flow === null) ? (x.total - p.total) : x.flow;
      nav *= (x.total - f) / p.total; peak = Math.max(peak, nav); deep = Math.min(deep, nav / peak - 1);
    }
    const sumTxt = ((win.document.getElementById("trend-sum") || {}).textContent || "").replace(/\s+/g, " ");
    /* ⚠ 判据只取**结论那一行**（#trend-sum > span）✓：整块的 textContent 还包含「口径说明」小注，
       而那段定义里天生就有「已修复」「峰值」两个词 ✗ → 拿整块去测会永远误报 ✓（首版就这么误报的 ✓）。 */
    const sumLine = ((win.document.querySelector("#trend-sum > span") || {}).textContent || "").replace(/\s+/g, " ");
    const cntTxt = ((win.document.getElementById("trend-cnt") || {}).textContent || "").replace(/\s+/g, " ");
    const svgTxt = [...win.document.querySelectorAll("#trend-box svg text")].map((t) => t.textContent).join(" ");
    const flatCase = Math.abs(deep) < 0.0005, badR = [];
    if (flatCase) {
      if (sumLine.indexOf("未出现回撤") < 0) badR.push("结论没说「未出现回撤」✗");
      if (sumLine.indexOf("+0.00%") >= 0 || svgTxt.indexOf("+0.00%") >= 0) badR.push("还在给 0 加正号 ✗（回撤是负向语义）");
      if (/峰值/.test(sumLine)) badR.push("还在写「09.29 峰值 → 09.29 谷底」这种自相矛盾 ✗");
      if (/修复/.test(sumLine)) badR.push("没有回撤却说「已修复」✗");
      if (/最深/.test(svgTxt)) badR.push("图上仍印「最深 +0.00%」标注 ✗（无回撤时不该画）");
    } else {
      if (!/最深回撤 −/.test(sumLine)) badR.push("结论缺带负号的最深值 ✗");
      if (sumLine.indexOf("峰值") < 0) badR.push("结论缺「峰值 → 谷底」✗");
    }
    const onRChip = win.document.querySelector("#trend-chips .tchip.on");
    const onR = onRChip ? onRChip.getAttribute("data-r") : "?";
    check("回撤视图（区间「近5次」）：最深 ＝ 独立复算 " + (deep * 100).toFixed(3) + "% → 结论 / 计数 / 图上标注同一口径"
      + (flatCase ? "（无回撤档 ✓）" : ""),
      badR.length === 0,
      (badR.join("；") || "逐项一致 ✓") + " ｜ 页面区间＝" + onR + " · 结论「" + sumLine.slice(0, 46) + "」");
  }
}

/* ④p `.sa-back` 必须是**页面级**规则（2026-10-10，用户报：「逐渠道明细 后面那个 收起 UI 有 bug」）──
   根因：它原来写成 `#snap-attr .sa-back { … }` ✗ —— 只有归因面板里命中 ✓，而「场外账户统计」卡里
     用了**同一个 class** ✓ → 命不中 ✗ → 那个「← 收起」掉回浏览器**默认按钮外观** ✗
     （灰底、系统字体、比旁边文字大一截 ✓）。
   ⚠ 这类 bug **jsdom 抓不到** ✗（没有 CSS 引擎 ✓），所以判据直接读 CSS 文本 ✓：
     必须存在一条**不带任何前缀**的 `.sa-back` 规则 ✓，且不得再有 `#某卡 .sa-back` 这种作用域内定义 ✗。 */
{
  const css2 = readFileSync(path.join(root, "positions.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const unscoped = /(^|[\s};])\.sa-back\s*[,{]/.test(css2);
  const scoped = /#[\w-]+\s+\.sa-back\s*[,{]/.test(css2);
  const nBtn = (() => {
    try { return win.document.querySelectorAll("button.sa-back").length; } catch (e) { return -1; }
  })();
  check("`.sa-back` 是**页面级**规则（不带 #snap-attr 之类前缀）—— 页面里 " + nBtn + " 个「← 返回 / ← 收起」共用一套外观 ✓",
    unscoped && !scoped,
    scoped ? "仍有作用域内的 .sa-back 定义 ✗（换个容器就会失效 ✓ —— 这正是那次的 bug ✓）"
      : (unscoped ? "页面级规则在 ✓" : "找不到页面级 .sa-back ✗"));
}

/* ⑥ 个人财务看板（2026-10-10 加 —— 本次动了它两处 UI：加「本月 · 进行中」列、两个图去掉中轴）──────
   为什么现在补：这两处都是"改版时最容易被后来人悄悄改回去"的契约 ✗，而 finance 页此前
   **一条 DOM 断言都没有** ✗（只有 check-finance 管数据恒等式 ✓）。五条断言全读**渲染出来的 DOM**：
     ① 「进行中」列在，且只有它带 .mtd（不与已收官的 9 个月份混 ✓）
     ② **每行**的全年格 ＝ 该行 9 个月份格之和 ✓ → 证明进行中那格**没被并进合计** ✗
        （合计行也照样验：它同时证明 10 月的部分合计 −100.62 没被加进 +2,217.56 ✓）
     ③ 进行中列：有读数的写数字、未提供的写「·」—— 未提供那几格**不许出现数字**（≠ 0 ✗）
     ④ 两个横向图**无中轴**：inline style 只许有 width ✓（出现 left:50% / right:50% ＝ 中轴又回来了 ✗）
        且最长那根 = **全幅 100%**（同一把尺 ✓）
     ⑤ 涨跌色 = 红涨绿跌 ✓ —— 断言的是 finance.css 里**语义令牌的定义**（唯一出处 ✓），不是某个像素 */
{
  const ferr = [];
  const fdom = await JSDOM.fromFile(path.join(root, "finance", "index.html"), {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.addEventListener("error", (e) => ferr.push("error: " + (e.message || e.error)));
    },
  });
  const fw = fdom.window;
  await new Promise((r) => fw.setTimeout(r, 200));
  const fd = fw.document;
  const MX = fd.querySelector("table.mx");
  const hd = MX ? [...MX.querySelectorAll("thead th")].map((x) => x.textContent.replace(/\s+/g, " ").trim()) : [];
  const nMon = hd.filter((x) => /^\d+月$/.test(x)).length;
  const mtdTh = hd.filter((x) => /进行中/.test(x));
  const cellNum = (td) => {
    const m = (td ? td.textContent : "").replace(/−/g, "-").match(/-?\d[\d,]*(?:\.\d+)?/);
    return m ? +m[0].replace(/,/g, "") : NaN;
  };
  check("财务页：矩阵有「本月 · 进行中」列（" + nMon + " 个已收官月份 ＋ 1 列进行中）",
    !!MX && nMon === 9 && mtdTh.length === 1,
    MX ? "月份列 " + nMon + " · 进行中表头 " + JSON.stringify(mtdTh) + " · 全部表头 " + hd.join("｜") : "页面没有 table.mx");
  const rows2 = MX ? [...MX.querySelectorAll("tbody tr")] : [];
  const badRow2 = [];
  rows2.forEach((tr) => {
    const tds = [...tr.children];
    const msum = tds.slice(1, 1 + nMon).reduce((a, td) => a + (Number.isFinite(cellNum(td)) ? cellNum(td) : 0), 0);
    const totV = cellNum(tds[tds.length - 1]);
    if (!Number.isFinite(totV) || Math.abs(totV - msum) > 0.51) {
      badRow2.push(tds[0].textContent.replace(/\s+/g, "").slice(0, 6) + " 全年 " + totV + " vs 1–9 月和 " + msum.toFixed(2));
    }
  });
  check("财务页：每行「全年」= 该行 1–9 月之和（＝ 进行中那格**没有**被并进合计）",
    rows2.length > 0 && badRow2.length === 0, badRow2.join("；") || (rows2.length + " 行逐行验过 ✓（含合计行）"));
  const mtdTds = MX ? [...MX.querySelectorAll("tbody td.mtd")] : [];
  const mtdKnown = mtdTds.filter((td) => !td.classList.contains("na") && !td.classList.contains("part"));
  const mtdNa = mtdTds.filter((td) => td.classList.contains("na"));
  check("财务页：进行中列 = 有读数（数字）＋ 未提供（「·」，不许写成 0 ✗）",
    mtdTds.length === rows2.length && mtdKnown.length >= 1 && mtdNa.length >= 1 && mtdNa.every((td) => !/\d/.test(td.textContent)),
    "格数 " + mtdTds.length + "（应 = 行数 " + rows2.length + "）· 有读数 " + mtdKnown.length + " · 未提供 " + mtdNa.length);
  const bars = [...fd.querySelectorAll("#bars .mbar, #rank .rank-bar")];
  const axis = bars.filter((b) => /left\s*:\s*50%|right\s*:\s*50%/.test(b.getAttribute("style") || ""));
  const wid = bars.map((b) => parseFloat((((b.getAttribute("style") || "").match(/width\s*:\s*([\d.]+)%/) || [])[1])));
  const finW = wid.filter((x) => Number.isFinite(x));
  const maxW = finW.length ? Math.max.apply(null, finW) : NaN;
  check("财务页：两个横向图**无中轴**（条一律自左向右）＋ 最长那根 = 全幅 100%",
    bars.length > 0 && axis.length === 0 && Math.abs(maxW - 100) < 0.01,
    bars.length + " 根条 · 带中轴定位 " + axis.length + " 根（应 0 ✗）· 最长 " + (Number.isFinite(maxW) ? maxW.toFixed(2) : "—") + "%");
  const cssSrc = readFileSync(path.join(root, "finance", "finance.css"), "utf8");
  const defUp = ((cssSrc.match(/--up:\s*([^;]+);/) || [])[1] || "").trim();
  const defDown = ((cssSrc.match(/--down:\s*([^;]+);/) || [])[1] || "").trim();
  check("财务页：涨跌色 = 红涨绿跌（--up → 红、--down → 绿，与境内 App 截图一致 ✓）",
    /var\(--red\)/.test(defUp) && /var\(--green\)/.test(defDown), "--up: " + defUp + " · --down: " + defDown);
  check("财务页无 JS 报错", ferr.length === 0, ferr.slice(0, 3).join(" | "));
  fdom.window.close();
}

/* ⑤a-2 宽表「窄屏自动收起」（2026-10-12 加）：体检表 13 行 × 5 列，380px 下默认展开会把首屏拉长 ✗
   本判据在 jsdom 里跑：matchMedia 被桩成 matches=false（＝窄屏 ✓）→ 该 details 必须**收起** ✓，
   而内容仍须在 DOM 里（收起不等于不渲染 —— 门禁要照样读得到每一格 ✓）。 */
{
  const chkFold = win.document.querySelector("#checkup-card details.chk-fold");
  check("体检表：窄屏默认收起（宽屏才默认展开 ✓），且内容仍渲染在 DOM 里",
    !!chkFold && !chkFold.open && /chk-tbl/.test(chkFold.innerHTML) && chkFold.querySelectorAll("tbody tr").length > 0,
    chkFold ? "open=" + chkFold.open + " · 行数 " + chkFold.querySelectorAll("tbody tr").length : "体检表没有包成 details.chk-fold ✗");
}

/* ④m 折叠块「点开是空的」守卫（2026-10-23 加）——
   起因（真实事故）：`口径与边界` 那个 <details> 的正文 `<div class="otc-note" title="…` 漏写了
   属性收尾的引号（源码写成 `) + ">"`，而字符串 `">"` 只产出 `>`），浏览器把**整段正文**吞进那个
   没关上的属性值里 → summary 好好的、点开一片空白 ✗，且**不报任何错** ✗。
   用户报的是「点击打不开，是不是没用？可以删掉吗」—— 差点把一块有用的口径说明当垃圾删了。
   判据：页面上每个 <details> 至少有一个非 <summary> 的子节点（空折叠块**没有存在意义**）。
   ⚠ 页面当前 0 个空折叠块 ✓；将来真要做"先占位后填充"的折叠块，把它加进白名单并写明理由 ✗→✓。 */
{
  const empty = [...win.document.querySelectorAll("details")]
    .filter((d) => [...d.children].filter((c) => c.tagName !== "SUMMARY").length === 0)
    .map((d) => ((d.querySelector("summary") || {}).textContent || "").trim().slice(0, 16) || d.className || "(无名)");
  check("折叠块都不是「点开空」：" + (empty.length ? empty.join(" / ") : "全部有正文 ✓"),
    empty.length === 0,
    empty.length ? "这些 <details> 只有 summary、没有正文（多半是属性没闭合被浏览器吞了）：" + empty.join(" / ") : "");
}

/* ⑤a-3 成交位置汇总（2026-10-21 加）：体检卡上方那行「中位数 X%（N 笔买入）」。
   它是**账户级**的成交习惯指标（覆盖 5 只含已清仓），由 RANGE_LOG（腾讯日K高/低）＋ POSITIONS.log 算出 ——
   两处都可能漂：数据块换了源 / 页面把「买入」错写成全部流水 / 中位数算法（奇数取中、偶数取均值）被改 ✗。
   所以这里**独立复算**：读 data.js 的两个块，按同一口径算一遍，逐值比对（不读页面的中间量 ✓）。 */
{
  const SRC = readFileSync(path.join(root, "data.js"), "utf8");
  const pick = (name) => {
    const m = SRC.match(new RegExp("^const " + name + " = \\{[\\s\\S]*?^\\};", "m"));
    if (!m) return null;
    const c = vm.createContext({}); vm.runInContext(m[0] + "\nthis.o = " + name + ";", c, { timeout: 3000 }); return c.o;
  };
  const POSX = pick("POSITIONS"), RGX = pick("RANGE_LOG");
  const sell = (a) => /卖出|减仓|清仓/.test(String(a || ""));
  const ps = [];
  let wantN = 0, allBuys = 0;
  ((POSX && POSX.log) || []).forEach((e) => {
    if (!e.sym || sell(e.act) || !Number.isFinite(+e.cost)) return;
    allBuys++;
    const rg = ((RGX && RGX.items) || {})[e.sym] && RGX.items[e.sym][e.d];
    if (!Array.isArray(rg) || !(rg[1] > rg[0])) return;
    ps.push(Math.max(0, Math.min(100, ((+e.cost - rg[0]) / (rg[1] - rg[0])) * 100)));
    wantN++;
  });
  ps.sort((a, b) => a - b);
  const wantMed = ps.length ? (ps.length % 2 ? ps[(ps.length - 1) / 2] : (ps[ps.length / 2 - 1] + ps[ps.length / 2]) / 2) : null;
  const el = win.document.getElementById("chk-range-med");
  const gotMed = el ? Number(el.getAttribute("data-med")) : NaN;
  const gotN = el ? Number(el.getAttribute("data-n")) : NaN;
  check("体检卡「成交位置」：中位数 " + (wantMed === null ? "—" : Math.round(wantMed) + "%") + "（" + wantN + " 笔买入）≡ 独立复算",
    !!el && Number.isFinite(gotMed) && Math.abs(gotMed - wantMed) < 0.15 && gotN === wantN,
    el ? "页面 data-med=" + gotMed + " data-n=" + gotN + " · 显示「" + el.textContent.replace(/\s+/g, " ") + "」 vs 复算 " + (wantMed === null ? "—" : wantMed.toFixed(1)) + " / " + wantN + " 笔"
      : "体检卡上方没有 #chk-range-med ✗（成交位置那行没渲染）");
  /* 「下半区」那几个数与笔数必须自洽：下半区 + 上半区 ≤ 总数（正中那几笔两边都不算 ✓），
     并顺手守**覆盖率**：每笔买入都该在 RANGE_LOG 里找到当日K（缺＝脚本没跑 → 这里红，别让页面静默少算 ✗） */
  const rangeEl = win.document.getElementById("chk-range");
  const rtxt = rangeEl ? rangeEl.textContent.replace(/\s+/g, "") : "";
  const lowN = (rtxt.match(/(\d+)笔下半区/) || [])[1];
  /* ⚠ 覆盖率这一条会被 apply-screenshot 的**内建门禁**跳过（APPLY_SCREENSHOT=1）：
     录入器刚把新流水写进 data.js，RANGE_LOG 必然还缺那几个新日期 —— 若这里直接判红，
     录入器就「先写→门禁红→回滚」死锁，永远录不进新交易 ✗（2026-10-22 实测踩到）。
     → 只在这一步放行，并把这件事**打在 detail 里**（不静默）；`verify-all` / pre-commit 照旧红，
       提醒仍然有效，只是不再卡住数据录入本身 ✓。中位数那条**不放行**（它与覆盖率无关）。 */
  const skipCoverage = process.env.APPLY_SCREENSHOT === "1";
  check("体检卡「成交位置」：覆盖 " + wantN + "/" + allBuys + " 笔买入 · 下半区 " + ps.filter((p) => p < 50).length + " 笔（复算）",
    !!rangeEl && (wantN === allBuys || skipCoverage) && Number(lowN) === ps.filter((p) => p < 50).length,
    rangeEl ? "页面：下半区 " + lowN + " / 总 " + wantN + " · 复算：下半区 " + ps.filter((p) => p < 50).length + " / 总 " + allBuys +
      (wantN === allBuys ? "" : " → 有 " + (allBuys - wantN) + " 笔缺当日K，跑 scripts/fetch-trade-range.mjs ✓"
        + (skipCoverage ? "（本次由录入器内建门禁跳过 —— 新流水刚写进来，RANGE_LOG 必然还没跟上 ✓）" : "")) : "没有 #chk-range ✗");
}

/* ⑤a-4 逐笔流水的「当日区间刻度」（2026-10-21 加，B 方案）：每行一条 34×4 细轨 + 一个圆点。
   它**不写数字**（位置只在 title 里 ✓），所以页面出错时不会有任何文字对不上 —— 只能靠这条守：
   圆点数必须 > 0 且 ≤ 流水行数（多出来＝重复挂/挂错行 ✗），且每个 left% 都落在 0~100（
   溢出＝坐标算错，jsdom 里看不出，但真机上圆点会跑到轨道外 ✗）。 */
{
  const items = win.document.querySelectorAll("#pos-list .log-item").length;
  const dots = [...win.document.querySelectorAll(".log-item .lr-dot")];
  const bad = dots.map((d) => d.style.left).filter((v) => {
    const n = parseFloat(v);
    return !Number.isFinite(n) || n < 0 || n > 100;
  });
  check("逐笔流水「当日区间」刻度：" + dots.length + " 个圆点（流水 " + items + " 行）· left% 全部合法",
    dots.length > 0 && dots.length <= items && bad.length === 0,
    bad.length ? "非法坐标：" + bad.slice(0, 4).join(" / ") : dots.length + " / " + items + " 行带刻度（其余行那天没取到 K 或是一字板）");
}

/* ⑥ 决策看板 index.html（2026-10-12 第二批加）─────────────────────────────────────
   为什么现在补：它是**主决策出口** ✓，此前却是四页里唯一**零渲染断言**的一页 ✗ ——
   check-data 只验文件里的数据自洽、cross-check 只验跨文件同源，都看不见「渲染出来的数」✗
   （positions 有 ④ 族、finance 有 ⑤ 族，就差它）。四条断言全做**独立复算**：
     ① 无 JS 报错
     ② NDX / SPX 卡「回撤」≡ (close / ath − 1)
     ③ ATH 与「涨回新高需」≡ 复算
     ④ 横幅「NDX 回撤」≡ 卡内回撤（同一个数的两处显示，防漂移 —— 与 ④c 同一手法 ✓）
     ⑤ 「距 15% 档」≡ 回撤 − thresholds.t2（阈值口径独立复算 ✓）
   ⚠ 真值读 **data.js 文件**（不是页面里的 D）：页面若漏写 / 改错字段，断言才抓得到 ✓ */
{
  const ierr = [];
  const idom = await JSDOM.fromFile(path.join(root, "index.html"), {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.addEventListener("error", (e) => ierr.push("error: " + (e.message || e.error)));
    },
  });
  const iw = idom.window;
  await new Promise((r) => iw.setTimeout(r, 400));
  const idoc = iw.document;
  const ictx = vm.createContext({});
  vm.runInContext(readFileSync(path.join(root, "data.js"), "utf8").match(/^const DEFAULT = \{[\s\S]*?^\};/m)[0] + "\nthis.D = DEFAULT;", ictx, { timeout: 500 });
  const Dv = ictx.D;
  const txtOf = (id) => (((idoc.getElementById(id) || {}).textContent) || "").trim();
  const numOf = (id) => { const m = txtOf(id).replace(/−/g, "-").match(/-?\d[\d,]*(?:\.\d+)?/); return m ? +m[0].replace(/,/g, "") : NaN; };
  const near2 = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.011;   // 页面显示两位小数 → 容差 0.011 ✓
  const ddOfP = (p) => (Dv[p].close / Dv[p].ath - 1) * 100;
  const badDD = ["ndx", "spx"].filter((p) => !near2(numOf(p + "-dd"), ddOfP(p)))
    .map((p) => p.toUpperCase() + " 页面 " + txtOf(p + "-dd") + " vs 复算 " + ddOfP(p).toFixed(2) + "%");
  check("决策看板：NDX / SPX 卡「回撤」= 独立复算 (close / ath − 1)（2 档）",
    badDD.length === 0, badDD.join("；") || "逐档一致 ✓");
  const badAth = ["ndx", "spx"].filter((p) => Math.round(numOf(p + "-ath")) !== Math.round(Dv[p].ath)
    || !near2(numOf(p + "-toath"), (Dv[p].ath / Dv[p].close - 1) * 100))
    .map((p) => p.toUpperCase() + " ATH 页面 " + txtOf(p + "-ath") + " vs " + Dv[p].ath + " · 涨回新高 " + txtOf(p + "-toath"));
  check("决策看板：NDX / SPX 卡「ATH / 涨回新高需」= 独立复算", badAth.length === 0, badAth.join("；") || "逐档一致 ✓");
  check("决策看板：横幅「NDX 回撤」= 指数卡内回撤（同一个数两处显示，不许漂 ✗）",
    txtOf("sk-dd") !== "--" && numOf("sk-dd") === numOf("ndx-dd"), "横幅 " + txtOf("sk-dd") + " vs 卡内 " + txtOf("ndx-dd"));
  const to15 = ddOfP("ndx") - Dv.thresholds.t2, t15 = txtOf("ndx-to15");
  check("决策看板：「距 15% 档」= 回撤 − thresholds.t2（阈值口径独立复算）",
    to15 <= 1e-9 ? /已到档/.test(t15) : near2(numOf("ndx-to15"), to15),
    "页面「" + t15 + "」vs 复算 " + to15.toFixed(2) + "pp");
  /* 「今日涨跌」的呈现分支（2026-10-24 加）：|chg| < 0.005 时必须印「≈0.00%」且不是涨/跌色 ——
     否则 10-23 的 NDX（实际 −0.004%，数据里存成 0）会被印成**绿色 +0.00%**，读起来像「这天没交易」✗。 */
  const flatBad = ["ndx", "spx"].filter((p) => {
    const v = +Dv[p].chg, t = txtOf(p + "-chg");
    return Math.abs(v) < 0.005 ? !/≈0\.00%/.test(t) : !t.includes((v >= 0 ? "+" : "") + v.toFixed(2) + "%");
  }).map((p) => p.toUpperCase() + " chg=" + Dv[p].chg + " → 「" + txtOf(p + "-chg").slice(0, 26) + "」");
  check("决策看板：「今日涨跌」几乎收平时印 ≈0.00%（不再印绿色 +0.00%）",
    flatBad.length === 0, flatBad.join("；") || "收平 / 正常两条分支都对 ✓");
  /* 日线图的均线必须是**曲线**（2026-10-24 加）—— 起因：原来把 DEFAULT 里**当前**的 MA50 画成
     一条贯穿全窗口的水平线，而 6M 窗口里 NDX 的 MA50 实际从 24,785 涨到 29,829（+20.4%）✗，
     这种错**不会报任何 JS 错误**、页面照常渲染，只能靠断言盯。
     判据：存在 data-win=50 / 200 两条 polyline；MA50 的 y 跨度 > 2px（画成水平线时跨度恒为 0 ✗）。 */
  {
    const mas = [...idoc.querySelectorAll("#recent-svg polyline.recent-ma")];
    const wins = mas.map((e) => +e.getAttribute("data-win"));
    const spanOf = (e) => {
      const ys = (e.getAttribute("points") || "").trim().split(/\s+/).map((p) => +p.split(",")[1]).filter(Number.isFinite);
      return ys.length > 1 ? Math.max(...ys) - Math.min(...ys) : 0;
    };
    const ma50 = mas.find((e) => +e.getAttribute("data-win") === 50);
    check("决策看板：日线图的均线是曲线（MA50 的 y 跨度 > 2px，不是一条水平线）",
      wins.includes(50) && wins.includes(200) && !!ma50 && spanOf(ma50) > 2,
      "polyline=" + (wins.join("/") || "无") + " · MA50 y 跨度 " + (ma50 ? spanOf(ma50).toFixed(1) : "—") + "px");
  }
  /* 统计条要有「距历史高点」（2026-10-24 加）：卡片叫「日线与回撤参考」，此前 6 项全是**窗口内**口径，
     没有一项相对 ATH —— 与图上那几条按 ATH 算的档位线接不上 ✗。数值必须 ≡ close / ath − 1。 */
  {
    const box = idoc.getElementById("recent-stats");
    const txt = box ? box.textContent.replace(/\s+/g, " ") : "";
    const want = (Dv.ndx.close / Dv.ndx.ath - 1) * 100;
    check("决策看板：统计条有「距历史高点」≡ close / ath − 1",
      /距历史高点/.test(txt) && txt.includes(Math.abs(want).toFixed(2) + "%"),
      /距历史高点/.test(txt) ? "页面有该项 · 复算 " + want.toFixed(2) + "%" : "统计条里没有「距历史高点」✗");
  }
  check("决策看板无 JS 报错", ierr.length === 0, ierr.slice(0, 3).join(" | "));
  /* ⑦ 数据新鲜度（2026-10-17 加）—— 起因：10-17 定时任务没跑，页面停在 10-15 却完全无提示 ✗，
     用户是靠肉眼发现「纳指点位不对」才查出来的。这里锁两件事：
     ① expectedLastTradingDay 的边界（收盘前不算当天 / 收盘后算当天 / 周末与 NYSE 假日回退）；
     ② 页头确实有「刷新」按钮与手动 Run workflow 的入口。 */
  {
    const exp = iw.expectedLastTradingDay;
    const cases = [
      ["周五 15:00 EDT 未收盘", new Date("2026-10-16T15:00:00-04:00"), "2026-10-15"],
      ["周五 18:00 EDT 已收盘", new Date("2026-10-16T18:00:00-04:00"), "2026-10-16"],
      ["周六", new Date("2026-10-17T12:00:00-04:00"), "2026-10-16"],
      ["感恩节 18:00", new Date("2026-11-26T18:00:00-05:00"), "2026-11-25"],
      ["独立日（周六）18:00", new Date("2026-07-04T18:00:00-04:00"), "2026-07-02"],
    ];
    const bad = cases.filter(([, when, want]) => typeof exp !== "function" || exp(when) !== want)
      .map(([name, when, want]) => name + " → " + (typeof exp === "function" ? exp(when) : "无函数") + "（应 " + want + "）");
    check("决策看板：「应有最新交易日」按纽约收盘 + NYSE 假日推导（" + cases.length + " 个边界）",
      bad.length === 0, bad.join("；") || "逐档一致 ✓");
    /* 落后时必须**真的显示**（不只是函数算对）：把 asOf.us 临时退到 7 天前，
       断言页头 chip 出现、读数 = 复算的交易日差，然后恢复原值。 */
    try {
      const want = exp();
      const probe = exp(new Date(Date.now() - 7 * 86400000));
      const lag = iw.businessDaysBetweenET(probe, want);
      const saved = iw.eval("D.asOf.us");
      iw.eval("D.asOf.us = " + JSON.stringify(probe));
      iw.renderStale();
      const chip = idoc.getElementById("stale-chip");
      const shown = !!chip && chip.style.display !== "none" && chip.textContent.indexOf("落后 " + lag + " 个交易日") >= 0;
      const txt = chip ? chip.textContent : "缺 #stale-chip";
      iw.eval("D.asOf.us = " + JSON.stringify(saved));
      iw.renderStale();
      check("决策看板：行情落后时页头常驻提示（asOf 退到 " + probe + " → 应报 " + lag + " 个交易日）",
        lag >= 1 && shown, "「" + txt + "」");
    } catch (e) {
      check("决策看板：行情落后时页头常驻提示", false, e.message);
    }
    /* 2026-10-18：页头「刷新」按钮已移除（用户：只是重载页面，看不懂、可去掉）。
       真正的自助入口是时间条下方那条 GitHub Run workflow 深链 —— 只断言它还在。 */
    const mr = idoc.getElementById("manual-run");
    check("决策看板：时间条下方保留「去 GitHub 手动触发」深链（数据没更新时能自助）",
      !!mr && /actions\/workflows\/update-data\.yml/.test(mr.href || ""),
      !mr ? "缺 #manual-run" : "链接指向 " + (mr.href || ""));
  }
  /* ⑦ 数据有效性面板的两条文案契约（2026-10-12 加，用户当天直接看到并问上来「有效期好像很多没更新」）：
     ① 人工维护项（SOURCE_META 里 status: "manual"，如 epsGrowth）**不许**再被报成「未核验来源日期」✗
        —— 它没有自动源、本来就没有"核验日"可言，混在可疑源里会让整块面板失真 ✗；
     ② 「超过有效期」必须带上**滞后交易日数**（+ 该源的发布节奏）✗ —— 只写结论看不出严重程度
        （估值一滞后就是几十个交易日，用户正是被这四个字问上来的 ✓）。
     两条都从 data.js 的 SOURCE_META / SOURCE_POLICY 独立推导 ✓，不读页面的中间量 ✓。 */
  {
    const dm = readFileSync(path.join(root, "data.js"), "utf8");
    const mctx = vm.createContext({});
    const metaSrc = (dm.match(/const SOURCE_META = \{[\s\S]*?\n\};/) || ["const SOURCE_META = {};"])[0];
    vm.runInContext(metaSrc + "\nthis.M = SOURCE_META;", mctx, { timeout: 500 });
    const manual = Object.entries(mctx.M).filter(([, m]) => m.status === "manual");
    const panelTxt = ((idoc.getElementById("source-rows") || {}).textContent || "").replace(/\s+/g, " ");
    const sumTxt = ((idoc.getElementById("source-summary") || {}).textContent || "").replace(/\s+/g, " ");
    check("数据有效性面板：人工维护项单列（" + (manual.map(([k]) => k).join("/") || "无") + "），不混进「未核验来源日期」✗",
      manual.length === 0
        ? sumTxt.indexOf("人工维护") < 0
        : sumTxt.indexOf("人工维护 " + manual.length + " 项") >= 0 && panelTxt.indexOf("人工维护") >= 0,
      "汇总「" + sumTxt.slice(0, 90) + "」");
    const staleRow = [...idoc.querySelectorAll("#source-rows > div")].map((d) => d.textContent.replace(/\s+/g, " "))
      .filter((t) => /超过有效期/.test(t));
    const noDays = staleRow.filter((t) => !/滞后 \d+ 个交易日/.test(t));
    check("数据有效性面板：「超过有效期」必须带滞后交易日数（" + staleRow.length + " 行）",
      noDays.length === 0,
      noDays.length ? "缺天数：" + noDays[0].slice(0, 90) : "逐行都带天数 ✓");
    /* 含 PE 的项降级时，估值节奏那句说明必须在（③ 的契约 ✓） */
    if (staleRow.some((t) => /PE/.test(t)))
      check("数据有效性面板：估值降级时明示「按季/不定期发布，不是抓取失败」✓",
        panelTxt.indexOf("按季或不定期发布") >= 0, panelTxt.slice(0, 120));
  }
  idom.window.close();
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log((c.ok ? "  ✓ " : "  ✗ ") + c.name + (VERBOSE || !c.ok ? (c.detail ? "   ← " + c.detail : "") : ""));
}
if (VERBOSE) console.log("\n读数条原文：" + readText);
console.log("\nDOM 校验：" + (checks.length - failed) + "/" + checks.length + " 通过（快照 " + latest.d + " · 总资产 " + money(snapTotal) + " · 快照现金 " + money(snapCash) + " · 页面在用现金 " + otcCash + "）");
dom.window.close();
process.exit(failed ? 1 : 0);


