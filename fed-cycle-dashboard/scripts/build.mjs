/* 由日线序列算出每个加息周期的统计 → data/cycles.js（供静态页直接 <script> 引用）
 *
 * 口径（页面会原样标注，避免"看起来是同一个数其实不是"）：
 *   基准日 = 首次加息日的【前一个交易日】收盘 —— 相当于"加息前最后一天建仓"
 *   加息段 = 基准日 → 末次加息日（进行中的周期取最新交易日）
 *   加息段涨跌 = 末次加息日收盘 / 基准日收盘 − 1
 *   最大回撤   = 区间内日线收盘的最大回撤（含基准日）
 *   见顶       = 区间内最高收盘，并给出它距首次加息过了几个交易日
 *   回本       = 从最深回撤低点起，需要几个交易日才重新站上基准价（未回本记 null）
 *   加息后 3/6/12 个月 = 末次加息日收盘 → 之后 N 个自然月的最近交易日收盘
 */
import fs from 'node:fs';

const S = JSON.parse(fs.readFileSync('data/series.json', 'utf8'));
const CYCLES = [
  { id: '1994', name: '1994 预防式加息', first: '1994-02-04', last: '1995-02-01', hikes: 7,  rate: '3.00% → 6.00%', why: '通胀预期抬头，12 个月连加 7 次，被称"债券大屠杀"', tag: '软着陆' },
  { id: '1999', name: '1999 泡沫前收紧', first: '1999-06-30', last: '2000-05-16', hikes: 6,  rate: '4.75% → 6.50%', why: '经济过热 + 科网狂潮，末次加息后 10 个月泡沫见顶破裂', tag: '泡沫顶' },
  { id: '2004', name: '2004 渐进式加息', first: '2004-06-30', last: '2006-06-29', hikes: 17, rate: '1.00% → 5.25%', why: '每次 25bp 的"可预测"加息，历时 2 年，共 17 次', tag: '慢加息' },
  { id: '2015', name: '2015 正常化', first: '2015-12-16', last: '2018-12-19', hikes: 9,  rate: '0.25% → 2.50%', why: '零利率退出，3 年 9 次，末次加息引发 2018 年末急跌', tag: '慢牛' },
  { id: '2022', name: '2022 抗通胀急加', first: '2022-03-16', last: '2023-07-26', hikes: 11, rate: '0.25% → 5.50%', why: '40 年最陡，含 4 次 75bp；末次加息后指数创历史新高', tag: '急加息' },
  { id: '2026', name: '2026 重启加息', first: '2026-09-16', last: null, hikes: 1, rate: '3.75% → 4.00%', why: '2023-07 以来首次加息，进行中', tag: '进行中', ongoing: true },
];
const KEY = [['spx', '标普500'], ['ndx', '纳指100'], ['sox', '费城半导体']];

const seriesOf = (k) => S[k];
const lastAt = (arr, d) => { let r = null; for (const p of arr) { if (p.d <= d) r = p; else break; } return r; };
const prevAt = (arr, d) => { let r = null; for (const p of arr) { if (p.d < d) r = p; else break; } return r; };
const addMonths = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCMonth(t.getUTCMonth() + n); return t.toISOString().slice(0, 10); };
const r1 = (v) => (v === null || v === undefined || !isFinite(v) ? null : Math.round(v * 100) / 100);

/* ── 定投（DCA）计算 ──
 * 从首次加息日起，每月【首个交易日】投入固定金额。投入金额放大缩小不影响收益率，故用 1 单位。
 * 关键点：定投的"收益率＝期末市值/累计投入−1"会被时间摊薄，和一次性买入不可比 ✗
 *         所以两者都比【XIRR】（资金加权年化），这才是"哪个更划算"的同口径答案。
 * 另给"相对累计投入的最大浮亏"——这是持有定投账户时真实的心理压力指标。 */
const U = 1000;
function xirr(cfs) {
  const t0 = Math.min.apply(null, cfs.map((c) => Date.parse(c.d)));
  if (cfs.length < 2) return null;
  const f = (r) => cfs.reduce((a, c) => a + c.v / Math.pow(1 + r, (Date.parse(c.d) - t0) / 31536000000), 0);
  let lo = -0.9999, hi = 10;
  if (f(lo) * f(hi) > 0) return null;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (f(lo) * f(m) <= 0) hi = m; else lo = m; }
  return (lo + hi) / 2;
}
function dcaRun(A, from, to) {
  const inWin = A.filter((p) => p.d >= from && p.d <= to);
  if (inWin.length < 2) return null;
  const cfs = []; let units = 0, invested = 0, months = 0, lastYm = '', worst = 0, worstAt = null, worstAmt = 0;
  inWin.forEach((p) => {
    const ym = p.d.slice(0, 7);
    if (ym !== lastYm) { lastYm = ym; units += U / p.c; invested += U; months++; cfs.push({ d: p.d, v: -U }); }
    const nav = units * p.c - invested;                    // 浮动盈亏
    const rel = invested ? nav / invested : 0;
    if (rel < worst) { worst = rel; worstAt = p.d; worstAmt = nav; }
  });
  const end = inWin[inWin.length - 1];
  const val = units * end.c;
  cfs.push({ d: end.d, v: val });
  return { invested: r1(invested), val: r1(val), months, ret: r1((val / invested - 1) * 100), xirr: xirr(cfs), worst: r1(worst * 100), worstAt, worstAmt: r1(worstAmt), end: end.d };
}
function lumpRun(A, from, to) {
  const inWin = A.filter((p) => p.d >= from && p.d <= to);
  if (inWin.length < 2) return null;
  const b = inWin[0], e = inWin[inWin.length - 1];
  const days = (Date.parse(e.d) - Date.parse(b.d)) / 86400000;
  return { ret: r1((e.c / b.c - 1) * 100), xirr: xirr([{ d: b.d, v: -U }, { d: e.d, v: U * (e.c / b.c) }]), days: Math.round(days), end: e.d };
}

const out = [];
for (const c of CYCLES) {
  const row = { id: c.id, name: c.name, first: c.first, last: c.last, hikes: c.hikes, rate: c.rate, why: c.why, tag: c.tag, ongoing: !!c.ongoing, idx: {} };
  for (const [k, label] of KEY) {
    const A = seriesOf(k);
    if (!A || !A.length) { row.idx[k] = null; continue; }
    const base = prevAt(A, c.first);
    const end = c.last ? lastAt(A, c.last) : A[A.length - 1];
    if (!base || !end || end.d <= base.d) { row.idx[k] = null; continue; }
    const seg = A.filter((p) => p.d > base.d && p.d <= end.d);
    const all = [base, ...seg];
    /* 区间涨跌 + 最高/最低 + 最大回撤 */
    let hi = base, lo = base, peak = -Infinity, dd = 0, ddAt = null, ddI = -1;
    all.forEach((p, i) => {
      if (p.c > hi.c) hi = p;
      if (p.c < lo.c) lo = p;
      if (p.c > peak) peak = p.c;
      const x = p.c / peak - 1;
      if (x < dd) { dd = x; ddAt = p.d; ddI = i; }
    });
    /* 回本：从最大回撤低点起，重新站上基准价所需的交易日数。
     * 窗口放宽到「区间末 + 12 个月」——只看加息段内的活，1994 这种小跌会全部记成"未回本"，
     * 读者会误以为一直没回来。 */
    let recover = null;
    if (ddI >= 0) {
      const win = A.filter((p) => p.d <= addMonths(end.d, 12));
      const start = win.findIndex((p) => p.d === all[ddI].d);
      for (let i = start + 1; i < win.length; i++) { if (win[i].c >= base.c) { recover = i - start; break; } }
    }
    /* T+N 曲线：以基准日为 T-1，首次加息日为 T+0；不足 540 个交易日的周期到区间末为止 */
    const curve = all.slice(1).map((p, i) => ({ n: i, v: r1((p.c / base.c - 1) * 100), d: p.d }));
    const mo = {};
    for (const m of [1, 3, 6, 9, 12]) {
      const t = lastAt(A, addMonths(end.d, m));
      mo['m' + m] = t && t.d > end.d ? r1((t.c / end.c - 1) * 100) : null;
    }
    /* 结束后 12 个月的每日曲线（v 相对末次加息日收盘，n 为交易日序号，0＝末次加息日）
       + 月度里程碑索引 marks[m]（日历月命中日在 post 里的位置）——与 mo 同源同值，页面图上
       的 1/3/6/9/12 月竖线与吸附读数都从这里取，保证图与数字永远对得上。 */
    const postWin = A.filter((p) => p.d > end.d && p.d <= addMonths(end.d, 12));
    const post = [{ n: 0, v: 0, d: end.d }, ...postWin.map((p, i) => ({ n: i + 1, v: r1((p.c / end.c - 1) * 100), d: p.d }))];
    const marks = {};
    for (const m of [1, 3, 6, 9, 12]) {
      const t = lastAt(A, addMonths(end.d, m));
      if (t && t.d > end.d) { const i = post.findIndex((p) => p.d === t.d); if (i >= 0) marks[m] = i; }
    }
    /* T+N 的 N：all[0] 是基准日（T−1），首次加息日才是 T+0，故要减 1 */
    const hiDays = all.findIndex((p) => p.d === hi.d) - 1;
    const postEnd = lastAt(A, addMonths(end.d, 12));
    row.idx[k] = {
      label, base: { d: base.d, c: base.c }, end: { d: end.d, c: end.c },
      ret: r1((end.c / base.c - 1) * 100),
      dd: r1(dd * 100), ddAt, ddDays: ddI, recover,
      hi: { d: hi.d, c: hi.c, days: hiDays }, lo: { d: lo.d, c: lo.c },
      days: seg.length, mo, curve, post, marks, dataTo: end.d,
      /* 定投 vs 一次性：窗口都取【首次加息日 → 区间末】，两者同窗口才可比 */
      dca: { seg: dcaRun(A, c.first, end.d), post: postEnd && postEnd.d > end.d ? dcaRun(A, c.first, postEnd.d) : null },
      lump: { seg: lumpRun(A, c.first, end.d), post: postEnd && postEnd.d > end.d ? lumpRun(A, c.first, postEnd.d) : null },
    };
  }
  out.push(row);
}
/* 汇总：三指数在历次加息段里的胜率与中位数 */
const summary = {};
const med = (a) => (!a.length ? null : a.length % 2 ? a[(a.length - 1) / 2] : r1((a[a.length / 2 - 1] + a[a.length / 2]) / 2));
const px = (a) => a.filter((x) => x !== null && x !== undefined);
for (const [k, label] of KEY) {
  const done = out.filter((r) => !r.ongoing).map((r) => r.idx[k]).filter(Boolean);
  const rets = done.map((x) => x.ret).sort((a, b) => a - b);
  const dds = done.map((x) => x.dd).sort((a, b) => a - b);
  const m12 = px(done.map((x) => x.mo.m12)).sort((a, b) => a - b);
  /* 定投 vs 一次性：都以「首次加息 → 加息后 12 个月」为窗口，比 XIRR（资金加权年化） */
  const dx = px(done.map((x) => (x.dca.post ? x.dca.post.xirr : null)));
  const lx = px(done.map((x) => (x.lump.post ? x.lump.post.xirr : null)));
  const dcaWorst = px(done.map((x) => (x.dca.seg ? x.dca.seg.worst : null))).sort((a, b) => a - b);
  const paired = done.filter((x) => x.dca.post && x.lump.post);
  summary[k] = {
    label, n: done.length,
    upCount: done.filter((x) => x.ret > 0).length,
    retMed: med(rets), retMin: rets[0] ?? null, retMax: rets[rets.length - 1] ?? null,
    ddMed: med(dds), ddWorst: dds[0] ?? null,
    m12Med: med(m12), m12Up: m12.filter((x) => x > 0).length, m12N: m12.length,
    dcaXirrMed: med(dx.map((v) => r1(v * 100))), lumpXirrMed: med(lx.map((v) => r1(v * 100))),
    dcaWins: paired.filter((x) => x.dca.post.xirr > x.lump.post.xirr).length, pairedN: paired.length,
    dcaWorstMed: med(dcaWorst),
  };
}
const js = '/* 由 scripts/build.mjs 生成，请勿手改。数据源与口径见 scripts/fetch.mjs 与页面「数据与口径」面板。 */\n'
  + 'const META = ' + JSON.stringify({ builtAt: new Date().toISOString().slice(0, 19).replace('T', ' '), source: S.source, fetchedAt: S.fetchedAt, quotes: S.quotes || null }, null, 1) + ';\n'
  + 'const CYCLES = ' + JSON.stringify(out, null, 1) + ';\n'
  + 'const SUMMARY = ' + JSON.stringify(summary, null, 1) + ';\n';
fs.writeFileSync('data/cycles.js', js);
console.log('  → data/cycles.js  ' + (fs.statSync('data/cycles.js').size / 1024).toFixed(0) + ' KB\n');
/* 控制台核对表 */
const f = (v, dp = 1) => (v === null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(dp) + '%');
console.log('周期'.padEnd(20) + '指数'.padEnd(12) + '加息段涨跌'.padStart(10) + '最大回撤'.padStart(10) + '  见顶(距首加)'.padStart(16) + '  回本(交易日)'.padStart(12) + '  加息后12月'.padStart(11));
for (const r of out) {
  for (const [k, label] of KEY) {
    const x = r.idx[k];
    if (!x) continue;
    console.log(r.name.padEnd(20) + label.padEnd(12) + f(x.ret).padStart(10) + f(x.dd).padStart(10) + ('  ' + x.hi.d + ' (T+' + x.hi.days + ')').padStart(16) + ('  ' + (x.recover === null ? '未回本' : x.recover + ' 日')).padStart(12) + f(x.mo.m12).padStart(11));
  }
}
console.log('\n汇总（已完成周期）');
for (const [k, label] of KEY) {
  const s = summary[k];
  console.log('  ' + label.padEnd(12) + s.n + ' 个周期 · 上涨 ' + s.upCount + ' 次 · 中位数 ' + f(s.retMed) + ' · 区间 ' + f(s.retMin) + '~' + f(s.retMax) + ' · 最大回撤中位 ' + f(s.ddMed) + ' · 加息后12月中位 ' + f(s.m12Med) + '（' + s.m12Up + '/' + s.m12N + ' 上涨）');
}
console.log('\n定投 vs 一次性（窗口＝首次加息 → 加息后 12 个月，比 XIRR 资金加权年化）');
for (const [k, label] of KEY) {
  const s = summary[k];
  console.log('  ' + label.padEnd(12) + '定投 XIRR 中位 ' + f(s.dcaXirrMed) + '　一次性 XIRR 中位 ' + f(s.lumpXirrMed)
    + '　定投胜 ' + s.dcaWins + '/' + s.pairedN + '　定投期间最深浮亏中位 ' + f(s.dcaWorstMed));
}
