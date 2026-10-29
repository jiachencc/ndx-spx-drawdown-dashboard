import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

export const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
/* 持仓页的**共享口径**（positions-logic.js 的 POS_LOGIC，2026-10-16 加）：
   页面用 <script src> 直接调它，Node 侧用这里读**同一份源码** —— 同一条判据不再各写一份 ✓。
   为什么放 data-quality：它是被 8 个脚本 import 的核心库，「页面与脚本读同一份」属于它的职责范围 ✓。
   参数 root 接受 URL（`new URL("../", import.meta.url)`）或目录路径（path.resolve(...)）——两种入口都有先例 ✓。 */
export function readPosLogic(root) {
  const base = root instanceof URL ? root : pathToFileURL(String(root).replace(/[/\\]+$/, "") + "/");
  const src = readFileSync(new URL("positions-logic.js", base), "utf8");
  const m = src.match(/^const POS_LOGIC = \{[\s\S]*?^\};/m);
  if (!m) throw new Error("positions-logic.js 里找不到行首的 POS_LOGIC 块（拆分/改名的同时请更新 lint.mjs 的拼接与 readPosLogic）");
  const ctx = vm.createContext({});
  vm.runInContext(m[0] + "\nthis.logic = POS_LOGIC;", ctx, { timeout: 500 });
  return ctx.logic;
}
export function readModel(src) {
  const ctx = vm.createContext({});
  /* 白名单：只有列在这里的块会被校验（也才受 CI 的 schema 门约束）。
     ALT_BACKTEST 是派生块（scripts/alt-etf-backtest.mjs 写），其契约见 validateModel 尾部。 */
  vm.runInContext(src + "\nthis.model = { DEFAULT, MONTHLY, RECENT, POSITIONS, DCA_META, DCA_NDX, DCA_SPX, SOURCE_META, ALT_BACKTEST, FEES, HOLD_HIST, PREM_LOG, DDHIST, PREM_SCAN };", ctx, { timeout: 1500 });
  return JSON.parse(JSON.stringify(ctx.model));
}
export function compileHtml(html, file = "page") {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].filter(m => m[1].trim());
  scripts.forEach((m, i) => new vm.Script(m[1], { filename: file + ":inline:" + i }));
}
export function snapshotIssues(html) {
  const m = html.match(/^const SNAPSHOTS = \[[\s\S]*?^\];/m);
  if (!m) throw new Error("SNAPSHOTS declaration missing");
  const ctx = vm.createContext({});
  vm.runInContext(m[0] + "\nthis.rows = SNAPSHOTS;", ctx, { timeout: 500 });
  const issues = [];
  let prev = "";
  for (const s of ctx.rows) {
    if (!isDate(s.d) || s.d <= prev) issues.push(s.d + ": snapshot dates must be unique/ascending");
    prev = s.d;
    if (!s.items) {
      if (![s.total, s.pl].every(Number.isFinite)) issues.push(s.d + ": non-finite total/pl");
      continue;
    }
    let sum = 0;
    for (const [code, it] of Object.entries(s.items)) {
      const residual = it.val - it.cost - it.pl;
      if (![it.val, it.cost, it.pl].every(Number.isFinite) || Math.abs(residual) > 1)
        issues.push(s.d + ":" + code + ": val-cost-pl residual=" + residual.toFixed(2));
      sum += it.pl;
    }
    if (Number.isFinite(s.pl) && Math.abs(sum - s.pl) > 2) issues.push(s.d + ": item P&L sum mismatch");
  }
  /* OTC 块（场外持仓 + 现金）必须与最新一期快照同步 —— 它才是汇总卡的数字来源，
     而快照里的现金/市值只是留档。2026-09-22 曾把 OTC.cash 留成上一期的 13,458.10：
     总资产少算 6,866、配置图现金占比偏小，但盈亏因现金两边抵消完全正常，肉眼查不出来。
     两侧都在才校验：测试里的最小 fixture 缺 OTC 块或现金字段是正常的，不该记成问题。 */
  const om = html.match(/^const OTC = \{[\s\S]*?^\};/m);
  const last = ctx.rows.filter((s) => Number.isFinite(s.cash)).at(-1);
  if (om && last) {
    const oc = vm.createContext({});
    vm.runInContext(om[0] + "\nthis.otc = OTC;", oc, { timeout: 500 });
    if (!Number.isFinite(oc.otc.cash) || Math.abs(oc.otc.cash - last.cash) > 0.01)
      issues.push("OTC.cash " + oc.otc.cash + " ≠ 最新快照（" + last.d + "）现金 " + last.cash + "：汇总卡总资产与配置图会算错");
    if (isDate(oc.otc.updated) && oc.otc.updated < last.d)
      issues.push("OTC.updated " + oc.otc.updated + " 早于最新快照 " + last.d + "：场外读数疑似未刷新");
  }
  return issues;
}
export function validateModel(m) {
  const d = m.DEFAULT, errors = [];
  const finite = (v, label) => { if (!Number.isFinite(v)) errors.push(label + " is not finite"); };
  if (!d || !isDate(d.date) || !isDate(d.asOf?.us) || d.date !== d.asOf.us) errors.push("invalid core date/asOf");
  for (const key of ["ndx", "spx"]) {
    const q = d?.[key] || {};
    for (const p of ["close", "ath", "ma50", "ma200", "low52", "prevYr", "rsi", "chg", "days", "ddYtd"]) finite(q[p], key + "." + p);
    if (!(q.close > 0 && q.ath >= q.close && q.low52 > 0 && q.low52 <= q.close && q.ma50 > 0 && q.ma200 > 0 && q.prevYr > 0)) errors.push(key + ": invalid price range");
    if (q.rsi < 0 || q.rsi > 100 || q.days < 0 || q.ddYtd > 0 || !isDate(q.athDate)) errors.push(key + ": invalid indicators");
  }
  for (const key of ["vix", "tnx", "tnx2", "fx", "putcall", "peFwd", "peTtm", "pePct", "ndxPeFwd", "ndxPePct", "cape", "epsGrowth"]) finite(d?.[key], key);
  for (const key of ["vix", "fx", "putcall", "peFwd", "peTtm", "ndxPeFwd", "cape"]) if (!(d[key] > 0)) errors.push(key + ": must be positive");
  for (const key of ["pePct", "ndxPePct"]) if (!(d[key] >= 0 && d[key] <= 100)) errors.push(key + ": outside 0..100");
  const th = Object.values(d?.thresholds || {});
  if (th.length !== 4 || !th.every((x, i) => Number.isFinite(x) && x < 0 && x > -100 && (!i || x < th[i - 1]))) errors.push("threshold ordering invalid");
  for (const key of ["etfNdx", "etfSpx", "kr", "n225", "hkus"]) {
    const q = d[key];
    if (!q || ![q.close, q.chg, q.low52, q.ath].every(Number.isFinite) || !(q.low52 > 0 && q.ath >= q.close && q.close >= q.low52)) errors.push(key + ": invalid ETF quote");
  }
  const codes = new Set();
  for (const p of m.POSITIONS?.hold || []) {
    if (codes.has(p.code) || !/^\d{6}$/.test(p.code) || !Number.isInteger(p.qty) || p.qty < 0 || !(p.cost > 0) || p.cost !== p.idxAtCost) {
      /* 2026-10-20：这条曾卡了 3 轮 —— 报错只写「invalid position」，完全看不出是 qty 非整数、
         cost ≤ 0，还是 cost ≠ idxAtCost（后者最常见：摊薄成本单价必须两处相等） */
      const why = codes.has(p.code) ? "code 重复"
        : !/^\d{6}$/.test(p.code) ? "code 不是 6 位数字"
        : !Number.isInteger(p.qty) ? "qty 必须是整数（当前 " + p.qty + "）"
        : p.qty < 0 ? "qty 为负"
        : !(p.cost > 0) ? "cost 必须 > 0（当前 " + p.cost + "）"
        : "cost ≠ idxAtCost（" + p.cost + " vs " + p.idxAtCost + "）→ 摊薄成本单价这两处必须写成同一个值";
      errors.push("invalid position " + p.code + "：" + why);
    }
    codes.add(p.code);
    const net = m.POSITIONS.log.filter(e => e.sym === p.sym).reduce((n, e) => n + (/卖出|减仓|清仓/.test(e.act) ? -e.qty : e.qty), 0);
    if (net !== p.qty) errors.push("quantity reconciliation " + p.code);
  }
  /* 代码 → DEFAULT 报价字段（供 premiums 的算式校验用）：从 POSITIONS.hold 的 `idx` 推 ——
     与 positions.html 的 `QUOTE_KEY` 是同一张映射 ✓，不在这里再抄第三份 ✗。
     ⚠ 已清仓的 160644 / 513310 不在 hold 里 → 那两条只校验形状、不校验算式（覆盖 5 条里的 3 条 ✓）。 */
  const ALIAS_OF = {};
  for (const p of m.POSITIONS?.hold || []) {
    if (p.idx) ALIAS_OF[p.code] = (p.idx === "ndx" ? "etfNdx" : p.idx === "spx" ? "etfSpx" : p.idx);
  }
  for (const [code, p] of Object.entries(m.POSITIONS?.premiums || {})) {
    if (!Number.isFinite(p.pct) || !Number.isFinite(p.nav) || p.nav <= 0 || !isDate(p.navDate)) errors.push("premium invalid " + code);
    /* ⚠ 2026-10-16 补三条（此前只校验形状，**算式与日期关系一条都没查** ✗）：
       ① priceDate 必须合法；② **净值日不能晚于价格日** —— 取数脚本本来就挡了这一条
          （fetch_and_update：「nav.FSRQ > quote.priceDate 直接算失败」✓），但手工改一次就可能写反，
          而写反以后 pct 看着仍是个正常数，页面上完全看不出来 ✗；
       ③ 两边**价格日相同**时才校验算式 `pct ≈ 收盘价 ÷ 净值 − 1`（口径见 fetch_and_update.mjs §premiums）——
          滞后时 DEFAULT 的 close 已是新一天的价，拿它除旧净值必然对不上 ✗，那不是错、是「还没跑到」，
          由 autoBlockIssues 的「premiums 价格日落后 > 2 天」那条管「能滞后多久」✓。 */
    if (!isDate(p.priceDate)) errors.push("premium priceDate invalid " + code);
    else if (p.navDate > p.priceDate) errors.push("premium navDate 晚于 priceDate " + code + "（两个日期写反了？）");
    const alias = ALIAS_OF[code], q = alias ? (m.DEFAULT || {})[alias] : null;
    if (q && isDate(q.priceDate)) {
      if (p.priceDate > q.priceDate) errors.push("premium priceDate 晚于该 ETF 的报价日 " + code + "（" + p.priceDate + " > " + q.priceDate + "）");
      else if (p.priceDate === q.priceDate && Number.isFinite(q.close)) {
        const want = Math.round((q.close / p.nav - 1) * 100 * 10) / 10;
        /* 容差 0.15 → 0.5（2026-10-20）：pct 与 nav 都由 CI 分别写入、各自四舍五入到 1 位，
           差 0.2pp 是正常现象；0.15 会在每次自动更新后误报一次（当天实测 513650 存 7 / 算式 6.8）。 */
        if (Math.abs(p.pct - want) > 0.5)
          errors.push("premium pct 与「收盘价 ÷ 净值 − 1」不符 " + code + "（存 " + p.pct + "%，算式给 " + want + "%）"
            + " → 修法：premiums[" + code + "].pct 改成 " + want + "，或把 nav 换到与该 pct 匹配的那一期（容差 ±0.5pp）");
      }
    }
  }
  /* 卖出行必须带 realized（券商逐笔「实现盈亏」）：持仓卡的「其中已落袋」与「本金与收益」卡的
     「已实现」都靠它求和 —— 缺失会被当成 0 静默少算（页面不报错、数字悄悄变小，看不出来）。
     2026-09-23 加：当天给持仓卡加了「其中已落袋」这一格，它的数据源就是这条。 */
  for (const e of m.POSITIONS?.log || []) {
    if (/卖出|减仓|清仓/.test(String(e.act || "")) && !Number.isFinite(e.realized))
      errors.push("sell log entry missing realized: " + (e.d || "?") + " " + (e.sym || "?"));
  }
  if (!isDate(m.DCA_META?.start) || !isDate(m.DCA_META?.end) || m.DCA_META.start >= m.DCA_META.end) errors.push("DCA metadata invalid");
  for (const key of ["DCA_NDX", "DCA_SPX"]) if (!Array.isArray(m[key]) || m[key].length < 2 || !m[key].every(x => Number.isFinite(x) && x > 0)) errors.push(key + " invalid");
  if (m.DCA_NDX?.length !== m.DCA_SPX?.length) errors.push("DCA lengths differ");
  if (!m.MONTHLY?.length || m.MONTHLY.length > 12 || !m.MONTHLY.every((r, i) => r.m === (i + 1) + "月" && [r.ndx, r.spx].every(x => Number.isFinite(x) && x > -100))) errors.push("monthly invalid");
  /* 标的替换回测（派生块，由 scripts/alt-etf-backtest.mjs 写）：页面取 rows[0] 作「最好」、末行作「最差」，
     所以「按期末市值降序 + 基准行存在 + mine 标记与 mine 代码一致」是数据契约。
     块缺失或 groups 为空 = 还没跑过脚本（允许，页面显示提示）；一旦有数据就必须自洽。 */
  const bt = m.ALT_BACKTEST;
  if (bt && (bt.groups || []).length) {
    if (!isDate(bt.asOf) || typeof bt.source !== "string" || !Array.isArray(bt.groups)) errors.push("ALT_BACKTEST: invalid header");
    for (const g of bt.groups) {
      const rs = g.rows || [];
      if (!rs.length || !rs.some((r) => r.mine)) errors.push("ALT_BACKTEST " + g.label + ": missing base row");
      if (rs.some((r) => ![r.final, r.diffPp, r.rate].every(Number.isFinite))) errors.push("ALT_BACKTEST " + g.label + ": non-finite row");
      if (rs.some((r, i) => i && rs[i - 1].final < r.final)) errors.push("ALT_BACKTEST " + g.label + ": rows not sorted by final desc");
      if (rs.some((r) => r.mine !== (r.code === g.mine))) errors.push("ALT_BACKTEST " + g.label + ": mine flag mismatch");
    }
    /* 反向表：rows = 「假设买这只场内」，base = 同一套流水走场外净值（基准）。允许为空（没有可映射的场外）。 */
    const rev = bt.reverse;
    if (rev && (rev.funds || []).length) {
      if (!isDate(rev.start)) errors.push("ALT_BACKTEST reverse: invalid assumed start date");
      for (const f of rev.funds) {
        if (!Number.isFinite(f.cost) || !Number.isFinite(f.base) || !Number.isFinite(f.baseRet)) errors.push("ALT_BACKTEST reverse " + f.code + ": non-finite base");
        /* 新列按「缺失＝旧格式」容忍：写前审计读的是磁盘上的上一版，收紧 schema 不能要求它先合规
           （否则先有鸡还是先有蛋）。字段一旦存在就必须是有限数——null / NaN 照样拦。 */
        if ((f.mineFinal !== undefined || f.mineDiff !== undefined || f.mineDiffPp !== undefined) &&
          ![f.mineFinal, f.mineDiff, f.mineDiffPp].every(Number.isFinite)) {
          errors.push("ALT_BACKTEST reverse " + f.code + ": non-finite mine column");
        }
        if (!(f.rows || []).length) errors.push("ALT_BACKTEST reverse " + f.code + ": no candidate rows");
        if ((f.rows || []).some((r) => !Number.isFinite(r.final) || !Number.isFinite(r.diffPp))) errors.push("ALT_BACKTEST reverse " + f.code + ": non-finite row");
      }
      if (rev.total && !Number.isFinite(rev.total.diff)) errors.push("ALT_BACKTEST reverse: non-finite total");
    }
  }
  /* 费率表（AUTO，scripts/fetch-fees.mjs 写）：空块 = 还没抓过（允许）；有数据就必须自洽。
     peers 指向的替代产品必须也在 items 里，否则页面会显示一个查不到费率的「更便宜替代」。 */
  const fees = m.FEES;
  if (fees && fees.items && Object.keys(fees.items).length) {
    if (!isDate(fees.asOf) || typeof fees.source !== "string") errors.push("FEES: invalid header");
    for (const [code, f] of Object.entries(fees.items)) {
      if (!/^\d{6}$/.test(code)) errors.push("FEES " + code + ": bad code");
      if (![f.manage, f.trust].every(Number.isFinite) || !Number.isFinite(f.total)) errors.push("FEES " + code + ": non-finite rate");
      else if (!(f.total > 0) || f.total > 3) errors.push("FEES " + code + ": implausible total " + f.total);
    }
    for (const [code, peer] of Object.entries(fees.peers || {})) {
      if (peer !== null && !fees.items[peer]) errors.push("FEES peers " + code + ": peer " + peer + " missing in items");
    }
  }
  for (const [k, meta] of Object.entries(m.SOURCE_META || {})) {
    /* "manual" ＝ 人工维护项（2026-10-12 加）：源码里手填、没有自动抓取，所以既没有 fetchedAt、
       也允许 asOf 为 null（＝「未记录核验日」）。此前白名单只有 ok / retained / unverified ✗，
       于是给 DEFAULT.epsGrowth 补一条 provenance 会被判 invalid ✗ —— 见 sourceHealth 的 manual 分支。 */
    if (!["ok", "retained", "unverified", "manual"].includes(meta.status) || (meta.asOf !== null && !isDate(meta.asOf)) || typeof meta.source !== "string") errors.push("invalid provenance " + k);
  }
  /* ⚠️ 2026-10-16 删：原「NOWCAST 合约」（场外当日收益预估的输入，scripts/fetch-nowcast.mjs 写）——
     页面上的「场外当日预估」模块已整体下线，数据侧 `NOWCAST` / `NOWCAST_LOG` 两块与其唯一写者
     `scripts/fetch-nowcast.mjs` 也一并移除 ✓，故这里不再有可校验的对象。
     历史：该合约曾抓过「r ≥ 0.95 时 β 必须落在 0.8~1.2」与「tier 与 mae/r 自洽」，
     是当时唯一能自动抓到**数据侧**拟合错的断言（页面侧复算读同一份数据，改 β 抓不到 ✓）。 */
  /* PREM_LOG 的 asOf 语义（2026-10-24 加）：必须 ＝ **已算出溢价的最大日期**。
     起因：原来 asOf 取「流水里最新的成交日」，净值没公布时它会写「截至 10-23」，而 10-23 那几笔
     其实被跳过了 ✗ —— 日志与数据块都显示「覆盖到」，人一看就以为齐了。
     现在多存 tradeAsOf（流水最新成交日），两者不等 ＝ 还有交易日在等净值 ✓（不是错误，是事实）。 */
  const plg = m.PREM_LOG;
  if (plg && plg.items) {
    const ds = Object.values(plg.items).flatMap((o) => Object.keys(o || {})).sort();
    const maxD = ds.at(-1) || null;
    if (plg.asOf !== maxD) errors.push("PREM_LOG.asOf（" + plg.asOf + "）≠ 已算出的最大日期（" + maxD + "）");
    if (plg.tradeAsOf && maxD && String(plg.tradeAsOf) < String(maxD)) errors.push("PREM_LOG.tradeAsOf 早于已算出日期");
    const badPct = ds.filter((dt) => Object.values(plg.items).some((o) => o[dt] !== undefined && !(Number.isFinite(o[dt]) && Math.abs(o[dt]) < 200)));
    if (badPct.length) errors.push("PREM_LOG: 异常溢价 " + badPct.slice(0, 3).join(","));
  }
  /* ⚠ 覆盖完整性（2026-10-29 加，因为这条**已经连踩三次**）：
     合并 CI 的 data.js 时，`-X theirs` 会把「清仓已久、近期无新成交」那只的整块**静默删掉**
     （10-24 丢了日经、10-28/10-29 又丢了一次中韩/日经），不冲突、不报错，页面照常渲染 ✗。
     判据：流水里出现过的每个标的，PREM_LOG 都必须有同名条目 —— 少的那只就是被吞了。
     ⚠ 不校验笔数：净值没公布时跳过某几笔**是合法的**（见 fetch-trade-premium 的守卫）✓ */
  if (plg && plg.items && m.POSITIONS && Array.isArray(m.POSITIONS.log)) {
    const syms = [...new Set(m.POSITIONS.log.map((e) => e.sym).filter(Boolean))];
    const missing = syms.filter((s) => !(s in plg.items));
    if (missing.length) errors.push("PREM_LOG 缺标的（多半是合并时被静默删掉）：" + missing.join("、"));
  }
  /* DDHIST（回撤历史对照，2026-10-24 加）：事件与分布必须自洽 ——
     事件是「峰→谷」的日期对 + 负跌幅；分布是单调的（≥5% 的段数 ≥ ≥10% ≥ ≥15% ≥ ≥20%）；
     条件统计里「最终跌破 −10% 的段数」不可能超过总段数 ✓。
     这类块最容易在改口径时算错一格而页面照样渲染（回撤数字没人能心算复核）。 */
  const dh = m.DDHIST;
  if (dh && Array.isArray(dh.events)) {
    if (!isDate(dh.asOf)) errors.push("DDHIST.asOf 不是日期");
    (dh.events || []).forEach((e, i) => {
      const tag = "DDHIST.events[" + i + "](" + (e.label || "?") + ")";
      if (!isDate(e.peak) || !isDate(e.trough)) errors.push(tag + ": 峰/谷日期非法");
      if (e.peak >= e.trough) errors.push(tag + ": 峰必须早于谷");
      if (!(e.dd < 0 && e.dd > -100)) errors.push(tag + ": dd 越界");
      if (!(Number.isInteger(e.days) && e.days >= 0)) errors.push(tag + ": days 非整数");
      if (!(e.rank >= 1 && e.rank <= e.rankOf)) errors.push(tag + ": rank 越界");
      if (e.recover && !isDate(e.recover)) errors.push(tag + ": recover 非法");
    });
    const d = dh.dist || {};
    if (!(d.n5 >= d.n10 && d.n10 >= d.n15 && d.n15 >= d.n20 && d.n20 >= 0)) errors.push("DDHIST.dist: 不单调");
    const c = dh.cond || {};
    if (!(c.n > 0 && c.deep >= 0 && c.deep <= c.n)) errors.push("DDHIST.cond: 段数不自洽");
    if (!(c.thr < 0)) errors.push("DDHIST.cond.thr 必须为负");
    /* median（index.html 那条中位数游标）：必须是负的、样本不少于 10 段，
       且落在它自己的阈值与 −25% 之间 —— 越过界说明阈值取错或算错（历史上就是写死 −7.5 没人能复核 ✗） */
    const md = dh.median;
    if (!md || typeof md !== "object") errors.push("DDHIST.median 缺失");
    else {
      if (!(md.thr < 0)) errors.push("DDHIST.median.thr 必须为负");
      if (!(md.n >= 10)) errors.push("DDHIST.median.n 过小：" + md.n);
      if (!(md.med <= md.thr && md.med > -25)) errors.push("DDHIST.median.med 越界：" + md.med);
    }
  }
  /* PREM_SCAN（纳指类 ETF 溢价扫描，2026-10-28 加）：形状 ＋ 自洽
     —— 这块最容易「某只净值没对齐 → 溢价虚高 3pp 而页面照样渲染」✗（开发当天就踩过一次），
     所以要求：每只 cur 落在自己的 min~max 内、分位 0~100、六个代码齐全。 */
  const ps = m.PREM_SCAN;
  if (ps && Array.isArray(ps.items) && ps.items.length) {
    if (!isDate(ps.asOf)) errors.push("PREM_SCAN.asOf 不是日期");
    const codes = new Set(ps.items.map((x) => String(x.code)));
    ["159941", "513100", "159632", "513110"].forEach((c) => { if (!codes.has(c)) errors.push("PREM_SCAN 缺 " + c); });
    ps.items.forEach((x) => {
      const t = "PREM_SCAN[" + x.code + "]";
      if (!(Number.isFinite(x.cur) && Number.isFinite(x.min) && Number.isFinite(x.max))) { errors.push(t + ": cur/min/max 非数"); return; }
      if (!(x.cur >= x.min - 0.01 && x.cur <= x.max + 0.01)) errors.push(t + ": cur 不在 min~max 内（" + x.cur + " vs " + x.min + "~" + x.max + "）");
      ["q3", "q1", "qA"].forEach((k) => {
        if (!(Number.isInteger(x[k]) && x[k] >= 0 && x[k] <= 100)) errors.push(t + ": " + k + " 分位越界 " + x[k]);
      });
      if (!(x.med >= x.min - 0.01 && x.med <= x.max + 0.01)) errors.push(t + ": med 不在 min~max 内");
      if (!(x.days >= 30)) errors.push(t + ": 样本过短 " + x.days);
    });
  }
  return errors;
}
export function metrics(raw) {
  // Filter whole rows, never filter close separately from dates/highs.
  const rows = raw.dates.map((date, i) => ({ date, close: raw.close[i], high: raw.high[i], low: raw.low[i] }))
    .filter(r => isDate(r.date) && [r.close, r.high, r.low].every(Number.isFinite));
  if (rows.length < 260) throw new Error("insufficient valid bars");
  if (rows.some((r, i) => r.close <= 0 || r.high < r.close || r.low > r.close || r.low <= 0 || (i && r.date <= rows[i - 1].date))) throw new Error("invalid OHLC ordering/range");
  const last = rows.at(-1), prev = rows.at(-2), year = last.date.slice(0, 4);
  const prevYr = rows.filter(r => r.date.slice(0, 4) < year).at(-1)?.close;
  if (!(prevYr > 0)) throw new Error("previous year close missing");
  const hi = rows.reduce((a, r, i) => r.high > rows[a].high ? i : a, 0);
  const avg = n => rows.slice(-n).reduce((s, r) => s + r.close, 0) / n;
  let gain = 0, loss = 0;
  for (let i = rows.length - 14; i < rows.length; i++) { const c = rows[i].close - rows[i - 1].close; gain += Math.max(0, c); loss += Math.max(0, -c); }
  let peak = prevYr, ddYtd = 0;
  rows.filter(r => r.date.startsWith(year)).forEach(r => { peak = Math.max(peak, r.close); ddYtd = Math.min(ddYtd, (r.close / peak - 1) * 100); });
  const round = (x, n = 2) => +x.toFixed(n);
  return { close: round(last.close), ath: round(rows[hi].high), athDate: rows[hi].date, days: rows.length - 1 - hi, chg: round((last.close / prev.close - 1) * 100), ma50: round(avg(50)), ma200: round(avg(200)), rsi: round(gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss), 1), low52: round(Math.min(...rows.slice(-252).map(r => r.low))), high52: round(Math.max(...rows.slice(-252).map(r => r.high))), prevYr, ddYtd: round(ddYtd, 1), date: last.date, rows };
}
export function monthly(rows) {
  const year = rows.at(-1).date.slice(0, 4);
  let prev = rows.filter(r => r.date.slice(0, 4) < year).at(-1)?.close;
  const map = new Map();
  rows.filter(r => r.date.startsWith(year)).forEach(r => map.set(+r.date.slice(5, 7), r.close));
  const out = [];
  for (let i = 1; i <= 12; i++) { if (!map.has(i)) break; out.push((map.get(i) / prev - 1) * 100); prev = map.get(i); }
  return out;
}
export function createRecorder(oldMeta, now = new Date()) {
  const meta = structuredClone(oldMeta || {}), fetchedAt = now.toISOString();
  function success(key, asOf, source, extra = {}) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
    if (!isDate(asOf) || asOf > today) throw new Error(key + ": missing/invalid source date");
    if (meta[key]?.asOf && asOf < meta[key].asOf) throw new Error(key + ": source date regressed");
    meta[key] = { asOf, source, fetchedAt, status: "ok", ...extra };
  }
  function failure(key, source, reason) {
    meta[key] = { asOf: null, source, ...meta[key], status: "retained", attemptedAt: fetchedAt, error: String(reason).slice(0, 200) };
  }
  return { meta, success, failure };
}
export function stableBusiness(meta) {
  return Object.fromEntries(Object.entries(meta).map(([k, m]) => { const { fetchedAt, attemptedAt, error, ...business } = m; return [k, business]; }));
}
/* Inline rendering that keeps data.js hand-written: unquoted identifier keys,
 * entries on their original lines. Values are re-emitted from the model, so a
 * trailing zero may be dropped (4.730 -> 4.73); never compare textual forms. */
const IDENT = /^[A-Za-z_$][\w$]*$/;
function inlineLiteral(v) {
  if (v === null || typeof v === "boolean") return String(v);
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("non-finite value in data"); return String(v); }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(inlineLiteral).join(", ") + "]";
  return "{ " + Object.entries(v).map(([k, x]) => (IDENT.test(k) ? k : JSON.stringify(k)) + ": " + inlineLiteral(x)).join(", ") + " }";
}
/* Rewrite `const NAME = { ... };` value-by-value so the block keeps its layout
 * and its AUTO/MANUAL comments across every automated update. Several pairs may
 * share one line, so values are located by scanning rather than per line. The
 * round-trip check refuses anything this writer cannot reproduce exactly. */
const canonical = v => (Array.isArray(v) ? v.map(canonical)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v);
export function replaceConst(src, name, value) {
  const anchor = new RegExp("^const " + name + " = \\{[\\s\\S]*?^\\};", "m");
  const block = src.match(anchor);
  if (!block) throw new Error("missing object anchor " + name);
  const text = block[0];
  let body = text.slice(text.indexOf("{") + 1, text.lastIndexOf("};")).replace(/\n[ \t]*$/, "");
  const seen = new Set();
  // A key starts a line or follows a comma; its value is a flat {...} or runs up to the next comma.
  body = body.replace(/(^[ \t]*|[,{][ \t]*)([A-Za-z_$][\w$]*)([ \t]*:[ \t]*)(\{[^}]*\}|[^,\n]+)/gm, (all, lead, key, sep) => {
    if (!Object.hasOwn(value, key)) return all;
    seen.add(key);
    return lead + key + sep + inlineLiteral(value[key]);
  });
  const missing = Object.entries(value).filter(([k]) => !seen.has(k));
  if (missing.length) {
    if (!/,[ \t]*$/.test(body)) body += ",";
    body += "\n" + missing.map(([k, v]) => "  " + (IDENT.test(k) ? k : JSON.stringify(k)) + ": " + inlineLiteral(v) + ",").join("\n");
  }
  const rebuilt = "const " + name + " = {" + body + "\n};";
  const ctx = vm.createContext({});
  vm.runInContext(rebuilt + "\nthis.out = " + name + ";", ctx, { timeout: 1500 });
  if (JSON.stringify(canonical(ctx.out)) !== JSON.stringify(canonical(value))) throw new Error(name + ": rewritten block does not round-trip");
  return src.replace(anchor, () => rebuilt);
}
/* Rewrite a `name: { ... },` member of a larger literal. Keeps the comment that
 * trails the opening brace; entries are re-emitted one per line. */
export function replaceMember(src, name, value, indent = "  ") {
  const anchor = new RegExp("^" + indent + name + ": \\{([^\\n]*)\\n[\\s\\S]*?^" + indent + "\\},", "m");
  const found = src.match(anchor);
  if (!found) throw new Error("missing member anchor " + name);
  const body = Object.entries(value).map(([k, v]) => indent + "  " + JSON.stringify(k) + ": " + inlineLiteral(v) + ",").join("\n");
  return src.replace(anchor, () => indent + name + ": {" + found[1] + "\n" + body + "\n" + indent + "},");
}
export function atomicWrite(target, content) {
  const temp = target + ".pending-" + process.pid;
  try { writeFileSync(temp, content, { flag: "wx" }); renameSync(temp, target); }
  finally { try { unlinkSync(temp); } catch (e) { if (e.code !== "ENOENT") throw e; } }
}
/* ---- AUTO 块新鲜度（2026-09-30 加）--------------------------------------------------------
 * 为什么需要：FEES / ALT_BACKTEST / BENCH 三块由 CI 的分步脚本写，而那几步都是 `continue-on-error: true`
 * （设计上「失败不阻断日更」）。于是一旦某步静默坏掉，data.js 看着完整、既有 schema 与交叉校验全绿，
 * 只有页面上某个日期悄悄停住。2026-09-27 的重构把 OTC / SNAPSHOTS 从 positions.html 搬到 positions-data.js
 * （提交里写着「同步 9 个脚本」），但 fetch-fees 与 sync-bench 被漏掉 —— 就这样坏了 8 天没人发现：
 * 费率表停在 asOf 09-22、走势图的「同节奏纳指」基准停在 09-24、标的替换回测被我自己合并时盖回 09-24。
 * 这里给每块设「最老允许日期」，让终审把它变成红字，而不是等人肉眼发现。
 * 阈值刻意留松：容忍「今天的 run 还没跑到」与 FEES 自带的 7 天缓存节流，只抓「坏了一周以上」。
 * ⚠ BENCH 不在 readModel 的模型里（它是独立 const），故从源码文本取日期。 */
export function autoBlockIssues(model, dataSrc, posSrc) {
  const issues = [];
  const diff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
  const mkt = model?.DEFAULT?.etfNdx?.priceDate || model?.SOURCE_META?.etfNdx?.asOf || null;
  const benchTxt = (String(dataSrc || "").match(/^const BENCH = \{[\s\S]*?^\};/m) || [""])[0];
  const benchLast = [...benchTxt.matchAll(/(20\d\d-\d\d-\d\d)/g)].map((x) => x[1]).sort().at(-1) || null;
  const snapTxt = (String(posSrc || "").match(/^const SNAPSHOTS = \[[\s\S]*?^\];/m) || [""])[0];
  const snapLast = [...snapTxt.matchAll(/\bd:\s*"(20\d\d-\d\d-\d\d)"/g)].map((x) => x[1]).sort().at(-1) || null;
  /* 阈值按 2026-09-30 那次真事故校准：当时 ALT_BACKTEST 差 5 天、FEES 差 7 天、BENCH 差 5 天，
     三个数都必须拦得住（否则等于没加）。同时要容忍「今天这一步还没跑到」的 0~1 天正常滞后。 */
  if (mkt && model?.ALT_BACKTEST?.asOf && diff(mkt, model.ALT_BACKTEST.asOf) > 4)
    issues.push("AUTO 块陈旧：ALT_BACKTEST.asOf " + model.ALT_BACKTEST.asOf + " 落后场内行情日 " + mkt +
      " 超过 4 天 —— scripts/alt-etf-backtest.mjs 那步多半坏了（CI 里它是 continue-on-error，不会报红，只会让该板块的期末日期停住）");
  if (mkt && model?.FEES?.asOf && diff(mkt, model.FEES.asOf) > 6)
    issues.push("AUTO 块陈旧：FEES.asOf " + model.FEES.asOf + " 落后场内行情日 " + mkt +
      " 达 7 天以上 —— scripts/fetch-fees.mjs 那步多半坏了（该脚本自带 7 天缓存节流：满 7 天当天就该去抓，抓到了 asOf 会立刻归零；" +
      "所以「年龄 ≥ 7 天」只可能是「该抓没抓到」）");
  if (snapLast && benchLast && diff(snapLast, benchLast) > 3)
    issues.push("AUTO 块陈旧：BENCH 最新日期 " + benchLast + " 落后最新快照日 " + snapLast +
      " 超过 3 天 —— scripts/sync-bench.mjs 那步多半坏了（走势图的「同节奏纳指」虚线会停在旧日期）");
  /* premiums（场内溢价率，2026-10-16 加）：它是**唯一**没有陈旧断言的 AUTO 块 ✗
     （ALT_BACKTEST 4 天 / FEES 7 天 / BENCH 3 天都有 ✓），于是滞后了不会有任何提示 ——
     2026-10-16 正是靠读一句**过期注释**去判断它的状态、并连着复述了几次 ✗，所以要给它装牙。
     判据：premiums 的 **priceDate** 落后场内行情日（DEFAULT.etfNdx.priceDate）超过 2 天。
     阈值 2 天：净值晚 1~2 天是常态（那是 navDate 的事，形状校验里已保证 navDate ≤ priceDate ✓）；
     而**价格日**来自与 DEFAULT 同一批腾讯日K、由同一步写入 —— 落后 1 天＝「手工落了一期、那步还没跑」的正常态 ✓，
     落后 > 2 天则说明那步真没跑成（页面「溢价/折价」胶囊会比卡头那枚「场内 xx.xx」旧出好几天 ✗）。 */
  const premDates = Object.entries(model?.POSITIONS?.premiums || {})
    .map(([c, p]) => [c, p.priceDate]).filter(([, d]) => isDate(d));
  const premOld = mkt ? premDates.filter(([, d]) => diff(mkt, d) > 2) : [];
  if (premOld.length)
    issues.push("AUTO 块陈旧：premiums 里 " + premOld.map(([c, d]) => c + " " + d).join("、") +
      " 的**价格日**落后场内行情日 " + mkt + " 超过 2 天 —— scripts/fetch_and_update.mjs 的溢价那步多半没跑成" +
      "（页面「溢价/折价」胶囊会明显旧于卡头的场内日期）");
  return issues;
}

export function auditFiles(root) {
  const data = readFileSync(new URL("data.js", root), "utf8");
  const pos = readFileSync(new URL("positions.html", root), "utf8");
  /* ⚠ 持仓页的 MANUAL 数据（SNAPSHOTS / OTC / OTC_LOG）2026-09-27 移到了 positions-data.js。
     快照校验必须读**那个**文件 —— 否则 snapshotIssues 找不到 `const SNAPSHOTS = [` 会抛错或
     静默放过，门禁看着绿、其实没检。 */
  const posData = readFileSync(new URL("positions-data.js", root), "utf8");
  compileHtml(pos, "positions.html");
  compileHtml(readFileSync(new URL("index.html", root), "utf8"), "index.html");
  /* ⚠ positions-data.js 是**纯 JS**、没有 <script> 标签 —— compileHtml 对这种文件抽不到内容会静默跳过，
     所以直接交给 vm.Script 做语法检查。 */
  new vm.Script(posData, { filename: "positions-data.js" });
  return [...validateModel(readModel(data)), ...snapshotIssues(posData)];
}
