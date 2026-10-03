#!/usr/bin/env node
/* 场外「当日收益」预估（nowcast）· 验证工具（**不是门禁、不进 CI**，手动跑）
 *
 * 用途：给页面那个预估数**定可信度** —— 变更代理、改拟合窗、怀疑 α/β 时，重跑一遍看误差。
 *      （日常门禁只做「形状 + 合理性」，见 data-quality.mjs 的 NOWCAST 合约；精度只能靠这个脚本。）
 *
 * 方法（严格样本外 walk-forward）：
 *   对每只基金、每个净值日 i（最近 250 天）：
 *     ① 先用 [i-60, i-1] 拟合 α/β  ② 用它们预测 i 日涨跌  ③ 与东财官方「日增长率」比
 *   对照基线：预测恒为 0（＝不做预估，也就是加这个功能之前的状态）。
 *   另外试 k = -1 / 0 / +1 三种日期对齐，让数据自己说净值日该配指数哪一天。
 *
 * 跑法：node scripts/nowcast-backtest.mjs
 * 2026-10-03 首次跑出的结论（已写进 fetch-nowcast.mjs 头部）：
 *   对齐 **k=0**（净值日 d ↔ 指数同日 d）；纳指 r 0.989 / 标普 0.991
 *   样本外 MAE：纳指 0.073~0.075pp · 标普 0.061pp（≈ 基线 1/13、1/10）· 日经 0.704 · 全球 0.942 · 港股 2.0
 *   组合加权 MAE 0.443%（±475 元/天）vs 不预估 1.114%（±1,196 元/天）；方向命中 91.6%
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HDR = { "User-Agent": "Mozilla/5.0 (compatible; ndx-dashboard/1.0)", Referer: "https://finance.sina.com.cn/" };
const curl = (url, extra = {}) => execFileSync("curl", ["-sS", "--max-time", "30",
  ...Object.entries({ ...HDR, ...extra }).flatMap(([k, v]) => ["-H", k + ": " + v]), url], { encoding: "utf8", maxBuffer: 3e8 });

/* 指数：新浪（美股）与腾讯（港股/A股ETF） —— 与 fetch-nowcast.mjs 同一批源 */
const sina = (sym) => { const s = curl("https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/var%20t=/US_MinKService.getDailyK?symbol=" + sym + "&___qn=3");
  return JSON.parse(s.slice(s.indexOf("["), s.lastIndexOf("]") + 1)).map((r) => ({ d: r.d, c: +r.c })); };
const tx = (code) => { const j = JSON.parse(curl("https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=" + code + ",day,,,320"));
  const k = Object.keys(j.data)[0]; return (j.data[k].day || []).map((r) => ({ d: r[0], c: +r[2] })); };
/* 净值：东财 pingzhongdata（含官方日增长率 equityReturn；时间戳 +8h 才是北京净值日） */
const navs = (code) => { const s = curl("https://fund.eastmoney.com/pingzhongdata/" + code + ".js", { Referer: "https://fund.eastmoney.com/" });
  const a = JSON.parse(s.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/)[1]);
  return a.map((r) => ({ d: new Date(r.x + 8 * 3600e3).toISOString().slice(0, 10), chg: +r.equityReturn })).filter((r) => Number.isFinite(r.chg)); };

const PROX = { ndx: () => sina(".NDX"), spx: () => sina(".INX"), hkus: () => tx("hkHSTECH"), n225: () => tx("sh513880"), global: () => sina(".NDX") };
const FIT_WIN = 60, USE = 250;

const posSrc = readFileSync(path.join(ROOT, "positions-data.js"), "utf8");
const c = vm.createContext({});
vm.runInContext(posSrc.match(/^const OTC = \{[\s\S]*?^\};/m)[0] + "\nthis.o = OTC;", c);
const funds = c.o.funds;

const idx = {};
for (const f of funds) { const k = f.theme; if (!idx[k]) idx[k] = PROX[k](); }
const ret = {};
for (const [k, a] of Object.entries(idx)) { const m = {}; for (let i = 1; i < a.length; i++) m[a[i].d] = a[i].c / a[i - 1].c - 1; ret[k] = m; }
const corr = (xs, ys) => { const n = xs.length, mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n;
  let a = 0, b = 0, d = 0; for (let i = 0; i < n; i++) { a += (xs[i] - mx) * (ys[i] - my); b += (xs[i] - mx) ** 2; d += (ys[i] - my) ** 2; }
  return a / Math.sqrt(b * d); };
const fit = (xs, ys) => { const n = xs.length, mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n;
  let a = 0, b = 0; for (let i = 0; i < n; i++) { a += (xs[i] - mx) * (ys[i] - my); b += (xs[i] - mx) ** 2; }
  const beta = b ? a / b : 0; return { alpha: my - beta * mx, beta }; };
const shift = (d, k) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };

console.log("=== 对齐（净值日 d ↔ 指数 d+k）===");
const bestK = {};
for (const f of funds) {
  const rows = navs(f.code);
  const rs = [-1, 0, 1].map((k) => { const v = rows.map((x) => ({ act: x.chg / 100, px: ret[f.theme][shift(x.d, k)] })).filter((x) => Number.isFinite(x.px) && Math.abs(x.act) < 0.12);
    return { k, n: v.length, r: corr(v.map((x) => x.px), v.map((x) => x.act)) }; });
  bestK[f.code] = rs.slice().sort((a, b) => b.r - a.r)[0].k;
  console.log("  " + String(f.name).padEnd(24).slice(0, 24) + rs.map((x) => ("k=" + x.k + " " + x.r.toFixed(3)).padStart(12)).join("") + "  → k=" + bestK[f.code]);
}

console.log("\n=== 样本外精度（最近 " + USE + " 天 · 窗 " + FIT_WIN + "）===");
console.log("  基金            样本  │ 预估 MAE  RMSE │ 基线 MAE │ 方向命中");
const out = [];
for (const f of funds) {
  const k = bestK[f.code];
  const v = navs(f.code).map((x) => ({ act: x.chg / 100, px: ret[f.theme][shift(x.d, k)] })).filter((x) => Number.isFinite(x.px) && Math.abs(x.act) < 0.12);
  const xs = v.map((x) => x.px), ys = v.map((x) => x.act);
  const eA = [], eZ = []; let hit = 0, hn = 0;
  for (let i = Math.max(FIT_WIN, v.length - USE); i < v.length; i++) {
    const { alpha, beta } = fit(xs.slice(i - FIT_WIN, i), ys.slice(i - FIT_WIN, i));
    const p = alpha + beta * xs[i];
    eA.push(Math.abs(p - ys[i])); eZ.push(Math.abs(ys[i]));
    if (Math.abs(p) > 0.002) { hit += Math.sign(p) === Math.sign(ys[i]) ? 1 : 0; hn++; }
  }
  const m = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  out.push({ code: f.code, value: f.value, mae: m(eA), mae0: m(eZ) });
  console.log("  " + String(f.name).padEnd(24).slice(0, 24) + String(eA.length).padStart(4) + "  │ " +
    (m(eA) * 100).toFixed(3).padStart(7) + "pp" + (Math.sqrt(eA.reduce((s, x) => s + x * x, 0) / eA.length) * 100).toFixed(3).padStart(7) + "pp │" +
    (m(eZ) * 100).toFixed(3).padStart(8) + "pp │" + (hit / hn * 100).toFixed(1).padStart(6) + "%");
}
/* 组合口径：按当前市值加权 → 换算成「场外当日收益（估）」的金额误差（这才是用户在屏幕上看到的量级） */
const w = out.reduce((s, o) => s + o.value, 0);
const wm = (key) => out.reduce((s, o) => s + o.value * o[key], 0) / w;
console.log("\n  组合加权 MAE  预估 " + (wm("mae") * 100).toFixed(3) + "%  → 场外 " + Math.round(w).toLocaleString() +
  " 元上，每天典型误差 ≈ ±" + Math.round(wm("mae") * w) + " 元");
console.log("                不预估 " + (wm("mae0") * 100).toFixed(3) + "%  → ≈ ±" + Math.round(wm("mae0") * w) + " 元（＝现在的做法）");
