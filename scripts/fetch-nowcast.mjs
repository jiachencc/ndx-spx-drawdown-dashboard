#!/usr/bin/env node
/* 场外「当日收益」预估（nowcast）· 取数与拟合（AUTO 块 NOWCAST 的唯一写者）
 *
 * ── 为什么需要 ────────────────────────────────────────────────────────────────
 * 场外 QDII 基金净值晚 1~2 天公布（华安更慢），所以 App 的「日收益」永远是旧的；
 * 但**净值日 d 的变化 ↔ 代理指数同日 d 的涨跌**高度相关（实测：纳指 0.989 / 标普 0.991），
 * 于是可以用「最后净值日之后那几天的指数涨跌 × 拟合 β」把还没公布的那段补齐。
 *
 * ── 精度（2026-10-03 回测 · 250 个净值日 · 严格样本外 walk-forward）────────────
 *   纳指100 ×4 只  0.073~0.075pp   ← 不预估（猜 0）的 1/13
 *   标普500        0.061pp         ← 1/10
 *   摩根日本        0.704pp（A股日经ETF 作代理，含溢价噪声）
 *   广发全球精选    0.942pp（用纳指代；该基金是主动型，跟踪不紧）
 *   中欧港股数字    1.999pp（r 仅 0.51，主动混合基金，跟踪不到位）→ 只给方向
 *   → 组合口径 MAE 0.443%（±475 元/天），不预估是 ±1,196 元/天；方向命中 91.6%
 *   → 所以页面上按 tier 分档：num（给数字）/ ref（给数字＋标"参考"）/ dir（只给涨跌方向）
 *
 * ── 数据源（本机与 CI 均实测可达）─────────────────────────────────────────────
 *   指数：新浪 .NDX / .INX（末值与仓库 Yahoo 值逐点一致，差 ≤0.01 点）
 *         腾讯 hkHSTECH（恒生科技）、腾讯 sh513880（A股日经ETF：日经225 无实时源，只能用它，
 *         代价是含 A股溢价噪声 —— 已体现在 0.70pp 这个误差里；A股休市期间它不更新，页面会显「—」）
 *   净值：东财 pingzhongdata（一次拿全量历史，含官方日增长率 equityReturn）
 *
 * ── 对齐（不假设，实证）───────────────────────────────────────────────────────
 *   净值日 d ↔ 指数**同日** d（对 8 只基金分别试 k=-1/0/+1，全部以 k=0 相关最高）
 *   ⚠ 所以窗口 = 指数里【严格晚于东财净值日】的那几根；用东财净值日而不用 App 截图日 ——
 *     因为拟合就是用东财日期做的，两者必须同一套日期（App 的「净值日」偶有 +1 的显示差异）。
 *
 * 跑法：node scripts/fetch-nowcast.mjs          （退出码非 0 = 有问题；校验不过不写 data.js）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { readModel, validateModel } from "./data-quality.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data.js");
const POS = path.join(ROOT, "positions-data.js");
const HDR = { "User-Agent": "Mozilla/5.0 (compatible; ndx-dashboard/1.0)", Referer: "https://finance.sina.com.cn/" };

/* theme → 代理指数（theme 来自 OTC.funds[].theme，见 positions-data.js）
 * ⚠ global（广发全球精选）用纳指代：实测 r 0.805 优于标普 0.673（它是全球成长风格） */
const PROX = {
  ndx: { key: "ndx", label: "纳指100", fetch: () => sina(".NDX") },
  spx: { key: "spx", label: "标普500", fetch: () => sina(".INX") },
  hkus: { key: "hstech", label: "恒生科技", fetch: () => tencent("hkHSTECH") },
  n225: { key: "n225", label: "A股日经ETF(513880)", fetch: () => tencent("sh513880") },
  global: { key: "ndx", label: "纳指100（代全球成长）", fetch: () => sina(".NDX") },
};
const FIT_WIN = 60;      // 拟合窗（净值日）
const IDX_KEEP = 30;     // 写进 data.js 的指数尾巴（够覆盖任何公布滞后；页面只用到几根）
const TIER = (mae, r) => (r < 0.6 ? "dir" : mae <= 0.002 ? "num" : mae <= 0.01 ? "ref" : "dir");

const get = async (url, extra = {}) => {
  /* ⚠ 本机（macOS）用 Node 的 fetch 打这三个站点会偶发 "Empty reply from server"（对端按 TLS 指纹挡），
     而同一 URL 用 curl 就正常 —— 所以失败一次就退回 curl；CI（ubuntu）用 fetch 即可。两边都留。 */
  const heads = { ...HDR, ...extra };
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: heads });
      if (res.ok) return await res.text();
    } catch { /* 落到 curl */ }
    try {
      return execFileSync("curl", ["-sS", "--max-time", "30",
        ...Object.entries(heads).flatMap(([k, v]) => ["-H", k + ": " + v]), url], { encoding: "utf8", maxBuffer: 3e8 });
    } catch { /* 下一轮 */ }
    await new Promise((r) => setTimeout(r, 700 * (i + 1)));
  }
  throw new Error("fetch failed: " + url.slice(0, 90));
};
async function sina(sym) {
  const s = await get("https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/var%20t=/US_MinKService.getDailyK?symbol=" + sym + "&___qn=3");
  const a = JSON.parse(s.slice(s.indexOf("["), s.lastIndexOf("]") + 1));
  return a.map((x) => ({ d: x.d, c: +x.c })).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.d) && x.c > 0);
}
async function tencent(code) {
  const s = await get("https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=" + code + ",day,,,320");
  const j = JSON.parse(s), k = Object.keys(j.data)[0];
  return (j.data[k].day || []).map((x) => ({ d: x[0], c: +x[2] })).filter((x) => x.c > 0);
}
async function navHistory(code) {
  const s = await get("https://fund.eastmoney.com/pingzhongdata/" + code + ".js", { Referer: "https://fund.eastmoney.com/" });
  const m = s.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error("no NAV series: " + code);
  /* 时间戳是 UTC 0 点、净值日是北京日 → +8h 再取日期，否则整体错一天 */
  return JSON.parse(m[1]).map((r) => ({ d: new Date(r.x + 8 * 3600e3).toISOString().slice(0, 10), nav: +r.y, chg: +r.equityReturn }))
    .filter((r) => Number.isFinite(r.chg) && r.nav > 0);
}
const fit = (xs, ys) => {
  const n = xs.length, mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxx ? sxy / sxx : 0;
  return { a: my - b * mx, b };
};

/* ── 取场外持仓清单（code / theme / 名称）──────────────────────────────── */
const posSrc = readFileSync(POS, "utf8");
const om = posSrc.match(/^const OTC = \{[\s\S]*?^\};/m);
if (!om) throw new Error("OTC block not found in positions-data.js");
const octx = vm.createContext({});
vm.runInContext(om[0] + "\nthis.otc = OTC;", octx);
const funds = octx.otc.funds || [];
console.log("场外 " + funds.length + " 只：");

/* ── 取指数（按需去重）──────────────────────────────────────────────────── */
const need = [...new Set(funds.map((f) => f.theme))].filter((th) => PROX[th]);
const idxFull = {};
for (const th of need) {
  const p = PROX[th];
  if (idxFull[p.key]) continue;
  idxFull[p.key] = await p.fetch();
  const a = idxFull[p.key];
  console.log("  指数 " + p.key.padEnd(7) + p.label.padEnd(22) + a.length + " 天 · 最新 " + a[a.length - 1].d + " 收 " + a[a.length - 1].c);
}
const ret = {};
for (const [k, a] of Object.entries(idxFull)) {
  const m = {};
  for (let i = 1; i < a.length; i++) m[a[i].d] = (a[i].c / a[i - 1].c - 1) * 100;   // 单位：%
  ret[k] = m;
}

/* ── 逐只拟合 ───────────────────────────────────────────────────────────── */
const fits = {};
console.log("\n  基金            代理      净值日       β      α(%)     r     MAE(pp)  分档");
for (const f of funds) {
  const p = PROX[f.theme];
  if (!p || !ret[p.key]) { console.log("  " + f.code + " 无代理（theme=" + f.theme + "）→ 跳过"); continue; }
  const nav = await navHistory(f.code);
  /* ⚠ 必须用 Number.isFinite 过滤：缺少对应指数日的净值日（美股假期 07-03 / 09-07 那两天，国内照发净值、
     净值涨跌 0）会让 px 变成 NaN —— 而 `undefined / 100 === NaN`，用 `!== undefined` 会把它放进来，
     一个 NaN 就能把整条最小二乘带成 α = NaN（2026-10-03 实测踩到）。 */
  const rows = nav.map((x) => ({ d: x.d, act: x.chg / 100, px: ret[p.key][x.d] / 100 }))
    .filter((x) => Number.isFinite(x.px) && Math.abs(x.act) < 0.12).slice(-FIT_WIN);
  if (rows.length < 20) { console.log("  " + f.code + " 可用样本仅 " + rows.length + " → 跳过"); continue; }
  const xs = rows.map((x) => x.px), ys = rows.map((x) => x.act);
  const { a, b } = fit(xs, ys);
  const my = ys.reduce((s, y) => s + y, 0) / ys.length, mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const cxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const cxx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0)), cyy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
  const r = cxx && cyy ? cxy / (cxx * cyy) : 0;
  /* 样本内 MAE 会偏乐观 → 用末尾 20 个点做留出（不重拟合，恒等映射，足够分档用） */
  const hold = rows.slice(-20);
  const mae = hold.reduce((s, x) => s + Math.abs(a + b * x.px - x.act), 0) / hold.length;
  const last = nav[nav.length - 1];
  fits[f.code] = { prox: p.key, beta: +b.toFixed(4), alpha: +(a * 100).toFixed(4), r: +r.toFixed(3),
    mae: +mae.toFixed(5), n: rows.length, navDate: last.d, nav: last.nav, tier: TIER(mae, r) };
  console.log("  " + f.code + " " + String(f.name).padEnd(24).slice(0, 24) + p.key.padEnd(8) + last.d + "  " +
    b.toFixed(3).padStart(6) + (a * 100).toFixed(4).padStart(9) + r.toFixed(3).padStart(7) + (mae * 100).toFixed(3).padStart(8) + "   " + fits[f.code].tier);
}

/* ── 写块（先校验后写；幂等）────────────────────────────────────────────── */
const allDates = Object.values(idxFull).map((a) => a[a.length - 1].d).sort();
const block = "const NOWCAST = " + JSON.stringify({
  updated: allDates[allDates.length - 1],
  note: "AUTO（scripts/fetch-nowcast.mjs 写）：场外当日收益预估的输入 —— idx = 代理指数尾巴，fits = 逐只 α/β（单位：percent）",
  idx: Object.fromEntries(Object.entries(idxFull).map(([k, a]) => [k, a.slice(-IDX_KEEP).map((x) => ({ d: x.d, c: x.c }))])),
  fits,
}, null, 2) + ";";
const src = readFileSync(DATA, "utf8");
const old = src.match(/^const NOWCAST = \{[\s\S]*?^\};/m);
const next = old ? src.replace(old[0], block) : src.replace(/\n*$/, "\n\n") + block + "\n";
const model = readModel(next), errs = validateModel(model);
if (errs.length) { console.error("\n候选数据未通过校验，未写入：\n  " + errs.join("\n  ")); process.exit(1); }
if (next === src) { console.log("\nNO_WRITE：NOWCAST 无变化"); process.exit(0); }
writeFileSync(DATA, next);
console.log("\n已写入 data.js 的 NOWCAST（updated " + allDates[allDates.length - 1] + " · " + Object.keys(fits).length + " 只拟合 · 指数 " + Object.keys(idxFull).join("/") + "）");
