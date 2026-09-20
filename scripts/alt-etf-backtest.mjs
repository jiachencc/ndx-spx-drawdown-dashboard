#!/usr/bin/env node
"use strict";
/* ============================================================================
 * 标的替换回测（v1）
 *
 * 回答的问题：如果同一批操作（同样日期、同样金额）买的是同类别里的另一只产品，
 *             到今天会差多少钱？—— 把「选哪只标的」这一项单独量化出来。
 *
 * 口径（刻意取最朴素、可复核的一种）：
 *   · 每笔按你当天的实际花费金额，买入候选标的「当日收盘价」（前复权）；
 *   · 你的持仓（基准）也用同一口径重算（当日收盘），从而排除盘中择时的干扰，只比标的；
 *   · 佣金两边相同（同券商同费率）→ 抵消，不建模；管理费/托管费已含在净值里 → 自动计入；
 *   · 期末统一取「你的标的最近一个有数据的交易日」收盘，各候选须有同日数据才计入。
 * 另附两个参考口径：① 每笔固定 1000 元（消除大额笔的权重）；② 净值同期涨幅与期初/期末溢价
 *   —— 用来判断差异来自「净值（费率/跟踪）」还是「溢价变动」。
 *
 * 数据源（均为本仓库既有接口，不引入新依赖）：
 *   · 场内价：腾讯前复权日K  https://web.ifzq.gtimg.cn/appstock/app/fqkline/get
 *   · 场外净值：东方财富历史净值 https://api.fund.eastmoney.com/f10/lsjz（倒序、每页 20，需翻页）
 *
 * 输出：① data.js 的 ALT_BACKTEST 块（页面「🔁 标的替换回测」板块读它，整块重写）
 *       ② outputs/alt-etf-backtest/alt-etf-backtest.html（全字段报告，.gitignore 已忽略 outputs/）
 * 运行：node scripts/alt-etf-backtest.mjs
 *
 * ⚠ 候选清单与综合费率是 MANUAL：取自基金招募说明书摘要 / 另一份《持仓隐性成本分析》。
 *    费率只用于展示与解释，不参与收益计算（它已经体现在净值里）。换候选改这里即可。
 * ========================================================================== */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readModel, validateModel, auditFiles, atomicWrite } from "./data-quality.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_URL = new URL("../", import.meta.url);
const DATA = join(ROOT, "data.js");
const OUT = join(ROOT, "outputs", "alt-etf-backtest");
const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" };

/* ---------- 候选清单（MANUAL）：[代码, 名称, 综合费率 %, 规模 亿元] ----------
 * 名称与费率在这里只是「展示用的快照」；权威费率由 scripts/fetch-fees.mjs 抓东财基金档案写入 data.js:FEES，
 * 页面以 FEES 为准（本脚本只负责把候选代码交给它去抓）。 */
export const UNIVERSE = [
  {
    key: "ndx", label: "纳指100", mine: "159941",
    etf: [
      ["159941", "纳指ETF广发", 1.00, 347.2],
      ["513100", "纳指ETF国泰", 0.80, 194.9],
      ["513300", "纳斯达克ETF华夏", 0.80, 133.0],
      ["159632", "纳斯达克ETF华安", 0.80, 113.1],
      ["513390", "纳指100ETF博时", 0.65, 42.5],
      ["159660", "纳指ETF汇添富", 0.65, 49.4],
      ["159659", "纳斯达克100ETF招商", 0.65, 101.0],
      ["513870", "纳指ETF富国", 0.60, 25.0],
      ["159696", "纳指ETF易方达", 0.60, 50.3],
      ["159501", "纳指ETF嘉实", 0.60, 124.5],
      ["513110", "纳指ETF华泰柏瑞", 1.00, 51.0],
      ["159513", "纳斯达克100ETF大成", 1.00, 75.1],
    ],
    otc: [["021000", "南方纳指100 I", 0.66], ["021778", "广发纳指100 F", 1.18]],
  },
  {
    key: "spx", label: "标普500", mine: "513650",
    etf: [
      ["513650", "标普500ETF南方", 0.75, 77.2],
      ["159655", "标普500ETF华夏", 0.75, 39.4],
      ["159612", "标普500ETF国泰", 0.75, 8.4],
      ["513500", "标普500ETF博时", 0.80, 240.2],
      ["161125", "易方达标普500LOF", 1.00, null],
    ],
    otc: [["018738", "博时标普500联接E", 0.81]],
  },
];

/* ---------- 工具 ---------- */
const px = (c) => (/^(15|16)/.test(c) ? "sz" : "sh") + c;   // 腾讯代码前缀：15/16 开头在深交所
const cache = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, headers) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { ...UA, ...(headers || {}) }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (i === 2) throw e;
      await sleep(600 * (i + 1));
    }
  }
}

/* 前复权日K：返回 { "2026-06-23": 1.628, ... }
 * ⚠ 缓存必须记窗口：正向与反向对同一代码要的区间不同（前者 06-13 起、后者可能更早），
 * 只按代码缓存会让后来者拿到「不够早」的序列，第一笔流水静默取不到价。 */
async function closes(code, from, to) {
  const k = "p" + code, hit = cache[k];
  if (hit && hit.from <= from && hit.to >= to) return hit.m;
  const sym = px(code);
  const url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" + sym + ",day," + from + "," + to + ",320,qfq";
  const j = await getJSON(url);
  const arr = (j.data && j.data[sym] && (j.data[sym].qfqday || j.data[sym].day)) || [];
  const m = {};
  arr.forEach((r) => { if (+r[2] > 0) m[r[0]] = +r[2]; });
  cache[k] = { from, to, m };
  return m;
}

/* 历史净值：倒序 + 每页 20，翻页取到 from 之前为止（同样按窗口缓存，理由见 closes） */
async function navs(code, from) {
  const k = "n" + code, hit = cache[k];
  if (hit && hit.from <= from) return hit.m;
  const m = {};
  for (let page = 1; page <= 12; page++) {
    let j;
    try {
      j = await getJSON("https://api.fund.eastmoney.com/f10/lsjz?fundCode=" + code + "&pageIndex=" + page + "&pageSize=20",
        { Referer: "https://fundf10.eastmoney.com/" });
    } catch (e) { break; }
    const list = (j.Data && j.Data.LSJZList) || [];
    if (!list.length) break;
    list.forEach((x) => { if (+x.DWJZ > 0) m[x.FSRQ] = +x.DWJZ; });
    if (list[list.length - 1].FSRQ < from) break;   // 已经翻到窗口之前
    await sleep(120);                                // 东财接口对连续请求不友好，稍作间隔
  }
  cache[k] = { from, m };
  return m;
}

/* 取「不晚于 d 的最近一条」 */
function at(series, d) {
  const ks = Object.keys(series).filter((x) => x <= d).sort();
  return ks.length ? { d: ks[ks.length - 1], v: series[ks[ks.length - 1]] } : null;
}
const pct = (x) => (x * 100).toFixed(2) + "%";
const yuan = (x) => Math.round(x).toLocaleString("en-US");
const signed = (x) => (x >= 0 ? "+" : "\u2212") + yuan(Math.abs(x));

/* ---------- 读 data.js 里的实际操作流水 ---------- */
function readPositions() {
  const src = readFileSync(join(ROOT, "data.js"), "utf8");
  const m = src.match(/const POSITIONS = \{[\s\S]*?\n\};/);
  if (!m) throw new Error("data.js 里找不到 POSITIONS");
  return eval("(" + m[0].replace("const POSITIONS =", "").replace(/;$/, "") + ")");
}

/* ---------- 反向模拟：你场外的钱如果买场内 ----------
 * 与正向（场内流水换成别家场内产品）方向相反：这里把「场外的申购」换成「场内 ETF」。
 * ⚠ 场外没有逐笔申购记录（快照带明细的只有 2026-09-07 起、且前 4 期是简快照），
 *    所以只能构造流水：① 整笔本金按 OTC_START 一次性投入；② 其后按快照期「持仓成本的增量」补投。
 *    两侧用同一套流水、同样的金额与日期，唯一差别是成交渠道（场内收盘价 vs 场外当日净值）
 *    → 差出来的就是「渠道 + 溢价」，而不是择时。
 * 只纳入有明确同类场内的场外基金；023402 全球精选 / 007280 日本精选 / 015884 港股数字
 * 没有对应场内候选（本仓库候选清单里没有），不纳入。 */
const OTC_START = "2026-06-23";   // MANUAL 假设：这笔场外本金的起始投入日。知道真实首笔申购日就改这里
/* 命令行：--start=YYYY-MM-DD 覆盖上面的假设（只影响本次运行，用于做敏感性试算）；
 *         --dry 只打印不写盘（不动 data.js，也不刷新 outputs/ 报告）——试算时必带。 */
const ARGV = process.argv.slice(2);
const argOf = (n) => { const a = ARGV.find((x) => x.startsWith("--" + n + "=")); return a ? a.split("=")[1] : null; };
const DRY = ARGV.includes("--dry");
const START = argOf("start") || OTC_START;
const OTC_MAP = [
  { code: "021000", group: "ndx" }, { code: "021778", group: "ndx" },
  { code: "040046", group: "ndx" }, { code: "014978", group: "ndx" },
  { code: "018738", group: "spx" },
];

/* 页面内联数据（SNAPSHOTS / OTC 在 positions.html，不在 data.js）：常量名 → 括号配平扫描 → vm 求值 */
function pageData() {
  const src = readFileSync(join(ROOT, "positions.html"), "utf8");
  const grab = (name) => {
    const head = "const " + name + " = ";
    const i = src.indexOf(head);
    if (i < 0) throw new Error("positions.html 里找不到 " + head.trim());
    let j = i + head.length, depth = 0, inStr = null, end = -1;
    for (; j < src.length; j++) {
      const c = src[j], p = src[j - 1];
      if (inStr) { if (c === inStr && p !== "\\") inStr = null; continue; }
      if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") { depth--; if (!depth) { end = j + 1; break; } }
    }
    if (end < 0) throw new Error(name + " 结构未闭合");
    const box = {}; vm.createContext(box);
    vm.runInContext("this.X = " + src.slice(i + head.length, end) + ";", box, { timeout: 3000 });
    return box.X;
  };
  return { snap: grab("SNAPSHOTS"), otc: grab("OTC") };
}

/* 由快照里「持仓成本」的增量还原申购流水（成本只增不减；若出现减少，份额按同比例卖出） */
function flowsOf(cost, series, start) {
  const flows = [];
  let prev = null, added = 0;
  (series || []).slice().sort((a, b) => (a.d < b.d ? -1 : 1)).forEach((p) => {
    if (prev !== null && p.cost > prev.cost) { flows.push({ d: p.d, amt: p.cost - prev.cost }); added += p.cost - prev.cost; }
    prev = p;
  });
  const bulk = cost - added;
  if (bulk > 1) flows.unshift({ d: start, amt: bulk });
  return { flows, bulk: Math.max(0, bulk), added, first: (series && series.length) ? series[0].d : null };
}

/* 同一套流水走一条价格/净值序列：得到期末市值（序列里取「不晚于该日的最近一条」） */
function simChannel(flows, series, to) {
  let units = 0;
  for (const f of flows) {
    const p = at(series, f.d);
    if (!p) return null;
    units += f.amt / p.v;
  }
  const end = at(series, to);
  return end ? units * end.v : null;
}

async function runReverse(P, page) {
  const funds = [];
  for (const map of OTC_MAP) {
    const f = (page.otc.funds || []).find((x) => x.code === map.code);
    const g = UNIVERSE.find((x) => x.key === map.group);
    if (!f || !g) continue;
    const cost = f.value - f.pnl;                       // 场外本金 = 现值 − 持仓收益
    const series = [];
    page.snap.filter((s) => s.items).forEach((s) => { const it = s.items[map.code]; if (it && Number.isFinite(it.cost)) series.push({ d: s.d, cost: it.cost }); });
    const { flows, bulk, added, first } = flowsOf(cost, series, START);
    if (!flows.length) continue;

    /* 取价窗口比首笔流水提前 10 天：首笔那天可能不是交易日（或刚好是上市首日），
       simChannel 用「不晚于该日的最近一条」，提前取数才保证第一笔也能成交。 */
    const from = new Date(Date.parse(flows[0].d) - 10 * 86400000).toISOString().slice(0, 10);
    const nv = await navs(map.code, from);
    /* 期末统一取「你的场内标的最近收盘日」，与正向表一致 */
    const minePx = await closes(g.mine, from, "2099-12-31");
    const days = Object.keys(minePx).filter((d) => d >= flows[0].d).sort();
    const to = days[days.length - 1];
    const base = simChannel(flows, nv, to);
    if (!base) { console.log("  跳过 " + map.code + "：场外净值序列取不到首笔日（" + flows[0].d + "）之前的数据"); continue; }

    const rows = [];
    for (const [code, name, rate] of g.etf) {
      const b = await closes(code, from, to);
      if (!b[to]) continue;
      const final = simChannel(flows, b, to);
      if (final === null) continue;
      rows.push({ code, name, rate, final, ret: final / cost - 1, diff: final - base, diffPp: final / cost - base / cost, mine: code === g.mine });
    }
    rows.sort((a, b) => b.final - a.final);
    if (!rows.length) { console.log("  跳过 " + map.code + "：窗口内取不到候选行情"); continue; }
    /* 只展示两行：你的标的 + 本区间最好的同类（行数一多，这一块会盖过正向表） */
    const keep = rows.filter((r) => r.mine || r === rows[0]);
    /* 页面主表只用「你的场内同类」这一条：它回答的是「这笔钱如果买我场内那只」，
       换别家的差异已经在正向表里说过了；其余候选仍在 rows 里（报告与 ?debug 用）。 */
    const mineRow = rows.find((r) => r.mine) || rows[0];
    funds.push({
      code: map.code, name: f.name, group: g.key, label: g.label,
      short: String(f.name).replace(/\(QDII\)/g, "").replace(/人民币/g, "").trim(),
      cost: r2(cost), value: r2(f.value), pnl: r2(f.pnl),
      bulk: r2(bulk), added: r2(added), nFlows: flows.length,
      first: first || START, to,
      base: r2(base), baseRet: r6(base / cost - 1),
      mineCode: mineRow.code, mineName: mineRow.name,
      mineFinal: r2(mineRow.final), mineDiff: r2(mineRow.final - base), mineDiffPp: r6(mineRow.final / cost - base / cost),
      rows: keep.map((r) => ({ code: r.code, name: r.name, rate: r.rate, mine: r.mine, final: r2(r.final), ret: r6(r.ret), diff: r2(r.diff), diffPp: r6(r.diffPp) })),
      allBest: rows.length ? { code: rows[0].code, name: rows[0].name } : null,
    });
    console.log("  反向 " + map.code + " " + f.name.slice(0, 18).padEnd(20) + "本金 " + yuan(cost).padStart(8) +
      " → 场外 " + yuan(base).padStart(8) + " ｜ 场内最好 " + (rows[0] ? rows[0].name + " " + yuan(rows[0].final) : "—") +
      " （" + (rows[0] ? signed(rows[0].final - base) + " / " + (rows[0].diffPp * 100).toFixed(2) + "pp" : "—") + "）");
  }
  /* 合计：把所有场外本金当一笔看——「全留场外」vs「全换成你场内那只」。
     它的意义是把 5 只小额的零散差异收成一个数，方便一眼判断渠道值不值。 */
  let total = null;
  if (funds.length) {
    const cost = funds.reduce((a, f) => a + f.cost, 0);
    const base = funds.reduce((a, f) => a + f.base, 0);
    const mineFinal = funds.reduce((a, f) => a + f.mineFinal, 0);
    total = { n: funds.length, cost: r2(cost), base: r2(base), mineFinal: r2(mineFinal), diff: r2(mineFinal - base), diffPp: r6(mineFinal / cost - base / cost) };
  }
  if (total) console.log("  合计 本金 " + yuan(total.cost) + " → 留场外 " + yuan(total.base) + " ｜ 若买场内 " +
    yuan(total.mineFinal) + "  差 " + signed(total.diff) + " / " + (total.diffPp * 100).toFixed(2) + "pp");
  return {
    start: START,
    note: "本金按假设起始日一次性投入；其后按快照期「持仓成本增量」补投（快照明细自 " + (funds.length ? funds[0].first : "—") + " 起）。两侧同一套流水、同金额同日期，只差成交渠道：场内收盘价 vs 场外当日净值。",
    funds,
    total,
  };
}

/* ---------- 单组回测 ---------- */
async function runGroup(g, P, log) {
  const codeOf = {};
  P.hold.forEach((h) => { codeOf[h.sym] = h.code; });
  const trades = P.log.filter((e) => codeOf[e.sym] === g.mine && /买入|建仓/.test(e.act));
  const sells = P.log.filter((e) => codeOf[e.sym] === g.mine && /卖出|减仓|清仓/.test(e.act));
  if (!trades.length) return null;

  const first = trades.map((t) => t.d).sort()[0];
  const from = new Date(Date.parse(first) - 10 * 86400000).toISOString().slice(0, 10);
  const total = trades.reduce((a, t) => a + t.qty * t.cost, 0);

  const minePx = await closes(g.mine, from, "2099-12-31");
  const mineDays = Object.keys(minePx).sort();
  const last = mineDays[mineDays.length - 1];
  const to = last;

  const rows = [];
  for (const [code, name, rate, size] of g.etf) {
    const b = await closes(code, from, to);
    if (!b[to] || !trades.every((t) => b[t.d])) { rows.push({ code, name, rate, size, broken: true }); continue; }
    let units = 0, flatUnits = 0;
    trades.forEach((t) => { const amt = t.qty * t.cost; units += amt / b[t.d]; flatUnits += 1000 / b[t.d]; });
    const final = units * b[to], finalFlat = flatUnits * b[to];
    const nv = await navs(code, from);
    const ns = at(nv, first), ne = at(nv, to);
    rows.push({
      code, name, rate, size, final,
      ret: final / total - 1,
      retFlat: finalFlat / (trades.length * 1000) - 1,
      navRet: ns && ne ? ne.v / ns.v - 1 : null,
      premStart: ns ? b[first] / ns.v - 1 : null,
      premEnd: ne ? b[to] / ne.v - 1 : null,
    });
  }
  const ok = rows.filter((r) => !r.broken);
  const base = ok.find((r) => r.code === g.mine);
  ok.forEach((r) => { r.diff = r.final - base.final; r.diffPp = r.ret - base.ret; });
  ok.sort((a, b) => b.final - a.final);

  /* 场外同类：按当日净值申购（实际 QDII 为 T+1/T+2 确认，未计申购费，故结果略偏乐观） */
  const otc = [];
  for (const [code, name, rate] of g.otc) {
    const nv = await navs(code, from);
    if (!trades.every((t) => at(nv, t.d))) continue;
    let units = 0, flatUnits = 0;
    trades.forEach((t) => { const p = at(nv, t.d).v; units += t.qty * t.cost / p; flatUnits += 1000 / p; });
    const end = at(nv, to);
    const final = units * end.v, finalFlat = flatUnits * end.v;
    const ns = at(nv, first);
    const ret = final / total - 1;
    otc.push({
      code, name, rate, final, ret,
      retFlat: finalFlat / (trades.length * 1000) - 1,
      navRet: end.v / ns.v - 1,
      diff: final - base.final,
      /* ⚠ 是「收益率之差」不是「市值/投入 − 基准收益率」：早先漏了 −1，把 pp 放大成 96pp */
      diffPp: ret - base.ret,
    });
  }

  /* 你的真实成交口径（用于对照：你的盘中择时贡献了多少） */
  const realUnits = trades.reduce((a, t) => a + t.qty, 0);
  const realFinal = realUnits * minePx[to];
  const realRet = realFinal / total - 1;

  return {
    ...g, rows: ok, broken: rows.filter((r) => r.broken), otc, base,
    trades: trades.length, sells: sells.length, first, to, total, realUnits, realFinal, realRet,
    span: (Date.parse(to) - Date.parse(first)) / 86400000,
  };
}

/* ---------- 报告 HTML ---------- */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cls2 = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");

function groupHtml(g) {
  const rows = g.rows.map((r) => {
    const mine = r.code === g.mine;
    return '<tr class="' + (mine ? "mine" : "") + '">' +
      '<td class="c">' + r.code + "</td>" +
      '<td class="n">' + esc(r.name) + (mine ? ' <em>你的</em>' : "") + "</td>" +
      '<td class="r">' + r.rate.toFixed(2) + "%</td>" +
      '<td class="r b">' + yuan(r.final) + "</td>" +
      '<td class="r ' + cls2(r.ret) + '">' + pct(r.ret) + "</td>" +
      '<td class="r ' + cls2(r.diff) + '">' + (mine ? "基准" : signed(r.diff) + " <s>" + (r.diffPp >= 0 ? "+" : "\u2212") + Math.abs(r.diffPp * 100).toFixed(2) + "pp</s>") + "</td>" +
      '<td class="r">' + pct(r.retFlat) + "</td>" +
      '<td class="r mut">' + (r.navRet === null ? "—" : pct(r.navRet)) + "</td>" +
      '<td class="r mut">' + (r.premStart === null ? "—" : (r.premStart * 100).toFixed(1) + "% → " + (r.premEnd * 100).toFixed(1) + "%") + "</td>" +
      '<td class="r mut">' + (r.premStart === null || r.premEnd === null ? "—" : ((r.premEnd - r.premStart) >= 0 ? "+" : "\u2212") + Math.abs((r.premEnd - r.premStart) * 100).toFixed(1) + "pp") + "</td>" +
      '<td class="r mut">' + (r.size === null ? "—" : r.size.toFixed(0) + "亿") + "</td>" +
      "</tr>";
  }).join("");
  const otcRows = g.otc.map((r) => '<tr class="otc">' +
    '<td class="c">' + r.code + "</td>" +
    '<td class="n">' + esc(r.name) + ' <em>场外</em></td>' +
    '<td class="r">' + r.rate.toFixed(2) + "%</td>" +
    '<td class="r b">' + yuan(r.final) + "</td>" +
    '<td class="r ' + cls2(r.ret) + '">' + pct(r.ret) + "</td>" +
    '<td class="r ' + cls2(r.diff) + '">' + signed(r.diff) + " <s>" + (r.diffPp >= 0 ? "+" : "\u2212") + Math.abs(r.diffPp * 100).toFixed(2) + "pp</s></td>" +
    '<td class="r">' + pct(r.retFlat) + "</td>" +
    '<td class="r mut">' + pct(r.navRet) + "</td>" +
    '<td class="r mut" colspan="3">无溢价 · 按当日净值申购</td></tr>').join("");

  const best = g.rows[0], worst = g.rows[g.rows.length - 1];
  const rank = g.rows.findIndex((r) => r.code === g.mine) + 1;
  const navSpread = (() => {
    const v = g.rows.map((r) => r.navRet).filter((x) => x !== null);
    return v.length ? [Math.min(...v), Math.max(...v)] : null;
  })();
  const otcBest = g.otc.slice().sort((a, b) => b.final - a.final)[0];

  return '<section class="grp">' +
    '<h2>' + esc(g.label) + ' <span class="sub">你的标的 ' + g.mine + " · 投入 " + yuan(g.total) + " 元 · " +
      g.trades + " 笔" + (g.sells ? " + " + g.sells + " 笔卖出（本版未建模卖出）" : "买入无卖出") + " · " +
      g.first + " → " + g.to + "（" + Math.round(g.span) + " 天）</span></h2>" +
    '<div class="scroll"><table>' +
      "<thead><tr>" +
      "<th>代码</th><th>名称</th><th>费率</th><th>期末市值</th><th>收益</th><th>与你的差</th>" +
      "<th>每笔<br>1000元</th><th>净值<br>同期</th><th>溢价<br>期初→期末</th><th>溢价<br>变动</th><th>规模</th>" +
      "</tr></thead><tbody>" + rows + otcRows + "</tbody></table></div>" +
    '<ul class="facts">' +
      "<li><b>换标的能影响的量级</b>：最好 " + esc(best.name) + " " + yuan(best.final) + " vs 最差 " + esc(worst.name) + " " + yuan(worst.final) +
        " → 差 <b>" + yuan(best.final - worst.final) + " 元</b>（" + ((best.ret - worst.ret) * 100).toFixed(2) + "pp）；你的排第 <b>" + rank + " / " + g.rows.length + "</b></li>" +
      (navSpread ? "<li><b>差异不在净值、在溢价</b>：同区间各候选净值涨幅只在 " + pct(navSpread[0]) + " ~ " + pct(navSpread[1]) +
        " 之间（差 " + ((navSpread[1] - navSpread[0]) * 100).toFixed(2) + "pp，跟踪几乎一致），而场内收益差 " +
        ((best.ret - worst.ret) * 100).toFixed(2) + "pp —— 排序基本由溢价变动决定</li>" : "") +
      (otcBest ? "<li><b>场外路线（无溢价）</b>：" + esc(otcBest.name) + " " + yuan(otcBest.final) + "（" + pct(otcBest.ret) + "）→ 比你的场内存 " +
        signed(otcBest.diff) + " 元（" + (otcBest.diffPp >= 0 ? "+" : "\u2212") + Math.abs(otcBest.diffPp * 100).toFixed(2) + "pp）。" +
        "注意这是本区间的<em>结果</em>，不等于长期结论：场内多出的部分是溢价变动，会双向波动</li>" : "") +
      "<li><b>你的真实成交</b>：" + yuan(g.total) + " 元买入 " + g.realUnits.toLocaleString("en-US") + " 份 → " + yuan(g.realFinal) + " 元（" + pct(g.realRet) +
        "）；同口径全按收盘价买入为 " + pct(g.base.ret) + "，差额即你的盘中择时</li>" +
    "</ul></section>";
}

const CSS = `
:root{--bg:#0f1420;--card:#171d2b;--card2:#1d2434;--line:#2b3448;--line2:#38445c;--tx:#e6ecf7;--tx2:#b3bfd4;--tx3:#8895ad;
--accent:#4d8dff;--up:#3ecf8e;--down:#ff6b7a;--warn:#ffc857;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:light){:root{--bg:#f4f6fa;--card:#fff;--card2:#f7f9fc;--line:#dde4ef;--line2:#c6d0e0;--tx:#16181d;--tx2:#3a4254;--tx3:#66708a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;padding:20px 14px 60px}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:20px;margin:0 0 6px}.lead{color:var(--tx3);font-size:12px;margin-bottom:16px;font-family:var(--mono)}
.grp{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 14px 6px;margin:16px 0}
h2{font-size:15px;margin:0 0 10px;font-weight:700}h2 .sub{font-weight:400;color:var(--tx3);font-size:11px;font-family:var(--mono)}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -4px}
table{border-collapse:collapse;width:100%;min-width:860px;font-size:12px}
th,td{padding:6px 7px;border-bottom:1px solid var(--line);white-space:nowrap;text-align:left}
th{font-size:10px;color:var(--tx3);font-weight:700;letter-spacing:.04em;border-bottom:1px solid var(--line2);vertical-align:bottom}
td.r,th:nth-child(n+4){text-align:right}td.c,td.r.b{font-family:var(--mono);font-feature-settings:"tnum"}
td.b{font-weight:700}td.mut,th:nth-child(n+8){color:var(--tx3)}
td.n em{font-style:normal;font-size:10px;color:var(--warn);border:1px solid var(--warn);border-radius:999px;padding:0 5px;margin-left:4px}
td s{text-decoration:none;color:var(--tx3);font-size:10px;margin-left:3px}
tr.mine{background:color-mix(in srgb,var(--accent) 12%,transparent)}tr.otc td{background:var(--card2)}
.up{color:var(--up)}.down{color:var(--down)}
.facts{margin:10px 0 8px;padding-left:18px;font-size:12px;color:var(--tx2)}.facts li{margin:4px 0}.facts b{color:var(--tx)}
.note{background:var(--card);border:1px solid var(--line);border-left:2px solid var(--accent);border-radius:8px;padding:12px 14px;font-size:12px;color:var(--tx2);margin-top:16px}
.note b{color:var(--tx)}.note ul{margin:6px 0 0;padding-left:18px}
@media print{:root{--bg:#fff;--card:#fff;--card2:#fafafa;--line:#999;--line2:#666;--tx:#111;--tx2:#333;--tx3:#555}
body{padding:0}.scroll{overflow:visible}table{min-width:0;font-size:10px}th,td{padding:3px 4px}}
`;

/* 报告里的反向表：每只场外一段（基准行 = 同一套流水走场外净值），下面是「换成哪只场内会怎样」 */
function reverseHtml(rev) {
  if (!rev || !rev.funds || !rev.funds.length) return "";
  const body = rev.funds.map((f) => {
    const base = '<tr class="otc"><td class="c">' + f.code + "</td>" +
      '<td class="n">' + esc(f.name) + ' <em>你的场外</em></td><td class="r">—</td>' +
      '<td class="r b">' + yuan(f.base) + "</td>" +
      '<td class="r ' + cls2(f.baseRet) + '">' + pct(f.baseRet) + '</td><td class="r">基准</td></tr>';
    const rows = f.rows.map((r) => '<tr class="' + (r.mine ? "mine" : "") + '">' +
      '<td class="c">' + r.code + "</td>" +
      '<td class="n">' + esc(r.name) + (r.mine ? ' <em>你在场内持有的同类</em>' : "") + "</td>" +
      '<td class="r">' + r.rate.toFixed(2) + "%</td>" +
      '<td class="r b">' + yuan(r.final) + "</td>" +
      '<td class="r ' + cls2(r.ret) + '">' + pct(r.ret) + "</td>" +
      '<td class="r ' + cls2(r.diff) + '">' + signed(r.diff) + " <s>" +
      (r.diffPp >= 0 ? "+" : "\u2212") + Math.abs(r.diffPp * 100).toFixed(2) + "pp</s></td></tr>").join("");
    return base + rows;
  }).join("");
  const totalRow = rev.total ? '<tr class="mine"><td class="c">Σ</td>' +
    '<td class="n">合计 · ' + rev.total.n + " 只场外本金</td><td class=\"r\">—</td>" +
    '<td class="r b">' + yuan(rev.total.base) + "</td>" +
    '<td class="r ' + cls2(rev.total.base / rev.total.cost - 1) + '">' + pct(rev.total.base / rev.total.cost - 1) + "</td>" +
    '<td class="r ' + cls2(rev.total.diff) + '">' + signed(rev.total.diff) + " <s>" +
    (rev.total.diffPp >= 0 ? "+" : "\u2212") + Math.abs(rev.total.diffPp * 100).toFixed(2) + "pp</s></td></tr>" : "";
  return '<section class="grp"><h2>反向：你场外的钱如果买场内 <span class="sub">假设本金在 ' + rev.start +
    " 一次性投入，其后按快照期持仓成本增量补投；两侧同一套流水、同金额同日期，只差成交渠道（场内收盘价 vs 场外当日净值）</span></h2>" +
    '<div class="scroll"><table><thead><tr><th>代码</th><th>标的</th><th>费率</th><th>期末市值</th><th>收益</th><th>与你的场外比</th></tr></thead><tbody>' +
    body + totalRow + "</tbody></table></div>" +
    '<ul class="facts"><li>' + esc(rev.note) + "</li>" +
    "<li>页面上的反向表只显示「你的场内同类」这一条（每只场外一行 + 合计）；这里把每只的候选都列出来，便于核实。</li></ul></section>";
}

function page(results, meta, reverse) {
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>标的替换回测 · NDX/SPX 看板</title><style>" + CSS + "</style></head><body><div class=\"wrap\">" +
    "<h1>🔁 标的替换回测</h1>" +
    '<div class="lead">同样的日期、同样的金额，换成同类别里的另一只产品 → 到期末差多少<br>' +
    "期末 " + meta.to + " 收盘 · 场内价 腾讯前复权日K · 净值 东方财富 · 生成于 " + meta.now +
    (meta.broken.length ? " · ⚠ 数据缺失： " + meta.broken.join("，") : "") + "</div>" +
    results.map(groupHtml).join("") +
    reverseHtml(reverse) +
    '<div class="note"><b>口径（务必先读）</b><ul>' +
    "<li>每笔按你当天的<b>实际花费金额</b>，买入候选标的<b>当日收盘价</b>（前复权）；你的持仓也按收盘价重算，只比标的、不比盘中择时。</li>" +
    "<li><b>佣金两边相同 → 抵消</b>（同券商同费率）；<b>管理费/托管费已含在净值里</b>，无需另计。</li>" +
    "<li><b>未建模卖出</b>：只对同类别的买入流水做替换（本区间这批标的没有卖出）。</li>" +
    "<li>场外按当日净值申购：真实 QDII 为 T+1/T+2 确认、且有申购费（约 0.1%），故场外结果<b>略偏乐观</b>。</li>" +
    "<li>溢价 = 场内收盘 ÷ 同期最新净值 − 1（QDII 净值滞后约 1 个交易日，与看板内口径一致）。</li>" +
    "<li>候选清单与费率是人工维护（招募说明书摘要）；费率仅用于展示，不参与计算。</li>" +
    "</ul><b>怎么读</b>：先看「与你的差」判断换标的的量级，再看「净值同期 / 溢价变动」判断差异从哪来——" +
    "净值普遍一致时，场内收益差几乎全部来自溢价变动，而溢价会双向波动，不是可以稳定套利的东西。</div>" +
    "</div></body></html>";
}

/* ---------- 回写 data.js：与 fetch_and_update 同一套事务（校验 → 审计 → 原子写） ---------- */
const r2 = (x) => Math.round(x * 100) / 100;    // 金额：保留分
const r6 = (x) => Math.round(x * 1e6) / 1e6;    // 收益率：6 位小数足够

function payloadOf(results, reverse) {
  return {
    asOf: results[0].to,
    source: "腾讯前复权日K + 东财历史净值",
    method: "每笔按实际花费金额买候选当日收盘价（前复权）；基准同口径重算；佣金相抵；费率已含在净值内",
    reverse,

    groups: results.map((g) => ({
      key: g.key, label: g.label, mine: g.mine, first: g.first, to: g.to,
      trades: g.trades, sells: g.sells, total: r2(g.total),
      real: { units: g.realUnits, final: r2(g.realFinal), ret: r6(g.realRet) },
      /* rows 必须按 final 降序：页面直接取首行作「最好」、末行作「最差」 */
      rows: g.rows.map((r) => ({
        code: r.code, name: r.name, rate: r.rate, size: r.size,
        final: r2(r.final), ret: r6(r.ret), retFlat: r6(r.retFlat),
        navRet: r.navRet === null ? null : r6(r.navRet),
        premStart: r.premStart === null ? null : r6(r.premStart),
        premEnd: r.premEnd === null ? null : r6(r.premEnd),
        diff: r2(r.final - g.base.final), diffPp: r6(r.ret - g.base.ret),
        mine: r.code === g.mine,
      })),
      otc: g.otc.map((r) => ({
        code: r.code, name: r.name, rate: r.rate,
        final: r2(r.final), ret: r6(r.ret), retFlat: r6(r.retFlat), navRet: r6(r.navRet),
        diff: r2(r.final - g.base.final), diffPp: r6(r.diffPp),
      })),
    })),
  };
}

function writeData(payload) {
  const src = readFileSync(DATA, "utf8");
  const anchor = /^const ALT_BACKTEST = \{[\s\S]*?^\};/m;
  if (!anchor.test(src)) throw new Error("data.js 里缺少 const ALT_BACKTEST = {...}; 锚点（先手工加占位块）");
  /* 整块用 JSON 重写：replaceConst 是逐值重写的，会把嵌套数组压成一行，可读性全失；
     这里沿用 fetch_and_update 处理 MONTHLY 的手法（整块 replace + JSON.stringify）。 */
  /* JSON.stringify 会给键加引号，而本仓库 data.js 一律用裸标识符键；只把「行首 + 键 + 冒号」
     的引号去掉（JSON 里字符串不跨行，所以这个替换不会误伤字符串值内部的 ": "）。 */
  const literal = JSON.stringify(payload, null, 2).replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, "$1$2:");
  const next = src.replace(anchor, () => "const ALT_BACKTEST = " + literal + ";");
  const errors = validateModel(readModel(next));
  if (errors.length) throw new Error("候选数据未过 schema 校验：" + errors.join("；"));
  if (readFileSync(DATA, "utf8") !== src) throw new Error("data.js 在抓取期间被改动，放弃写入");
  const gate = auditFiles(ROOT_URL);
  if (gate.length) throw new Error("写前审计未通过：" + gate.join("；"));
  atomicWrite(DATA, next);
}

/* ---------- 主流程 ---------- */
async function main() {
  const P = readPositions();
  const results = [];
  const broken = [];
  for (const g of UNIVERSE) {
    const r = await runGroup(g, P, P.log);
    if (!r) { console.log("跳过 " + g.label + "：data.js 里没有该标的的买入流水"); continue; }
    (r.broken || []).forEach((b) => broken.push(g.label + " " + b.code));
    results.push(r);
    console.log("");
    console.log("=== " + g.label + "（你的 " + g.mine + "）" + r.trades + " 笔买入 · " + r.first + " → " + r.to + " · 投入 " + yuan(r.total) + " 元");
    r.rows.forEach((x) => console.log("  " + x.code + "  " + x.name.padEnd(20) + yuan(x.final).padStart(9) +
      "  " + pct(x.ret).padStart(7) + "  " + (x.code === g.mine ? "基准" : signed(x.diff) + " / " + (x.diffPp * 100).toFixed(2) + "pp").padStart(18) +
      "  净值 " + (x.navRet === null ? "—" : pct(x.navRet)) + "  溢价 " + (x.premStart === null ? "—" : (x.premStart * 100).toFixed(1) + "%→" + (x.premEnd * 100).toFixed(1) + "%")));
    r.otc.forEach((x) => console.log("  " + x.code + "  " + x.name.padEnd(20) + yuan(x.final).padStart(9) + "  " + pct(x.ret).padStart(7) + "  " +
      (signed(x.diff) + " / " + (x.diffPp * 100).toFixed(2) + "pp").padStart(18) + "  场外（按净值申购）"));
  }
  const meta = { to: results[0] ? results[0].to : "—", now: new Date().toISOString().slice(0, 16).replace("T", " "), broken };
  mkdirSync(OUT, { recursive: true });
  console.log("");
  console.log("=== 反向：你场外的钱如果买场内（假设起始日 " + START + "）===");
  const reverse = await runReverse(P, pageData());
  if (!reverse.funds.length) console.log("  （没有可映射的场外基金，反向表为空）");
  if (DRY) {
    console.log("");
    console.log("（--dry：只做试算——未写入 data.js，也没有刷新 outputs/ 报告）");
    return;
  }
  const file = join(OUT, "alt-etf-backtest.html");
  writeFileSync(file, page(results, meta, reverse), "utf8");
  console.log("");
  console.log("报告已生成：" + file);
  if (results.length) {
    writeData(payloadOf(results, reverse));
    console.log("data.js: ALT_BACKTEST 已更新（期末 " + meta.to + "，AUTO 块由本脚本整块重写）");
  } else {
    console.log("⚠ 没有跑出任何分组（data.js 里查不到候选的买入流水），已跳过 data.js 回写以避免写入空块");
  }
  console.log("（outputs/ 已在 .gitignore 中，属可再生产物；改候选清单改本脚本顶部的 UNIVERSE）");
}

/* 只有直接运行本文件时才执行；被 import（如 fetch-fees.mjs 复用 UNIVERSE）时不做任何事 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("失败：" + e.message); process.exitCode = 1; });
}
