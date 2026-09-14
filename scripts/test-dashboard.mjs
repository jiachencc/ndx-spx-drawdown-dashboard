#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readModel, compileHtml, snapshotIssues, validateModel, metrics, createRecorder, stableBusiness, replaceConst, replaceMember } from "./data-quality.mjs";
import { main } from "./fetch_and_update.mjs";
const root = new URL("../", import.meta.url);
const data = readFileSync(new URL("data.js", root), "utf8");
const positions = readFileSync(new URL("positions.html", root), "utf8");
const index = readFileSync(new URL("index.html", root), "utf8");
const ctx = vm.createContext({});
vm.runInContext(data, ctx);
const now = new Date("2026-09-12T09:00:00Z");
const base = readModel(data);
const meta = Object.fromEntries(["ndx", "spx", "vix", "fg", "peFwd", "pePct", "tnx"].map(k => [k, { asOf: "2026-09-11", source: "synthetic test", status: "ok" }]));
const decision = changes => {
  const d = structuredClone(base.DEFAULT);
  Object.assign(d, { fg: 50, pePct: 70, peFwd: 20, tnx: 4, vix: 15 });
  d.ndx = { ...d.ndx, prevYr: 100, close: 116, ath: 126, ma200: 105, rsi: 50, ...changes?.ndx };
  Object.assign(d, Object.fromEntries(Object.entries(changes || {}).filter(([k]) => k !== "ndx")));
  return ctx.evaluateDecision(d, now, meta);
};
function extract(name) {
  const m = positions.match(new RegExp("^function " + name + "\\([^]*?^\\}", "m"));
  assert.ok(m, name); vm.runInContext(m[0], ctx);
}
["calcTWR", "trendCashflows", "calcXIRR"].forEach(extract);
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
test("T+2 threshold and sentiment boundaries", () => {
  for (const [close, hit] of [[121.999, false], [122, true], [122.001, true]]) assert.equal(decision({ ndx: { close, ath: 130 } }).exits[1].hit, hit);
  for (const [fg, hit] of [[84.999, false], [85, true], [85.001, true]]) assert.equal(decision({ fg }).exits[1].hit, hit);
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
  // 恐贪抓不到（CNN 反爬）不应让整页失去结论，但 T+2 必须显式标出这一点。
  const partial = { ...meta }; delete partial.fg;
  const s = ctx.evaluateDecision(base.DEFAULT, now, partial);
  assert.equal(s.healthy, true);
  assert.equal(s.invalid.length, 0);
  assert.ok(s.degraded.some(h => h.key === "fg"), "fg must be reported as degraded");
  assert.match(s.status, /降级输入/);
  assert.match(s.exits[1].warning, /恐贪/);
  assert.equal(s.exits[0].warning, "", "T+1 depends on NDX alone");
});
test("a valuation inside its tolerance but older than the core data is still flagged", () => {
  // 40 天前的远期 PE 落在 45 天容差内，不该被当作"新鲜"而静默参与 T+4 的 ERP 判断。
  const lagged = { ...meta, peFwd: { ...meta.peFwd, asOf: "2026-08-05" }, pePct: { ...meta.pePct, asOf: "2026-08-05" } };
  const s = ctx.evaluateDecision(base.DEFAULT, now, lagged);
  assert.equal(s.health.peFwd.usable, true, "inside the 45-day tolerance");
  assert.match(s.exits[3].warning, /早于主数据/, "T+4 must disclose its lagging valuation");
});
test("freshness handles weekends, future dates and retained observations", () => {
  assert.equal(ctx.sourceHealth("ndx", now, meta).usable, true);
  assert.equal(ctx.sourceHealth("ndx", new Date("2026-09-16T22:00:00Z"), meta).usable, false);
  assert.equal(ctx.sourceHealth("ndx", now, { ndx: { ...meta.ndx, asOf: "2026-09-14" } }).usable, false);
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
  const hold = positions.slice(positions.indexOf("function holdCardHtml"), positions.indexOf("function otcCardHtml"));
  const otc = positions.slice(positions.indexOf("function otcCardHtml"));
  const expr = src => src.match(/const backToCost = ([^;]+);/)[1];
  approx(vm.runInNewContext(expr(hold), { p: { idxAtCost: 100 }, m: { close: 80 } }), 0.25);
  approx(vm.runInNewContext(expr(otc), { r: -0.2 }), 0.25);
  approx(vm.runInNewContext(expr(otc), { r: 0.25 }), -0.2);
});
test("OTC rendering is restored with disjoint popup indexes", () => {
  assert.match(positions, /id="otc-list"/); assert.match(positions, /otcCardHtml\(row, rows.length \+ i/);
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
  assert.throws(() => r.success("ndx", null, "test")); assert.throws(() => r.success("ndx", "2026-09-10", "test"));
  r.failure("ndx", "test", "failed"); assert.equal(r.meta.ndx.asOf, "2026-09-11"); assert.equal(r.meta.spx.status, "ok");
});
test("fetch-only timestamps do not alter business identity", () => {
  const a = { ndx: { ...meta.ndx, fetchedAt: "a", error: "a" } }, b = { ndx: { ...meta.ndx, fetchedAt: "b", attemptedAt: "c" } };
  assert.deepEqual(stableBusiness(a), stableBusiness(b));
});
test("automated rewrite keeps hand-written comments, key style and values", () => {
  // A writer that re-serialises DEFAULT would delete these annotations and quote every key.
  const out = replaceConst(data, "DEFAULT", base.DEFAULT);
  ["MANUAL：盈利增速预期", "kr 持仓（场内价口径，AUTO）", "字段与 ndx/spx 同构", "AUTO：S&P500 估值"].forEach(c => assert.ok(out.includes(c), c));
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
    writeFileSync(join(dir, "positions.html"), positions.replace(/^const SNAPSHOTS = \[[\s\S]*?^\];/m, minimalSnapshots));
    globalThis.fetch = async url => {
      calls++; const u = String(url);
      if (u.includes("dataviz.cnn")) return new Response(JSON.stringify({ fear_and_greed: { score: 50, timestamp: "2026-09-11T20:00:00Z" } }));
      if (u.includes("frankfurter")) return new Response(JSON.stringify({ date: "2026-09-11", rates: { CNY: 7 } }));
      if (u.includes("historyofmarket")) return new Response(JSON.stringify(u.includes("/sp500/pe.json")
        ? { updated: "2026-09-11", pe: [{ date: "2026-03-01", value: 27.89 }], cape: [{ date: "2026-09-04", value: 40 }, { date: "2026-09-11", value: 41.09 }] }
        : { current: { forward: 20, trailing: 25, date: "2026-09-11" }, forward: [{ date: "2026-09-04", value: 19 }, { date: "2026-09-11", value: 20 }] }));
      if (u.includes("cboe")) return new Response('"tradeDate":"2026-09-11","name":"TOTAL PUT/CALL RATIO","value":"0.9"');
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
    assert.match(updatedSrc, /\/\/ AUTO：美股 2026-09-11 收盘（2026-09-12T09:00Z 抓取）/);
    assert.match(updatedSrc, /premiums: \{ \/\/ AUTO：场内溢价率/);
    assert.equal(updated.SOURCE_META.tnx.status, "retained"); assert.equal(updated.DEFAULT.tnx, base.DEFAULT.tnx);
    assert.equal(updated.SOURCE_META.fg.status, "ok");
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
    const second = await main({ root: fixtureRoot, now: new Date("2026-09-12T09:01:00Z"), seriesProvider: provider });
    assert.equal(second.changed, false); assert.equal(readFileSync(join(dir, "data.js"), "utf8"), updatedSrc);
    badPrice = true;
    await main({ root: fixtureRoot, now, seriesProvider: provider });
    const failedEtf = readModel(readFileSync(join(dir, "data.js"), "utf8"));
    assert.equal(failedEtf.SOURCE_META.etfNdx.status, "retained"); assert.equal(failedEtf.DEFAULT.etfNdx.close, updated.DEFAULT.etfNdx.close);
    const before = readFileSync(join(dir, "data.js"), "utf8");
    await assert.rejects(main({ root: fixtureRoot, now, seriesProvider: async () => { throw new Error("core outage"); } }), /Both core/);
    assert.equal(readFileSync(join(dir, "data.js"), "utf8"), before);
    writeFileSync(join(dir, "positions.html"), positions.replace(/^const SNAPSHOTS = \[[\s\S]*?^\];/m, 'const SNAPSHOTS = [\n{d:"2026-09-10",items:{"000001":{val:200,cost:100,pl:95}}}\n];'));
    const priorCalls = calls;
    await assert.rejects(main({ root: fixtureRoot, now, seriesProvider: provider }), /Pre-update quality gate/);
    assert.equal(calls, priorCalls); assert.equal(readFileSync(join(dir, "data.js"), "utf8"), before);
  } finally {
    globalThis.fetch = nativeFetch; [console.log, console.warn] = logs;
    // This is the unique directory returned by mkdtemp under the OS temporary directory.
    rmSync(dir, { recursive: true, force: true });
  }
});
