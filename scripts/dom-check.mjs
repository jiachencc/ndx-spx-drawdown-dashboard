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

/* ③ 汇总卡：总资产 与 累计浮盈亏 = 最新快照的读数 */
const sumText = sum ? sum.textContent.replace(/\s+/g, "") : "";
/* 总资产容差放到 3：页面是「快照逐只市值取整后求和」，与 App 总读数天然差 1 元以内 */
check("汇总卡总资产 = 最新快照 " + money(snapTotal), near(sumText, snapTotal, 3), sumText.slice(0, 140));
check("汇总卡浮盈亏 = 最新快照 " + money(latest.pl), near(sumText, latest.pl), sumText.slice(0, 140));

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
  /* 用户要求：定投中的行要标出**当前定投额** —— 漏了就是个静默的体验回退（标签只剩状态） */
  const liveChips = [...win.document.querySelectorAll("#otclog-card .dca-chip.ok")];
  check("定投中的行都标了当前定投额（" + liveChips.length + " 行）",
    liveChips.length > 0 && liveChips.every((el) => /元\/笔/.test(el.textContent)),
    liveChips.map((el) => el.textContent.trim()).join(" / ") || "没有「定投中」的行");
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

/* ④ 配置图：现金段显示的必须是快照现金 */
const allocText = alloc ? (alloc.textContent + " " + alloc.innerHTML).replace(/\s+/g, "") : "";
check("配置图现金 = 最新快照 " + money(snapCash), near(allocText, snapCash), allocText.slice(0, 200));

/* ⑤ 走势卡读数条：最新一期的总资产与浮盈亏（renderTrend 的成本口径含现金） */
const readText = readout ? readout.textContent.replace(/\s+/g, "") : "";
check("走势卡读数含最新总资产 " + money(snapTotal), near(readText, snapTotal, 3), readText.slice(0, 160));
check("走势卡读数含最新浮盈亏 " + money(latest.pl), near(readText, latest.pl), readText.slice(0, 160));

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
