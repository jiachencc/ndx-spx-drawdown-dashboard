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
const src = readFileSync(path.join(root, "positions.html"), "utf8");
const ctx = vm.createContext({});
vm.runInContext(src.match(/^const SNAPSHOTS = \[[\s\S]*?^\];/m)[0] + "\nthis.rows = SNAPSHOTS;", ctx, { timeout: 500 });
const latest = ctx.rows.filter((s) => s.items).at(-1);
const snapCash = latest.cash;                                                        // 真值
const snapTotal = Object.values(latest.items).reduce((a, it) => a + it.val, 0) + snapCash;
const otcCash = +src.match(/cash:\s*([\d.]+)/)[1];                                    // 页面实际在用的值

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
const numsOf = (t) => (t.match(/-?\d[\d,]*(?:\.\d+)?/g) || []).map((s) => +s.replace(/,/g, ""));
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

/* ③b 汇总卡「当日盈亏」= 最新快照的 day（2026-09-23 加）
   页面当日 = 场内估（DEFAULT.chg × 份数）+ 场外快（Σ OTC.funds[].day），必须与快照里留档的 day 对得上。
   这是「当日」在渲染层唯一的校验点，也顺带看住两种偏差：
   ① 报价或场外读数被改过、而快照没跟着改；② 当日栏的算法改动没同步到数据。
   容差 5：场内/场外两段各自取整后相加，与未取整的合计天然差 1~2 元。 */
const dayCell = sum ? [...sum.querySelectorAll(".sum-cell")].map((el) => el.textContent.replace(/\s+/g, "")).find((t) => t.includes("当日盈亏")) : null;
check("汇总卡当日盈亏 = 最新快照 " + money(latest.day), !!dayCell && near(dayCell, latest.day, 5), dayCell ? dayCell.slice(0, 140) : "未找到「当日盈亏」单元");

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
