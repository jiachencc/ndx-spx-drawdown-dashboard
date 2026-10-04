#!/usr/bin/env node
/* 场外基金的「净值区间」与「买点」刷新（2026-09-27 加）
 *
 * 为什么需要：
 *   体检的「买点」项要的是**每一笔申购时的净值**，而 OTC_LOG 里只记了金额（日期 + 金额 + 状态）；
 *   东财历史净值接口（api.fund.eastmoney.com/f10/lsjz）能按基金代码 + 日期区间拿到逐日净值，
 *   于是「申购日 → 当天净值」可以自动补齐，不用人工抄。顺带把 nav.hi / nav.lo（52 周区间）
 *   从人工维护改成自动计算 —— 之前那两个数是截图时手填的。
 *
 * 口径（与页面一致，别在这里另立一套）：
 *   · 52 周区间 = 最近 52 周内的净值最大 / 最小（DWJZ 单位净值，与 OTC.funds[].nav.close 同口径）
 *   · 某笔申购的净值 = 该申购日**或之前最近一个交易日**的净值（申购按当日净值确认，遇非交易日顺延）
 *   · 买点分位 = (该笔净值 − lo) / (hi − lo) × 100；多笔取平均 → 写进 nav.buyPct
 *   · 没有 OTC_LOG 的基金（支付宝渠道那两只）**不算 buyPct** —— 缺的是申购日期，不是净值
 *
 * 2026-10-04 增加一项产出：**OTC_BUYNAV**（逐笔申购日净值，位置见本文件末尾的说明）。
 *   起因：这个脚本一直在抓近 52 周逐日净值，却只拿它算 hi/lo —— 而「每笔申购那天净值多少」
 *   正是「逐笔盈亏」唯一缺的那块（金额在 OTC_LOG 里有）。数据本来就在手上，白扔了 ✗。
 *
 * 用法：node scripts/refresh-otc.mjs          只打印（dry-run）
 *      node scripts/refresh-otc.mjs --write  写回 positions-data.js（2026-09-27 前是 positions.html）
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/* ⚠ 2026-09-27 起 OTC / OTC_LOG 在 positions-data.js 里（原先内联在 positions.html）——
   本脚本只读 OTC_LOG、只写 OTC.funds[].nav，两处都在数据文件里，故整份读写都指向它。
   正则锚点 `^const OTC = {` / `^const OTC_LOG = {` 照旧可用（数据文件的三个常量都在行首）。 */
const FILE = path.join(ROOT, "positions-data.js");
const WRITE = process.argv.includes("--write");
const H = { "User-Agent": "Mozilla/5.0", Referer: "https://fundf10.eastmoney.com/" };
const WEEKS52_MS = 364 * 86400000;

let src = readFileSync(FILE, "utf8");   // 循环里要逐只替换后累积，所以是 let
const ctx = vm.createContext({});
vm.runInContext(src.match(/^const OTC = \{[\s\S]*?^\};/m)[0] + "\nthis.O = OTC;", ctx);
vm.runInContext(src.match(/^const OTC_LOG = \{[\s\S]*?^\};/m)[0] + "\nthis.L = OTC_LOG;", ctx);
const OTC = ctx.O, OTC_LOG = ctx.L;

const iso = (d) => d.toISOString().slice(0, 10);

/* 逐页拉取（实测：该接口 pageSize **上限 20**，给再大也只回 20 条；startDate/endDate 也会被忽略，
   所以只能靠 pageIndex 翻页，用日期判断何时停）。一只基金一年约 250 个交易日 → 13~14 页。 */
async function navSeries(code, from, to) {
  const out = [];
  for (let pi = 1; pi <= 16; pi++) {
    /* 每翻一页之间留 150ms（2026-09-27 加）：不加间隔时 110 个请求 4.7 秒跑完 ≈ 23 req/s，
       对公开的 f10 接口算偏快，万一被限流脚本会中途失败。加完约 25 秒 —— 但这是"改数据才跑"
       的低频任务，慢一点换来稳，值得。 */
    if (pi > 1) await new Promise((r) => setTimeout(r, 150));
    const url = "https://api.fund.eastmoney.com/f10/lsjz?fundCode=" + code + "&pageIndex=" + pi + "&pageSize=20";
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const list = (j.Data && j.Data.LSJZList) || [];
    if (!list.length) break;
    let past = false;                       // 本页已翻到窗口之外 → 可以停
    for (const x of list) {
      const d = x.FSRQ, v = Number(x.DWJZ);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(v) || v <= 0) continue;
      if (d < from) { past = true; continue; }
      if (d > to) continue;
      out.push({ d, v });
    }
    if (past) break;
  }
  return out;
}

/* 末值交叉校验（2026-09-27 加）：东财是网页版数据接口（免费、无 key，但非官方、无 SLA，靠 Referer 校验，
   随时可能变），而净值的**逐日历史**免费源目前基本只有它一家 —— 所以主源不动，
   改用**新浪**（另一家公司，真正独立的源）来校验最新一天的净值：
     新浪 https://hq.sinajs.cn/list=f_<code> → var hq_str_f_007280="名称,净值,累计,昨日净值,日期,…"
   ⚠ 新浪只有**最新一天**、没有历史 → 它不能当主源，只能当"报警器"：
     两边差 > 0.5% 就打印警告（不阻断写入 —— 单个源抽风不该让整件事停摆，这与主看板
     "非阻断式交叉校验"的口径一致）。 */
async function sinaLatest(code) {
  try {
    const r = await fetch("https://hq.sinajs.cn/list=f_" + code, { headers: { "User-Agent": H["User-Agent"], Referer: "https://finance.sina.com.cn" } });
    if (!r.ok) return null;
    const t = await r.text();
    const m = t.match(/="([^"]*)"/);
    if (!m) return null;
    const parts = m[1].split(",");
    const nav = Number(parts[1]), d = parts[4];
    return (Number.isFinite(nav) && nav > 0) ? { nav, d } : null;
  } catch { return null; }
}

const today = new Date();
const from = iso(new Date(today.getTime() - WEEKS52_MS)), to = iso(today);
console.log("窗口 " + from + " → " + to + (WRITE ? "（写回）" : "（dry-run）") + "\n");

let out = "", changed = 0;
const buyNavAll = {};      // { code: { "YYYY-MM-DD": 净值 } } —— 逐笔申购日净值，循环里填，末尾整块写回
for (const f of OTC.funds) {
  const code = f.code;
  let series = [];
  try { series = await navSeries(code, from, to); } catch (e) { console.log(code.padEnd(7) + " 抓取失败：" + e.message); continue; }
  if (series.length < 20) { console.log(code.padEnd(7) + " 净值样本不足（" + series.length + " 条），跳过"); continue; }
  const ups = series.map((x) => x.v);
  const hi = Math.max(...ups), lo = Math.min(...ups);
  const hiDate = (series.find((x) => x.v === hi) || {}).d;   // ⚠ hi 改了就必须同步 hiDate，否则页面上的"高点日期"与新区间对不上
  /* ⚠ 只算「成功」的申购/定投：OTC_LOG 头部明写「非『成功』一律**不计入**计算」——
     第一版用了全部记录（把失败/已撤单也算进了买点），2026-09-27 随加权口径一并修正。 */
  const log = (OTC_LOG[code] || []).filter((e) => e.status === "成功" && /申购|定投/.test(String(e.act)));
  /* 每笔申购取「该日或之前最近一个交易日」的净值 —— 遇非交易日（周末/节假日）顺延到前一日 */
  const sorted = series.slice().sort((a, b) => (a.d < b.d ? 1 : -1));   // 新 → 旧
  const pcts = [];
  let amtSum = 0, shareSum = 0;
  for (const e of log) {
    const hit = sorted.find((x) => x.d <= e.d);
    if (!hit) continue;
    pcts.push((hit.v - lo) / (hi - lo) * 100);
    amtSum += e.amt;
    shareSum += e.amt / hit.v;                     // 该笔按当日净值能买到的份额
  }
  /* 逐笔申购日净值（2026-10-04 加）：给页面的「逐笔盈亏」用。
     ⚠ 集合与上面 buyPct 的**不同**：这里要的是「一切入金笔」，即 成功 且非赎回
       （申购 / 定投 / 转换 / 部分成功 —— 转换入也是往这只里加钱）。
       而 buyPct 那两个口径是 2026-09-27 定的（只算 申购|定投），页面注释也按那个语义写的，
       **不在这里顺手改**（改了两处口径会打架）。
     ⚠ 按日期存：同一日期多笔必然同一净值（都取「当日或之前最近一个交易日」），故 date → nav 足够。 */
  const inLog = (OTC_LOG[code] || []).filter((e) => e.status === "成功" && !/赎回/.test(String(e.act)));
  const buyNav = {};
  for (const e of inLog) {
    const hit = sorted.find((x) => x.d <= e.d);
    if (hit) buyNav[e.d] = +hit.v.toFixed(4);
  }
  buyNavAll[code] = buyNav;
  /* 两种平均口径（买点项）：
       算术平均 —— 一笔一票，回答「我每次买在区间的什么位置」（页面主数，2026-09-27 前就这一个）
       金额加权 —— 权重＝金额，等价于「加权平均成本的区间分位」，与「成本」项同一套数学
     ⚠ 两者**都不更准**，只是回答不同问题，故并排给出、由页面 title 说明：
       定投固定金额时低净值那些天买到更多份额 → 加权偏低（博时标普E 82% → 78.8%）；
       各期金额悬殊时（广发纳指F 从 1,000/日降到 30/日）→ 加权偏向大额那几天，反而偏高（79% → 83%）。
       实测 6 只的差在 −2.9 ~ +4.0pp，多数在 ±2pp 内。 */
  const buyPct = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
  const buyPctW = shareSum > 0 ? Math.round(((amtSum / shareSum) - lo) / (hi - lo) * 100) : null;
  const old = (f.nav && (f.nav.hi + "/" + f.nav.lo)) || "—";
  /* 与新浪的末值对一遍（非阻断：只打印，不影响写入）—— series[0] 是最新一天（接口按新→旧返回） */
  const sn = await sinaLatest(code);
  let cross;
  if (!sn) cross = " · 新浪校验：取不到，跳过";
  else {
    const dev = Math.abs(sn.nav - series[0].v) / series[0].v * 100;
    cross = dev < 0.5
      ? " · 新浪校验 ✓ " + sn.nav + "@" + sn.d
      : " · ⚠ 新浪差异 " + dev.toFixed(2) + "%（新浪 " + sn.nav + "@" + sn.d + " vs 东财 " + series[0].v + "@" + series[0].d + "）";
  }
  console.log(code.padEnd(7) + (f.name || "").slice(0, 14).padEnd(15) +
    " 样本 " + String(series.length).padStart(3) + " 条 · " + series.at(-1).d + "~" + series[0].d +
    " · hi/lo " + hi.toFixed(4) + "/" + lo.toFixed(4) + "（原 " + old + "）" +
    " · 申购 " + String(log.length).padStart(3) + " 笔 → 买点 " + (buyPct === null ? "（无记录，不算）" : buyPct + "%")
    + (buyPctW === null ? "" : "（金额加权 " + buyPctW + "%）") + cross);
  /* 写回：只替换该只的 hi / lo / buyPct 三个数，其余字段一字不动 */
  if (!WRITE) continue;
  const before = src;
  /* ⚠ positions.html 里是 **JS 对象字面量**（code: "023402"，键不带引号），不是 JSON ——
     第一版按 JSON 写正则（"code": …）结果一处都没匹配上，白跑一轮。
     ⚠⚠ 2026-09-28 订正：原来写的是 `[\\s\\S]{0,600}?`（600 字符窗口），本项目的基金条目注释动辄上千字符，
        于是「code → nav」的距离一旦超过 600 就静默找不到 → 打印「未定位到 nav 块」跳过写入，**自动刷新失效而没人发现**
        （当天 007280 的 lo 该从 1.9056 变 1.8821，就是这么被跳过的）。
        改成「一直往前找，但**不许跨过下一个 `code:`**」—— 注释写多长都不再影响定位，也不会串到下一条基金。 */
  const re = new RegExp("(\\bcode:\\s*\"" + code + "\"(?:(?!\\bcode:)[\\s\\S])*?\\bnav:\\s*\\{)([^}]*)(\\})");
  const m = src.match(re);
  if (!m) { console.log("      ⚠ 未定位到 nav 块，跳过写入"); continue; }
  let body = m[2]
    .replace(/\bhi:\s*[\d.]+/, "hi: " + hi)
    .replace(/\blo:\s*[\d.]+\s*/, "lo: " + lo)   // ⚠ 尾部 \s* 一并吃掉：否则 lo 与后面的「, buyPct」之间会留一个多余空格
    .replace(/,\s*buyPct:\s*[\d.]+/, "")
    .replace(/,\s*buyPct:\s*null/, "")
    .replace(/,\s*buyPctW:\s*[\d.]+/, "")
    .replace(/,\s*buyPctW:\s*null/, "");
  if (hiDate) body = /\bhiDate:/.test(body) ? body.replace(/\bhiDate:\s*"[^"]*"/, 'hiDate: "' + hiDate + '"') : body;
  /* 两个买点口径一起追加（先清掉旧值、再在末尾补上，避免重复键）；顺手去掉 lo 后面遗留的空格 */
  const extra = [];
  if (buyPct !== null) extra.push("buyPct: " + buyPct);
  if (buyPctW !== null) extra.push("buyPctW: " + buyPctW);
  if (extra.length) body = body.replace(/\s*\}\s*$/, "") + ", " + extra.join(", ");
  const after = src.replace(re, "$1" + body + "$3");
  if (after !== before) { src = after; changed++; }
}
if (WRITE) {
  if (changed) { writeFileSync(FILE, src); console.log("\n已写回 " + changed + " 只（hi / lo / buyPct）"); }
  else console.log("\n没有需要改动的（或没定位到 nav 块）");
}

/* ==== OTC_BUYNAV 整块生成与写回（2026-10-04 加）==========================================
 * 用途：页面算「每一笔申购到今天赚了多少」——金额在 OTC_LOG，缺的就是那天的净值；
 *       本脚本本来就在抓近 52 周逐日净值，只拿它算了 hi/lo，这笔数据一直白扔 ✗ → 现在存下来。
 * 结构：{ "基金代码": { "YYYY-MM-DD": 净值, … } }，只含**成功且非赎回**的入金笔（申购/定投/转换/部分成功）。
 *       ⚠ 与上面 buyPct 的集合不同（那个只算 申购|定投），口径差异写在页面注释里。
 * 写法：本块是**生成物** —— 有则整块替换、无则插到 OTC_LOG 之后。所以不要手工编辑它
 *       （下次 --write 会覆盖）；要改口径就改这里。 */
function buyNavBlock(map) {
  const sel = OTC.funds.filter((f) => map[f.code] && Object.keys(map[f.code]).length);
  let n = 0;
  const body = sel.map((f) => {
    const ks = Object.keys(map[f.code]).sort();
    n += ks.length;
    const pairs = ks.map((d) => JSON.stringify(d) + ": " + map[f.code][d]);
    const lines = [];
    for (let i = 0; i < pairs.length; i += 6) lines.push("      " + pairs.slice(i, i + 6).join(", ") + (i + 6 < pairs.length ? "," : ""));
    return "  " + JSON.stringify(f.code) + ": {\n" + lines.join("\n") + "\n  },";
  }).join("\n");
  const head = "/* ---- OTC_BUYNAV：逐笔申购日净值（**生成物**，由 scripts/refresh-otc.mjs --write 整块重写，别手改）----\n"
    + " * 用途：回答「每一笔申购到今天赚了多少」——金额在 OTC_LOG 里，差的只是那天的净值。\n"
    + " * 口径：某笔的净值 ＝ 该申购日**或之前最近一个交易日**的东财单位净值（DWJZ；与非交易日顺延的\n"
    + " *       确认规则一致）。同一天多笔必然同值，故按日期存。\n"
    + " * 集合：**成功且非赎回**的入金笔（申购 / 定投 / 转换 / 部分成功）＝ 页面「逐笔盈亏」的同一集合。\n"
    + " *       ⚠ 与 nav.buyPct 的集合（申购|定投，2026-09-27 定）不同，两者别互相折算。\n"
    + " * 窗口：近 52 周（与 hi/lo 同一次抓取）—— 早于窗口的笔查不到净值，页面会显示「—」并不计入合计。 */\n";
  return { text: head + "const OTC_BUYNAV = {\n" + body + "\n};\n", n };
}
const bn = buyNavBlock(buyNavAll);
const RE_BN = /\/\* ---- OTC_BUYNAV[\s\S]*?\nconst OTC_BUYNAV = \{[\s\S]*?\n\};\n/;
console.log("\n逐笔申购日净值：共解析 " + bn.n + " 笔" + (bn.n ? "" : "（抓取失败？）"));
if (WRITE) {
  const before = src;
  if (RE_BN.test(src)) src = src.replace(RE_BN, bn.text);
  else {
    const anchor = /(const OTC_LOG = \{[\s\S]*?\n\};\n)/;   // 没有就插到 OTC_LOG 之后
    if (anchor.test(src)) src = src.replace(anchor, "$1\n" + bn.text);
    else console.log("⚠ 未定位到 OTC_LOG 块，OTC_BUYNAV 未写入");
  }
  if (src !== before) { writeFileSync(FILE, src); console.log("已写回 OTC_BUYNAV（" + bn.n + " 笔）"); }
  else console.log("OTC_BUYNAV 无变化");
}
