#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readModel, compileHtml, snapshotIssues, validateModel, metrics, createRecorder, stableBusiness, replaceConst, replaceMember, autoBlockIssues } from "./data-quality.mjs";
import { main, series } from "./fetch_and_update.mjs";
import { crossIssues } from "./cross-check.mjs";
const root = new URL("../", import.meta.url);
const data = readFileSync(new URL("data.js", root), "utf8");
const positions = readFileSync(new URL("positions.html", root), "utf8");
/* ⚠ 2026-09-27 起 OTC / OTC_LOG / SNAPSHOTS 在 positions-data.js 里（原先内联在 positions.html）——
   fixture 里替换快照要改这个文件，而 positions.html 本身原样复制即可。 */
const positionsData = readFileSync(new URL("positions-data.js", root), "utf8");
const index = readFileSync(new URL("index.html", root), "utf8");
const ctx = vm.createContext({});
vm.runInContext(data, ctx);
const base = readModel(data);
/* 日期一律相对 data.js 的当前数据日推算：data.js 每天自动推进，写死日期会让断言在
 * 下一次自动更新后失效——2026-09-15 的 CI 就是这样挂的（数据到了 09-14，测试仍按 09-11 断言）。 */
const now = new Date(base.DEFAULT.date + "T09:00:00Z");
const shift = n => new Date(Date.parse(base.DEFAULT.date + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const meta = Object.fromEntries(["ndx", "spx", "vix", "peFwd", "pePct", "tnx"].map(k => [k, { asOf: base.DEFAULT.date, source: "synthetic test", status: "ok" }]));
const decision = changes => {
  const d = structuredClone(base.DEFAULT);
  Object.assign(d, { pePct: 70, peFwd: 20, tnx: 4, vix: 15 });
  d.ndx = { ...d.ndx, prevYr: 100, close: 116, ath: 126, ma200: 105, rsi: 50, ...changes?.ndx };
  Object.assign(d, Object.fromEntries(Object.entries(changes || {}).filter(([k]) => k !== "ndx")));
  return ctx.evaluateDecision(d, now, meta);
};
function extract(name) {
  const m = positions.match(new RegExp("^function " + name + "\\([^]*?^\\}", "m"));
  assert.ok(m, name); vm.runInContext(m[0], ctx);
}
["calcTWR", "trendCashflows", "calcXIRR", "trendSegFill"].forEach(extract);
const approx = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("all page scripts compile; current data schema and quantities valid", () => {
  compileHtml(index); compileHtml(positions); assert.deepEqual(validateModel(base), []);
});
test("16% YTD outside near-high band does not trigger T+1", () => {
  const s = decision({ ndx: { close: 116, ath: 128 } }); assert.equal(s.exits[0].hit, false); assert.equal(s.exit, null);
});
test("T+1 threshold boundaries share one definition", () => {
  for (const [close, hit] of [[117.999, false], [118, true], [118.001, true]]) {
    const s = decision({ ndx: { close, ath: close / 0.91 } }); assert.equal(s.exits[0].hit, hit);
  }
});
test("near-high strict boundary and documented 10% release", () => {
  for (const [drawdown, hit] of [[7.999, true], [8, false], [8.001, false]]) {
    const s = decision({ ndx: { close: 110, ath: 110 / (1 - drawdown / 100) } }); assert.equal(s.exits[0].hit, hit);
  }
  assert.equal(decision({ ndx: { close: 120, ath: 140 } }).exits[0].hit, false);
  assert.equal(decision({ ndx: { close: 110, ath: 110 / 0.9 } }).exits[0].unmet.includes("0.00pp"), false);
});
test("T+2 is not masked by T+1", () => {
  const s = decision({ ndx: { close: 123, ath: 130 } }); assert.equal(s.exit.id, "T+2");
  assert.equal(s.exits[0].hit, true); assert.equal(s.exits[1].hit, true);
});
test("T+2 threshold (YTD-only after CNN Fear&Greed retirement)", () => {
  for (const [close, hit] of [[121.999, false], [122, true], [122.001, true]]) assert.equal(decision({ ndx: { close, ath: 130 } }).exits[1].hit, hit);
});
test("AND exit reports each criterion, with T+4 taking precedence", () => {
  assert.equal(decision({ pePct: 95, ndx: { rsi: 50 } }).exits[2].hit, false);
  assert.equal(decision({ pePct: 90, ndx: { rsi: 75 } }).exit.id, "T+3");
  assert.equal(decision({ pePct: 95, tnx: 6, ndx: { rsi: 80 } }).exit.id, "T+4");
});
test("drawdown entry bands are stable at all boundaries", () => {
  for (const [dd, level] of [[-4.999, 0], [-5, 1], [-5.001, 1], [-14.999, 1], [-15, 2], [-24.999, 2], [-25, 3], [-34.999, 3], [-35, 4], [-35.001, 4]]) {
    const s = decision({ ndx: { ath: 100, close: 100 + dd } }); assert.equal(s.level, level);
  }
});
test("observation never promotes into trial entry", () => {
  const s = decision({ ndx: { ath: 100, close: 94, ma200: 100, rsi: 50 } });
  assert.equal(s.entry, "observe"); assert.equal(s.level, 1);
  // At 6% below ATH the independent T+1 near-high rule is legitimately active.
  assert.equal(s.exits[0].hit, true); assert.doesNotMatch(s.status, /试探|加仓档位与确认条件满足/);
});
test("entry requires generic confirmations and band-specific prerequisite", () => {
  assert.equal(decision({ ndx: { ath: 100, close: 84, ma200: 80, rsi: 30 } }).entry, "eligible");
  assert.equal(decision({ pePct: 40, vix: 29, ndx: { ath: 100, close: 74, ma200: 50, rsi: 20 } }).entry, "unconfirmed");
});
test("unverified source blocks actionable status even when thresholds hit", () => {
  const s = ctx.evaluateDecision(base.DEFAULT, now, {}); assert.equal(s.healthy, false); assert.match(s.status, /暂停/);
});
test("banner carries a plain-language explanation, not a restatement of the status", () => {
  const s = decision({ pePct: 95, tnx: 6, ndx: { rsi: 80 } });   // 触发 T+4
  assert.equal(s.exit.id, "T+4");
  assert.match(s.plain, /不是止盈/, "T+4 必须讲清它不是止盈");
  assert.notEqual(s.plain, s.status);
});
test("an advisory input degrades its own rule instead of blanking the dashboard", () => {
  // PE 分位（低频源）缺失不应让整页失去结论，但 T+3 必须显式标出这一点。
  const partial = { ...meta }; delete partial.pePct;
  const s = ctx.evaluateDecision(base.DEFAULT, now, partial);
  assert.equal(s.healthy, true);
  assert.equal(s.invalid.length, 0);
  assert.ok(s.degraded.some(h => h.key === "pePct"), "pePct must be reported as degraded");
  assert.match(s.status, /降级输入/);
  assert.match(s.exits[2].warning, /PE分位|PE 分位|SPX PE/);
  assert.equal(s.exits[0].warning, "", "T+1 depends on NDX alone");
});
test("a valuation inside its tolerance but older than the core data is still flagged", () => {
  // 早于主数据 10 天的远期 PE 仍落在 45 天容差内，不该被当作"新鲜"而静默参与 T+4 的 ERP 判断。
  const lagged = { ...meta, peFwd: { ...meta.peFwd, asOf: shift(-10) }, pePct: { ...meta.pePct, asOf: shift(-10) } };
  const s = ctx.evaluateDecision(base.DEFAULT, now, lagged);
  assert.equal(s.health.peFwd.usable, true, "inside the 45-day tolerance");
  // 警告文案 2026-09-27 起给出滞后交易日数（原来只写「早于主数据 <日期>」，看不出滞后多少）。
  assert.match(s.exits[3].warning, /滞后 \d+ 个交易日 · 主数据/, "T+4 must disclose how stale its valuation is");
});
test("freshness handles weekends, future dates and retained observations", () => {
  assert.equal(ctx.sourceHealth("ndx", now, meta).usable, true);
  assert.equal(ctx.sourceHealth("ndx", new Date(shift(7) + "T22:00:00Z"), meta).usable, false, "7 天后同一读数应过期");
  assert.equal(ctx.sourceHealth("ndx", now, { ndx: { ...meta.ndx, asOf: shift(1) } }).usable, false, "来源日期在未来应视为未核验");
  assert.equal(ctx.sourceHealth("ndx", now, { ndx: { ...meta.ndx, status: "retained" } }).usable, false);
});
test("windowed XIRR uses opening market value, not historical cost", () => {
  const cf = ctx.trendCashflows([{ d: "2025-01-01", cost: 100, val: 90 }, { d: "2026-01-01", cost: 100, val: 99, flow: 0 }]);
  assert.equal(cf.cfs[0].amt, -90); approx(ctx.calcXIRR(cf.cfs), 0.1);
});
test("missing flow is not silently treated as zero", () => {
  const pts = [{ d: "2025-01-01", val: 100 }, { d: "2026-01-01", val: 150, flow: null }];
  assert.equal(ctx.trendCashflows(pts), null); assert.equal(ctx.calcTWR(pts), null);
});
test("end-of-period deposits do not inflate approximate TWR", () => {
  approx(ctx.calcTWR([{ val: 100 }, { val: 165, flow: 55 }]), 0.1);
});
test("cost recovery uses the current price, not the original cost", () => {
  /* 场外卡已随「场外基金明细」模块移除，全页只剩场内卡这一处口径：
   * 必须是「成本/现价 − 1」；写成「−r」会把跌 20% 说成涨 20% 即可回本。 */
  const hold = positions.slice(positions.indexOf("function holdCardHtml"), positions.indexOf("function esc(s)"));
  const expr = hold.match(/const backToCost = ([^;]+);/)[1];
  approx(vm.runInNewContext(expr, { p: { idxAtCost: 100 }, m: { close: 80 } }), 0.25);
  approx(vm.runInNewContext(expr, { p: { idxAtCost: 100 }, m: { close: 125 } }), -0.2);
});
test("OTC detail cards are gone while each holding card carries its own trade log", () => {
  assert.ok(!positions.includes('id="otc-list"') && !positions.includes("otcCardHtml"), "场外明细卡应已移除");
  assert.match(positions, /posLogHtml\(p, r, pl\)/, "每只持仓卡应内嵌操作记录");
  assert.match(positions, /<div class="log-list">/, "操作记录容器");
  /* 场外总览行不再有明细卡可跳；若仍挂 sel，?debug 的定位校验会失败 */
  const otcPush = positions.match(/otcRows\.forEach\(\(row\) => plRows\.push\(\{([^}]*)\}\)/)[1];
  assert.ok(!/sel:/.test(otcPush), "场外总览行不应再挂跳转目标");
});
test("historical fixture residual is detected, not normalized away", () => {
  const fixture = 'const SNAPSHOTS = [\n{d:"2026-09-10",cash:0,items:{"000001":{val:200,cost:150,pl:49}}},\n{d:"2026-09-11",cash:0,items:{"000001":{val:200,cost:150,pl:48}}}\n];';
  const issues = snapshotIssues(fixture); assert.equal(issues.length, 1); assert.match(issues[0], /2026-09-11:000001/);
});
test("frozen DCA cutoff and non-current labels are explicit", () => {
  assert.equal(base.DCA_META.end, "2026-08-26"); assert.match(index, /不随页头行情更新/); assert.match(index, /原逐日日期未保留/);
});
test("invalid source date and date regression are rejected", () => {
  const r = createRecorder(meta, now);
  assert.throws(() => r.success("ndx", null, "test")); assert.throws(() => r.success("ndx", shift(-5), "test"));
  r.failure("ndx", "test", "failed"); assert.equal(r.meta.ndx.asOf, meta.ndx.asOf); assert.equal(r.meta.spx.status, "ok");
});
test("fetch-only timestamps do not alter business identity", () => {
  const a = { ndx: { ...meta.ndx, fetchedAt: "a", error: "a" } }, b = { ndx: { ...meta.ndx, fetchedAt: "b", attemptedAt: "c" } };
  assert.deepEqual(stableBusiness(a), stableBusiness(b));
});
test("automated rewrite keeps hand-written comments, key style and values", () => {
  // A writer that re-serialises DEFAULT would delete these annotations and quote every key.
  const out = replaceConst(data, "DEFAULT", base.DEFAULT);
  /* ⚠ 用**不含日期**的前缀做样本（2026-09-30 改）：这几句行尾注释的日期是人工跟着券商报价日改的
     （见 handoff.md §3.3 SOP 第 6 步「它不动注释……需要时手工一句」），硬编码 "09-24 券商收盘"
     会在每次手工订正注释时误报「注释丢了」。本测试要守的是**注释本身存活**，不是那个日期。 */
  ["MANUAL：盈利增速预期", "kr 持仓（场内价口径", "字段与 ndx/spx 同构", "AUTO：S&P500 估值"].forEach(c => assert.ok(out.includes(c), c));
  // 只在 DEFAULT 块内检查：文件里的 SOURCE_META 段本来就是 JSON，带引号键名属正常
  const at = out.indexOf("const DEFAULT = {"), block = out.slice(at, out.indexOf("\n};", at));
  assert.ok(!block.includes('"ndx": {') && !block.includes('"spx": {'), "keys must stay unquoted");
  assert.deepEqual(readModel(out).DEFAULT, base.DEFAULT);
  const prem = replaceMember(data, "premiums", base.POSITIONS.premiums);
  assert.ok(prem.includes("AUTO：场内溢价率"));
  assert.deepEqual(readModel(prem).POSITIONS.premiums, base.POSITIONS.premiums);
});
function syntheticBars() {
  const dates = [], close = [], high = [], low = [];
  const day = new Date("2025-07-01T00:00:00Z");
  while (day.toISOString().slice(0, 10) <= "2026-09-11") {
    if (![0, 6].includes(day.getUTCDay())) { dates.push(day.toISOString().slice(0, 10)); const value = 100 + dates.length / 10; close.push(value); high.push(value + 1); low.push(value - 1); }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return { dates, close, high, low, source: "synthetic" };
}
test("OHLC null filtering preserves alignment; unordered dates rejected", () => {
  const b = syntheticBars(); b.close[5] = null; const m = metrics(b); assert.equal(m.date, "2026-09-11"); assert.equal(m.rows.length, b.dates.length - 1);
  b.dates[10] = b.dates[9]; assert.throws(() => metrics(b), /ordering/);
});
/* 2026-09-27：Yahoo ^NDX/^GSPC 全 403、stooq 被 JS 挑战页拦住 → 加腾讯兜底。
   钉住三件事：① 降级顺序 Yahoo → stooq → 腾讯；② 腾讯的 bar 能喂给 metrics；
   ③ 「只有 ≈4 年窗口」必须写进 source —— 数据健康区靠它提示用户，不允许静默降级。 */
test("index fallback: Yahoo → stooq → Tencent, with the shorter window disclosed", async () => {
  const saved = globalThis.fetch, asked = [];
  const b = syntheticBars();
  const tencentBars = b.dates.map((d, i) => [d, "1", String(b.close[i]), String(b.high[i]), String(b.low[i])]);
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes("usfqkline")) { asked.push("tencent"); return new Response(JSON.stringify({ data: { usNDX: { qfqday: tencentBars } } })); }
    if (u.includes("stooq.com")) { asked.push("stooq"); return new Response("<html>please enable JS</html>"); }
    if (u.includes("yahoo.com")) { asked.push("yahoo"); return new Response("Forbidden", { status: 403 }); }
    asked.push("other");
    return new Response("", { status: 404 });
  };
  try {
    const raw = await series("^NDX", "^ndx");
    assert.deepEqual([...new Set(asked)], ["yahoo", "stooq", "tencent"], "must degrade in that order");
    assert.match(raw.source, /Tencent usNDX/);
    assert.match(raw.source, /not 10y/, "the ≈4-year window must be disclosed in provenance");
    const m = metrics(raw); assert.ok(m.rows.length >= 260, "fallback bars must satisfy the metrics minimum");
    // VIX / TNX 没有验证过的腾讯代码 → 必须抛错让上层 retained，而不是悄悄换成别的数。
    // 错误文案刻意保持短（它会显示在页面上），所以只断言"没有可用源"这个结论。
    await assert.rejects(() => series("^VIX", "^vix"), /no index provider available/);
  } finally { globalThis.fetch = saved; }
});

/* 2026-09-29：真事故的回归。09-29 期把 7 只场外的 value/day/pnl/rate/upd 都更新了，
   唯独 nav.close / nav.closeDate 留在 09-24 → 页面照旧渲染「净值 09.24」，
   而 ①②③④ 全过（那些校验只看 val/pl/cost，不看 nav）—— 是用户肉眼发现的。
   ⑤ 用恒等式 val = qty × nav.close + 在途 补上这道缝。 */
test("cross-check ⑤: 场外 nav 没跟着 value 更新时必须拦下", () => {
  const html = (navA, navB) => [
    "const SNAPSHOTS = [",
    '  { d: "2026-09-28", cash: 0, items: { "159941": { name: "纳指ETF广发", qty: 10, cost: 9, val: 10, pl: 1 } } },',
    '  { d: "2026-09-29", cash: 0, items: {',
    '      "159941": { name: "纳指ETF广发", qty: 10, cost: 9, val: 10, pl: 1 },',
    '      "023402": { name: "全球精选", qty: 3552.72, cost: 24500, val: 22429.39, pl: -2070.61 },',
    '      "021000": { name: "南方纳指I", qty: 10251, cost: 23800, val: 24330.96, pl: 530.96 } } },',
    "];",
    'const OTC = { updated: "2026-09-29", cash: 0, funds: [',
    '  { code: "023402", name: "全球精选", value: 22429.39, pnl: -2070.61, nav: { close: ' + navA + ', closeDate: "2026-09-28" } },',
    '  { code: "021000", name: "南方纳指I", value: 24330.96, pnl: 530.96, nav: { close: ' + navB + ', closeDate: "2026-09-28" } },',
    "],",
    "};",
    "const OTC_LOG = {",
    '  "023402": [],',
    '  "021000": [{ d: "2026-09-28", act: "定投", amt: 200, status: "成功" }],',
    "};",
  ].join("\n");
  const model = { POSITIONS: { hold: [{ code: "159941", idx: "ndx", qty: 10 }] }, DEFAULT: {} };
  // 正确：023402 slack = 0；021000 slack = 400 = 2 × 200（在途）→ 都不该报
  const ok = crossIssues(model, html(6.3133, 2.3345), false);
  assert.equal(ok.issues.filter((s) => s.startsWith("⑤")).length, 0, "正确数据不该报 ⑤：" + ok.issues.join(" | "));
  // 漏改：023402 用旧净值 6.4175（slack −370.19，负向最灵）；
  //       021000 用旧净值 2.3527（slack +213.43，非 200 的整数倍 → 靠「倍数」判据拦下）
  const stale = crossIssues(model, html(6.4175, 2.3527), false);
  const hits = stale.issues.filter((s) => s.startsWith("⑤"));
  assert.equal(hits.length, 2, "两只漏改 nav 的都应被拦下，实际：" + JSON.stringify(stale.issues));
  assert.match(hits.join(" "), /023402/);
  assert.match(hits.join(" "), /021000/);
});

/* 2026-09-30：真事故的回归。09-27 重构把 OTC / SNAPSHOTS 从 positions.html 搬到 positions-data.js
   （提交写着「同步 9 个脚本」），漏改 fetch-fees / sync-bench → 那两步在 CI 里静默坏了 8 天
   （费率表停 asOf 09-22、同节奏基准停 09-24），而既有 schema / 交叉校验全绿、没人发现。
   autoBlockIssues 给 AUTO 块设「最老允许日期」，把这种静默失效变成终审红字。
   阈值用当时那三个真实数字校准：ALT_BACKTEST 差 5 天、FEES 差 7 天、BENCH 差 5 天，都必须拦下。 */
test("AUTO 块新鲜度：静默坏掉的 CI 步骤必须被终审拦下", () => {
  const mkt = { DEFAULT: { etfNdx: { priceDate: "2026-09-29" } } };
  const posSrc = 'const SNAPSHOTS = [\n  { d: "2026-09-24", cash: 0, items: {} },\n  { d: "2026-09-29", cash: 0, items: {} },\n];';
  const benchOk = 'const BENCH = {\n  "2026-09-29": 30339.33,\n};';
  const benchStale = 'const BENCH = {\n  "2026-09-24": 30478.86,\n};';
  // 正常：回测跟到行情日、费率 1 天前刚抓过、基准与最新快照同日 → 0 条
  const ok = { ...mkt, ALT_BACKTEST: { asOf: "2026-09-29" }, FEES: { asOf: "2026-09-30" } };
  assert.equal(autoBlockIssues(ok, benchOk, posSrc).length, 0);
  // 事故复现：三块分别为 5 天 / 7 天 / 5 天落后 → 三条都要报
  const stale = { ...mkt, ALT_BACKTEST: { asOf: "2026-09-24" }, FEES: { asOf: "2026-09-22" } };
  const hits = autoBlockIssues(stale, benchStale, posSrc);
  assert.equal(hits.length, 3, "三块陈旧都应报出，实际：" + JSON.stringify(hits));
  assert.match(hits.join(" "), /ALT_BACKTEST.*5 天|ALT_BACKTEST\.asOf 2026-09-24/);
  assert.match(hits.join(" "), /FEES/);
  assert.match(hits.join(" "), /BENCH/);
});

test("candidate schema rejects non-finite quotes", () => { const m = structuredClone(base); m.DEFAULT.vix = NaN; assert.ok(validateModel(m).length); });

test("updater transaction: partial source failure, no-change, invalid candidate and audit gate", async () => {
  // Isolated fixture only. Production HTML and data.js are never written by this test.
  const dir = mkdtempSync(join(tmpdir(), "dashboard-quality-test-"));
  const fixtureRoot = pathToFileURL(dir + "/");
  const nativeFetch = globalThis.fetch;
  const logs = [console.log, console.warn]; console.log = () => {}; console.warn = () => {};
  let badPrice = false, calls = 0;
  try {
    const seeded = structuredClone(base); seeded.SOURCE_META = {};
    // 溯源段必须一起清空：replaceConst 只改 DEFAULT，若留着线上真实的来源日期，
    // 合成数据会被「来源日期回退」保护判定为失败（这不是被测逻辑出错）。
    const AUTO_META = /\/\* AUTO_META_START:[\s\S]*?\/\* AUTO_META_END \*\//;
    let fixtureData = replaceConst(data, "DEFAULT", seeded.DEFAULT)
      .replace(AUTO_META, "/* AUTO_META_START: test fixture. */\nconst SOURCE_META = {};\n/* AUTO_META_END */");
    writeFileSync(join(dir, "data.js"), fixtureData);
    writeFileSync(join(dir, "index.html"), index);
    const minimalSnapshots = 'const SNAPSHOTS = [\n{d:"2026-09-10",total:100,pl:0}\n];';
    writeFileSync(join(dir, "positions.html"), positions);
    writeFileSync(join(dir, "positions-data.js"), positionsData.replace(/^const SNAPSHOTS = \[[\s\S]*?^\];/m, minimalSnapshots));
    globalThis.fetch = async url => {
      calls++; const u = String(url);
      if (u.includes("frankfurter")) return new Response(JSON.stringify({ date: "2026-09-11", rates: { CNY: 7 } }));
      if (u.includes("historyofmarket")) return new Response(JSON.stringify(u.includes("/sp500/pe.json")
        ? { updated: "2026-09-11", pe: [{ date: "2026-03-01", value: 27.89 }], cape: [{ date: "2026-09-04", value: 40 }, { date: "2026-09-11", value: 41.09 }] }
        : { current: { forward: 20, trailing: 25, date: "2026-09-11" }, forward: [{ date: "2026-09-04", value: 19 }, { date: "2026-09-11", value: 20 }] }));
      if (u.includes("cboe")) return new Response('\\"selectedDate\\":\\"2026-09-11\\",\\"name\\":\\"TOTAL PUT/CALL RATIO\\",\\"value\\":\\"0.9\\"');   // 新版 RSC 页面：转义引号 + selectedDate
      if (u.includes("ifzq")) {
        const sym = new URL(u).searchParams.get("param").split(",")[0];
        if (sym.includes("513880")) return new Response("unavailable", { status: 404 });
        const b = syntheticBars(); const bars = b.dates.map((d, i) => [d, "2", badPrice ? "-1" : String(b.close[i]), String(b.high[i]), String(b.low[i])]);
        return new Response(JSON.stringify({ data: { [sym]: { qfqday: bars } } }));
      }
      if (u.includes("eastmoney")) return new Response(JSON.stringify({ Data: { LSJZList: [{ DWJZ: "125", FSRQ: "2026-09-10" }] } }));
      if (u.includes("home.treasury.gov")) return new Response('Date,"1 Mo","2 Mo","3 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"\n09/11/2026,4,3.9,3.8,3.7,3.6,3.55,3.6,3.7,3.9,4.2,4.8,4.9\n09/10/2026,4,3.9,3.8,3.7,3.6,3.5,3.6,3.7,3.9,4.2,4.8,4.9');
      if (u.includes("hq.sinajs.cn")) {
        const b = syntheticBars(), last = b.close.at(-1), day = b.dates.at(-1);
        return new Response('var hq_str_gb_$ndx="NDX,' + last + ',0.91,' + day + ' 05:30:00,1";\nvar hq_str_gb_$inx="SPX,' + last + ',0.86,' + day + ' 04:46:29,1";');
      }
      throw new Error("Unexpected test network URL");
    };
    const provider = async symbol => {
      if (symbol === "^TNX") throw new Error("synthetic 10Y outage");
      const b = syntheticBars();
      if (symbol === "^VIX" || symbol === "^TNX") b.close = b.close.map(() => symbol === "^VIX" ? 15 : 4);
      return b;
    };
    const first = await main({ root: fixtureRoot, now, seriesProvider: provider }); assert.equal(first.changed, true);
    const updatedSrc = readFileSync(join(dir, "data.js"), "utf8"), updated = readModel(updatedSrc);
    // End-to-end: an automated update must not delete annotations or freeze the stamp comment.
    assert.match(updatedSrc, /\/\/ MANUAL：盈利增速预期，无免费源，人工维护/);
    assert.ok(updatedSrc.includes("// AUTO：美股 " + syntheticBars().dates.at(-1) + " 收盘（" + now.toISOString().slice(0, 16) + "Z 抓取）"), "stamp comment must be refreshed");
    assert.match(updatedSrc, /premiums: \{ \/\/ AUTO：场内溢价率/);
    assert.equal(updated.SOURCE_META.tnx.status, "retained"); assert.equal(updated.DEFAULT.tnx, base.DEFAULT.tnx);
    // CAPE must come from the `cape` series, not the lagging `pe` series (27.89 vs 41.09).
    assert.equal(updated.SOURCE_META.cape.status, "ok");
    assert.equal(updated.SOURCE_META.cape.asOf, "2026-09-11");
    assert.equal(updated.DEFAULT.cape, 41.09);
    // 2Y comes from the official curve, not from a nonexistent Yahoo ticker.
    assert.equal(updated.SOURCE_META.tnx2.status, "ok");
    assert.equal(updated.SOURCE_META.tnx2.asOf, "2026-09-11");
    assert.equal(updated.DEFAULT.tnx2, 3.55);
    // The Sina cross-check is advisory: agreeing closes are recorded, not used to gate.
    assert.equal(updated.SOURCE_META.crosscheck.status, "ok", JSON.stringify(updated.SOURCE_META.crosscheck));
    assert.equal(updated.SOURCE_META.crosscheck.asOf, "2026-09-11");
    assert.deepEqual(updated.POSITIONS.premiums["513880"], base.POSITIONS.premiums["513880"]);
    assert.equal(updated.SOURCE_META["premium:513880"].status, "retained");
    assert.deepEqual(updated.POSITIONS.hold, base.POSITIONS.hold); assert.deepEqual(updated.DCA_NDX, base.DCA_NDX);
    const second = await main({ root: fixtureRoot, now: new Date(Date.parse(now) + 60000), seriesProvider: provider });
    assert.equal(second.changed, false); assert.equal(readFileSync(join(dir, "data.js"), "utf8"), updatedSrc);
    badPrice = true;
    await main({ root: fixtureRoot, now, seriesProvider: provider });
    const failedEtf = readModel(readFileSync(join(dir, "data.js"), "utf8"));
    assert.equal(failedEtf.SOURCE_META.etfNdx.status, "retained"); assert.equal(failedEtf.DEFAULT.etfNdx.close, updated.DEFAULT.etfNdx.close);
    const before = readFileSync(join(dir, "data.js"), "utf8");
    await assert.rejects(main({ root: fixtureRoot, now, seriesProvider: async () => { throw new Error("core outage"); } }), /Both core/);
    assert.equal(readFileSync(join(dir, "data.js"), "utf8"), before);
    writeFileSync(join(dir, "positions-data.js"), positionsData.replace(/^const SNAPSHOTS = \[[\s\S]*?^\];/m, 'const SNAPSHOTS = [\n{d:"2026-09-10",items:{"000001":{val:200,cost:100,pl:95}}}\n];'));
    const priorCalls = calls;
    await assert.rejects(main({ root: fixtureRoot, now, seriesProvider: provider }), /Pre-update quality gate/);
    assert.equal(calls, priorCalls); assert.equal(readFileSync(join(dir, "data.js"), "utf8"), before);
  } finally {
    globalThis.fetch = nativeFetch; [console.log, console.warn] = logs;
    // This is the unique directory returned by mkdtemp under the OS temporary directory.
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trend fill: crossing segment never emits malformed coordinates", () => {
  /* 2026-09-21 → 09-22（首次「浮亏 → 浮盈」）是唯一走交叉分支的一段。
     入参沿用页面的字符串形式（P() = toFixed(1)）：原先 xi = x1 + (x2−x1)*r 会退化成
     字符串拼接，产出 "935.921.10…" 这种非法坐标，浏览器按 0 处理 → 图上出现横跨左上角的大三角。 */
  const svg = ctx.trendSegFill("935.9", "64.8", "61.5", "973.0", "36.1", "38.6");
  assert.ok(svg.includes("<polygon"), "交叉段应产出多边形");
  const n = svg.match(/points="([^"]+)"/)[1].split(/[ ,]+/).map(Number);
  assert.equal(n.length, 8, "四点八个数");
  assert.ok(n.every(Number.isFinite), "坐标必须全是有限数字：" + svg);
  assert.ok(n[0] > 935.9 && n[0] < 973, "交叉点 x 应落在两端之间，而不是被拼成 0");
  assert.ok(n[1] > 36.1 && n[1] < 64.8, "交叉点 y 应是两线插值，而不是 0");
});
test("trend fill: underwater unfilled, profitable green, garbage dropped", () => {
  /* 这一层是像素 y（向下为正）→ 浮盈 = 资产 y 更小。原先用 v−c 判符号恰好判反：
     08-28→08-31 两期都浮亏却被涂绿，这才是满屏绿底的来源。 */
  assert.equal(ctx.trendSegFill(46, 169.6, 162.1, 157.2, 169.9, 160.4), "", "两期都浮亏：不铺色");
  assert.ok(ctx.trendSegFill(500, 100, 120, 600, 90, 118).includes("var(--green)"), "两期都浮盈：铺绿");
  const left = ctx.trendSegFill(0, 100, 120, 100, 140, 118);   // 浮盈 → 浮亏：只留左半段
  assert.equal(left.match(/points="([^"]+)"/)[1].split(/[ ,]+/)[0], "0", "只保留浮盈那一侧");
  assert.equal(ctx.trendSegFill(1, 100, 120, undefined, 130, 118), "", "坐标非有限：宁缺不画");
});
