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
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const near = (t, v, tol = 1) => numsOf(t).some((n) => Math.abs(n - v) <= tol);

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
const closedGap = (() => {
  const log = ((LOGPOS && LOGPOS.log) || []).slice().sort((a, b) => (a.d === b.d ? 0 : a.d < b.d ? -1 : 1));
  const qty = {}, gap = {};
  log.forEach((e) => {
    const s = /卖出|减仓|清仓/.test(String(e.act || "")), before = qty[e.sym] || 0;
    qty[e.sym] = before + (s ? -(e.qty || 0) : (e.qty || 0));
    if (s && before > 0 && qty[e.sym] === 0 && Number.isFinite(e.realized)) gap[e.sym] = (gap[e.sym] || 0) - e.realized;
  });
  return Object.keys(gap).reduce((a, k) => a + gap[k], 0);
})();

/* ③ 汇总卡：总资产 与 累计收益 = 最新快照的读数 */
const sumText = sum ? sum.textContent.replace(/\s+/g, "") : "";
/* 总资产容差放到 3：页面是「快照逐只市值取整后求和」，与 App 总读数天然差 1 元以内 */
check("汇总卡总资产 = 最新快照 " + money(snapTotal), near(sumText, snapTotal, 3), sumText.slice(0, 140));
/* ⚠ 2026-10-09 改口径（用户选 A）：汇总卡那格由「浮盈亏」改为「累计收益（含已实现）」——
   快照 pl 是**摊薄口径的在持浮盈亏**（＝券商 App 的浮动盈亏），全额清仓后它不含已兑现那部分 ✗；
   真·累计收益 = pl − closedGap ✓（10-09：19,988.31 − 18,492.00 = +1,496 ✓）。
   closedGap 由本文件独立复算（读 data.js 的 POSITIONS.log），不读页面中间量 ✓。 */
check("汇总卡累计收益 = 最新快照 pl − 全额清仓已实现 " + money(latest.pl - closedGap),
  near(sumText, latest.pl - closedGap), sumText.slice(0, 140));

/* ③b 汇总卡「当日盈亏」= 场内估 + 场外【预估】（2026-10-03：场外那半从"App 快照"换成"指数×仓位补齐"）
   两段的性质不同，必须分开断言：
     ① 三栏自洽：场内 ＋ 场外 ＝ 合计（页面内部一致，tol 1 元）
     ② 场外那一半 = 用 data.js 的 NOWCAST + positions-data.js 的 OTC **独立复算**出来的预估（tol 5 元）——
        这条是有效的那条：它把页面数字锚在**数据**上，而不是与页面自己的中间量比（与自己比永远自洽）。
        ⚠ 它拦得住**页面侧**的错（窗口/对齐/分档抄错、忘了排除 dir 档），拦不住**数据侧**的错 ——
          因为两边读的是同一份 NOWCAST。数据侧的合理性由 check-data 的 NOWCAST 合约把关
          （r 高时 beta 必须贴近 1、tier 必须与 mae/r 自洽）。2026-10-03 把这个边界实测确认过。
     ③ 场外那半的【已公布】部分（App 快照 Σ day）必须**仍出现在副标里** —— 预估是"补上去"的，不是"顶掉"的。
     ⚠ NOWCAST 缺失（老数据 / 脚本没跑）时页面退回 App 快照口径，这里同步按老口径断言。 */
const dayCellEl = sum ? [...sum.querySelectorAll(".sum-cell")].find((el) => el.textContent.includes("当日盈亏")) : null;
const dayCell = dayCellEl ? dayCellEl.textContent.replace(/\s+/g, "") : null;
const splitVals = dayCellEl ? [...dayCellEl.querySelectorAll(".s-split-cell .s-split-v")].map((e) => numsOf(e.textContent)[0]) : [];
if (splitVals.length === 3) {
  const [vEtf, vOtc, vAll] = splitVals;
  check("汇总卡当日盈亏三栏自洽（场内 ＋ 场外 ＝ 合计）", Math.abs(vEtf + vOtc - vAll) <= 1,
    "场内 " + vEtf + " ＋ 场外 " + vOtc + " = " + vAll);
} else {
  check("汇总卡当日盈亏三栏可解析", false, dayCell ? dayCell.slice(0, 140) : "未找到「当日盈亏」单元");
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
/* 场外那半要用的两份数据：先取出来（⚠ 定义必须在用之前 —— 2026-10-03 这里踩过一次 TDZ） */
const nowcastSrc = (() => { try { const s = readFileSync(path.join(root, "data.js"), "utf8"); const m = s.match(/^const NOWCAST = \{[\s\S]*?^\};/m); return m ? m[0] : null; } catch { return null; } })();
const NC = (() => { if (!nowcastSrc) return null; const c = vm.createContext({}); vm.runInContext(nowcastSrc + "\nthis.n = NOWCAST;", c, { timeout: 500 }); return c.n; })();
const OC = (() => { const c = vm.createContext({}); vm.runInContext(dataSrc.match(/^const OTC = \{[\s\S]*?^\};/m)[0] + "\nthis.o = OTC;", c, { timeout: 500 }); return c.o; })();
const otcDayApp = OC.funds.reduce((a, f) => a + (Number.isFinite(f.day) ? f.day : 0), 0);
/* ③b-0 预估值与「快照 day」只比**量级**（2026-10-03 改）：两者口径本就不同 ——
   快照 day 是"场内当日 ＋ 场外已公布"，页面合计是"场内估值 ＋ 场外预估补齐"，不该相等；
   但若差出半个场外，说明 beta / 窗口 / 对齐错了。（旧版是严格比相等，那是场外还是 App 快照时候的事。） */
{
  const otcVal = OC.funds.reduce((a, f) => a + f.value, 0);
  const tol = Math.max(50, otcVal * 0.05);
  check("当日盈亏合计与快照 day 量级一致（±" + money(tol) + " 内 · 口径不同故不比相等）",
    splitVals.length === 3 && Math.abs(splitVals[2] - latest.day) <= tol,
    splitVals.length === 3 ? "页面合计 " + splitVals[2] + " vs 快照 day " + latest.day.toFixed(2) + "（差 " + (splitVals[2] - latest.day).toFixed(2) + "）" : "三栏未解析");
}
/* 场外那半：① 与「从数据独立复算的预估」比（有效的那条）② App 快照那部分必须仍在副标里 */
/* 与页面同一算法（口径见 positions.html 里那段注释）—— 故意重写一遍：抄页面的中间量就不叫独立校验了 */
const recomputeOtc = (nc, o) => {
  let amt = 0;
  for (const f of o.funds) {
    const ft = nc && nc.fits[f.code], ser = ft && nc.idx[ft.prox];
    if (!ft || !ser || ser.length < 2) { amt += (Number.isFinite(f.day) ? f.day : 0); continue; }
    if (ft.tier === "dir") continue;                         // 跟踪弱 → 只给方向、不进金额
    const i0 = ser.findIndex((p) => p.d > ft.navDate);
    if (i0 < 1) { amt += (Number.isFinite(f.day) ? f.day : 0); continue; }
    let g = 1;
    for (let i = i0; i < ser.length; i++) g *= 1 + (ft.alpha + ft.beta * (ser[i].c / ser[i - 1].c - 1) * 100) / 100;
    amt += f.value * (g - 1);
  }
  return amt;
};
if (splitVals.length === 3) {
  const expect = NC ? recomputeOtc(NC, OC) : otcDayApp;
  check("汇总卡「场外" + (NC ? "（预估）" : "快") + "」= " + (NC ? "独立复算的预估 " : "App 快照 ") + money(expect),
    Math.abs(splitVals[1] - expect) <= 5,
    "页面 " + splitVals[1] + " vs 复算 " + expect.toFixed(2) + (NC ? "（NOWCAST " + NC.updated + "）" : "") + (traded ? "（本期有买卖）" : ""));
}
const subText = dayCellEl && dayCellEl.querySelector(".s-sub") ? dayCellEl.querySelector(".s-sub").textContent : "";
check("汇总卡副标仍保留 App 快照（已公布的那部分）" + money(otcDayApp), near(subText, otcDayApp, 5),
  (subText || "（无副标）").replace(/\s+/g, " ").trim().slice(0, 160));

/* ③c 逐只拆解表（2026-10-03 加，挂在汇总卡内）：① 合计必须等于 KPI 里那个场外数
   ② 8 只场外基金一只不落（少一行就是渲染漏了，这种错肉眼很难发现） */
{
  const box = win.document.querySelector("#otc-est");
  const rows = box ? [...box.querySelectorAll("tbody tr")] : [];
  const sumRow = rows.find((tr) => tr.classList.contains("sum"));
  /* ⚠ 只取金额那一格：整行 textContent 里还有「计入金额的 7 只」，numsOf 会先抓到那个 7 */
  const sumCell = sumRow ? sumRow.querySelector(".e-amt") : null;
  const sumVal = sumCell ? numsOf(sumCell.textContent)[0] : null;
  check("逐只拆解表「合计」= KPI 里的场外数 " + (splitVals.length === 3 ? splitVals[1] : "?"),
    rows.length > 0 && Number.isFinite(sumVal) && splitVals.length === 3 && Math.abs(sumVal - splitVals[1]) <= 1,
    "表合计 " + sumVal + " vs KPI 场外 " + splitVals[1] + "（表内 " + Math.max(0, rows.length - 1) + " 行）");
  check("逐只拆解表覆盖全部 " + OC.funds.length + " 只场外基金",
    rows.length === OC.funds.length + 1, "表内 " + Math.max(0, rows.length - 1) + " 行 ＋ 合计 1 行 = " + rows.length);
}

/* ③e 场外定投 · 操作记录（2026-10-04 加）：① 体检表覆盖全部场外基金 ② 逐笔明细的笔数 = OTC_LOG 总笔数
   （在 391 行里漏一只基金、漏一批笔，肉眼根本看不出来 —— 只能这样数） */
{
  const tbl = win.document.querySelector("#otclog-card table.dca-tbl");
  const bodyRows = tbl ? [...tbl.querySelectorAll("tbody tr")] : [];
  const OCL = (() => {
    const c = vm.createContext({});
    vm.runInContext(dataSrc.match(/^const OTC_LOG = \{[\s\S]*?^\};/m)[0] + "\nthis.o = OTC_LOG;", c, { timeout: 500 });
    return c.o;
  })();
  const nFunds = OC.funds.length;
  check("场外体检表 = " + nFunds + " 只 + 合计 1 行", bodyRows.length === nFunds + 1, "表内 " + bodyRows.length + " 行");
  const logTotal = OC.funds.reduce((a, f) => a + ((OCL[f.code] || []).length), 0);
  const listed = [...win.document.querySelectorAll("#otclog-card .dca-list li")].length;
  check("逐笔明细笔数 = OTC_LOG 总笔数 " + logTotal, listed === logTotal, "明细里 " + listed + " 行");
  /* 静默天数的基准日必须是场外快照日（用系统「今天」会让这张表每天自己变形） */
  const note = win.document.querySelector("#otclog-card .otc-note");
  check("体检表口径注写明基准日 " + OC.updated, !!note && note.textContent.indexOf(OC.updated) >= 0);
  /* 用户要求：定投中的行要标出**当前定投额** —— 漏了就是个静默的体验回退（标签只剩状态）
     ⚠ 2026-10-08 修正：原来还要求 liveChips.length > 0，那是把"录入那一天恰好有定投中的行"
       当成了不变的真理 ✗ —— 场外定投自 08-30 起改为手动申购、末笔多在 09-29/30；
       过国庆长假（7 天）后「静默 ≤7 天」的行**必然为 0**，门禁会在这种**正常状态**下报红
       （本次录 10-08 数据时正是被它拦下的）。改为只要求"有则必须标出当前额" ✓
       —— 那才是用户当初要防的回退点；并把 0 行的情况写进消息，不让它变成静默的假绿 ✓ */
  const liveChips = [...win.document.querySelectorAll("#otclog-card .dca-chip.ok")];
  check("定投中的行都标了当前定投额（" + liveChips.length + " 行）",
    liveChips.every((el) => /元\/笔/.test(el.textContent)),
    liveChips.length ? liveChips.map((el) => el.textContent.trim()).join(" / ")
      : "当前没有「定投中」的行（末笔静默已 >7 天）—— 断言只要求「有则标出」");
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

/* ③g 场外逐笔盈亏（2026-10-04 加）：① 「定投 vs 一次性」表 = 有净值的只数 + 合计
   ② 逐笔明细里带净值的行数 = 独立复算的「成功且非赎回、且 OTC_BUYNAV 覆盖该日期」的笔数
   —— 查表漏一笔，那一笔的盈亏就静默消失，在 391 行里肉眼看不出来 */
{
  const card = win.document.querySelector("#otclog-card");
  const tbls = card ? [...card.querySelectorAll("table.dca-tbl")] : [];
  const rows = tbls[1] ? [...tbls[1].querySelectorAll("tbody tr")] : [];
  const nPx = OC.funds.filter((f) => f.nav && Number.isFinite(f.nav.close)).length;
  check("「定投 vs 一次性」表 = " + nPx + " 只 + 合计 1 行", rows.length === nPx + 1, "表内 " + rows.length + " 行");
  const OBN = (() => { const c = vm.createContext({}); vm.runInContext(dataSrc.match(/^const OTC_BUYNAV = \{[\s\S]*?^\};/m)[0] + "\nthis.o = OTC_BUYNAV;", c, { timeout: 500 }); return c.o; })();
  const OCL2 = (() => { const c = vm.createContext({}); vm.runInContext(dataSrc.match(/^const OTC_LOG = \{[\s\S]*?^\};/m)[0] + "\nthis.o = OTC_LOG;", c, { timeout: 500 }); return c.o; })();
  let expect = 0;
  OC.funds.forEach((f) => {
    const bn = OBN[f.code] || {};
    (OCL2[f.code] || []).forEach((t) => { if (t.status === "成功" && !/赎回/.test(String(t.act)) && bn[t.d]) expect++; });
  });
  const listed = [...win.document.querySelectorAll("#otclog-card .dca-list li .d-nav")].filter((el) => el.textContent.trim() !== "—").length;
  check("逐笔明细带净值的行数 = 独立复算 " + expect + " 笔", listed === expect, "明细里 " + listed + " 行");
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
  const sOtc = CL ? CL.items.reduce((a, r) => a + r.pnl, 0) : 0;
  const totEl = cardEl ? cardEl.querySelector("#closed-all-total") : null;
  check("清仓历史总行 = 场外 " + money(sOtc) + " ＋ 场内 " + money(sEtf),
    !!totEl && near(totEl.textContent.replace(/\s+/g, ""), sOtc + sEtf, 0.01),
    totEl ? totEl.textContent.replace(/\s+/g, " ").trim().slice(0, 100) : "卡内没有 #closed-all-total");
  const cardTxt = cardEl ? cardEl.textContent.replace(/\s+/g, "") : "";
  check("清仓历史「按平台汇总」含 平安证券 " + money(sEtf) + "（场内）与 支付宝 " + money(sOtc) + "（场外）",
    /按平台汇总/.test(cardTxt) && near(cardTxt, sEtf, 0.01) && near(cardTxt, sOtc, 0.01), cardTxt.slice(0, 130));
  const badD = etfClosed.filter((o) => {
    const row = cardEl ? cardEl.querySelector('[data-sym="' + o.k + '"]') : null;
    return !row || row.textContent.replace(/\s+/g, "").indexOf(lastSell[o.k].slice(5)) < 0;
  }).map((o) => o.k + "（应为 " + lastSell[o.k] + "）");
  check("清仓历史明细：场内每只「清仓日」= 该标的最后一笔卖出日（" + etfClosed.length + " 只）",
    badD.length === 0, badD.length ? "对不上：" + badD.join("、") : "逐只核对通过 ✓");
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
  const prevS = full[full.length - 2], curS = full[full.length - 1];
  const cleared = prevS ? Object.keys(prevS.items).filter((code) => !curS.items[code]) : [];
  const want = cleared.filter((code) => /ETF|LOF/.test(prevS.items[code].name)).map((code) => {
    const nm = prevS.items[code].name;
    const sell = ((P2 && P2.log) || []).filter((e) => /卖出|减仓|清仓/.test(String(e.act || "")) &&
      e.sym === nm && e.d > prevS.d && e.d <= curS.d)[0];
    return (sell && Number.isFinite(sell.realized))
      ? { nm: nm, v: (sell.realized + (prevS.items[code].cost || 0)) - (prevS.items[code].val || 0) } : null;
  }).filter(Boolean);
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
      d = (sell && Number.isFinite(sell.realized)) ? (sell.realized + (a.cost || 0)) - (a.val || 0) : -(a.pl || 0);
    }
    sums[etfSet.has(code) ? "in" : "ot"] += d;
  });
  const arts = [...win.document.querySelectorAll("#snap-list article.snap-item")];
  const gs = arts.length ? [...arts[0].querySelectorAll(".snap-group-sum")] : [];
  const gn = (el) => {
    const m = (el.textContent.match(/[-−]?\d[\d,]*(?:\.\d+)?/g) || []).map((s) => +s.replace(/,/g, "").replace("−", "-"));
    return m.length ? m[m.length - 1] : null;
  };
  const gotIn = gs.length > 0 ? gn(gs[0]) : null;
  const gotOt = gs.length > 1 ? gn(gs[1]) : null;
  check("快照对比「场内」分组小计 = 复算 " + money(sums.in) + "（不再把清仓浮亏消失当收益 ✗）",
    gotIn !== null && Math.abs(gotIn - sums.in) <= 1, "组小计 " + gotIn + " vs 复算 " + sums.in.toFixed(2));
  check("快照对比「场外」分组小计 = 复算 " + money(sums.ot),
    gotOt !== null && Math.abs(gotOt - sums.ot) <= 1, "组小计 " + gotOt + " vs 复算 " + sums.ot.toFixed(2));
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
  check("汇总卡累计收益 = Σ逐只 pl ＋ 全额清仓已实现 " + money(wantPl),
    Number.isFinite(gpl) && Math.abs(gpl - wantPl) < 3,
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
  const item = win.document.querySelector(".snap-item");        // 新在上 → 第一张＝最新一期
  const fn = win.closedEtfRows;
  const rows = (typeof fn === "function") ? fn() : [];
  const bad = [];
  rows.forEach((r) => {
    const row = item ? [...item.querySelectorAll(".snap-line.item")].find((x) => x.textContent.indexOf(r.sym) >= 0) : null;
    const cv = row ? row.querySelector(".cv") : null;
    if (!cv || !near(cv.textContent, r.pnl, 1))
      bad.push(r.sym + "：" + (cv ? cv.textContent.replace(/\s+/g, "") : "(最新一期没有这一行 ✗)") + " ≠ " + r.pnl.toFixed(2));
  });
  check("快照对比「清仓行 · 总盈亏」= 清仓历史同只（" + rows.length + " 只：" + rows.map((r) => r.sym).join("/") + "）",
    rows.length > 0 && bad.length === 0, bad.length ? "对不上：" + bad.join("、") : "逐只核对通过 ✓");
}

/* ⑤ 全页 SVG 不得出现非法坐标（NaN 会被浏览器按 0 渲染 → 横跨全屏的错位填充） */
const bad = [];
win.document.querySelectorAll("svg *").forEach((el) => {
  for (const a of el.attributes) if (/NaN|Infinity|undefined/.test(a.value)) bad.push(el.tagName + "[" + a.name + "]");
});
check("SVG 无非法坐标", bad.length === 0, bad.slice(0, 5).join(" "));

check("页面无 JS 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log((c.ok ? "  ✓ " : "  ✗ ") + c.name + (VERBOSE || !c.ok ? (c.detail ? "   ← " + c.detail : "") : ""));
}
if (VERBOSE) console.log("\n读数条原文：" + readText);
console.log("\nDOM 校验：" + (checks.length - failed) + "/" + checks.length + " 通过（快照 " + latest.d + " · 总资产 " + money(snapTotal) + " · 快照现金 " + money(snapCash) + " · 页面在用现金 " + otcCash + "）");
dom.window.close();
process.exit(failed ? 1 : 0);
