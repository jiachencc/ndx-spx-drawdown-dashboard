/* 无浏览器环境下的渲染自检：用 DOM 桩跑页面脚本，检查各区是否真的产出内容、
 * 图表是否画出线、有没有 undefined/NaN 漏进界面。 */
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync('index.html', 'utf8');
const dataJs = fs.readFileSync('fed-data.js', 'utf8');
const pageJs = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];
const mk = () => {
  const e = { style: {}, dataset: {}, children: [], textContent: '', _h: '', clientWidth: 360,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; } };
  Object.defineProperty(e, 'innerHTML', { configurable: true, get() { return e._h; }, set(e2) { this._h = e2; } });
  return e;
};
const byId = {};
const allBoxes = [];
const charts = mk();
const getById = (id) => {
  if (id === 'charts') {
    Object.defineProperty(charts, 'innerHTML', { configurable: true, get() { return charts._h; }, set(v) {
      charts._h = v;
      const boxes = [...v.matchAll(/<div class="cbox" data-(idx|cyc)="([^"]+)"><\/div>/g)].map((m) => {
        const b = mk();
        b.dataset = m[1] === 'idx' ? { idx: m[2] } : { cyc: m[2] };
        allBoxes.push(b); return b;
      });
      charts._boxes = boxes;
    } });
    charts.querySelector = () => (charts._boxes || [])[0] || mk();
    charts.querySelectorAll = () => charts._boxes || [];
    return charts;
  }
  return (byId[id] = byId[id] || mk());
};
const sandbox = {
  console, JSON, Math, Date, Array, Object, String, Number, isFinite, parseFloat, parseInt,
  setTimeout, clearTimeout,
  document: { getElementById: getById, querySelectorAll: (sel) => (sel === '.cbox' ? allBoxes : []) },
  window: { addEventListener() {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(dataJs + '\n' + pageJs, sandbox);
const txt = (h) => String(h).replace(/<br\s*\/?>/g, ' / ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
console.log('=== 头部 ===\n  ' + txt(byId['head-sub']._h));
console.log('\n=== 当前周期卡 ===\n  ' + txt(byId['sec-now']._h).slice(0, 420));
console.log('\n=== 总览表（前 3 行）===');
[...byId['sec-table']._h.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(0, 4).forEach((m) => console.log('  ' + txt(m[1])));
console.log('\n=== 图表 ===');
allBoxes.forEach((b, i) => {
  const svg = b._h || '';
  const lines = (svg.match(/<polyline /g) || []).length;
  const nan = /NaN|undefined/.test(svg);
  console.log('  图' + (i + 1) + '  ' + (b.dataset.idx || b.dataset.cyc).padEnd(12) + ' SVG ' + (svg.length ? '已生成' : '✗ 空') + ' · 折线 ' + lines + ' 条' + (nan ? '  ✗ 含 NaN/undefined' : '  ✓'));
});
console.log('\n=== 导语 ===\n  ' + txt(byId['sec-intro']._h).slice(0, 300));
console.log('\n=== 术语表（前 3 条）===');
[...byId['sec-glossary']._h.matchAll(/<div><b>([^<]+)<\/b><span>([^<]+)<\/span><\/div>/g)].slice(0,3).forEach(m=>console.log('  '+m[1]+' → '+m[2]));
console.log('\n=== 周期详情：2022 那张卡逐块 ===');
const card = byId['sec-cycles']._h.split('<div class="cyc-card">').find(x=>x.includes('2022 抗通胀'));
[...card.matchAll(/<(div class="lead"|div class="blk"|div class="cyc-head")[^>]*>([\s\S]*?)(?=<div class="(?:lead|blk|cyc-why|cyc-head)|<\/div><\/div>$)/g)].forEach(m=>{
  const k=m[1].includes('lead')?'结论':m[1].includes('blk')?'数据块':'标题';
  console.log('  ['+k+'] '+txt(m[2]).slice(0,150));
  if(k==='数据块'){ [...m[2].matchAll(/class="brow">([\s\S]*?)<\/div><div class="track"/g)].slice(0,3).forEach(b=>console.log('        '+txt(b[1]))); }
});
console.log('\n=== 检查 ===');
const allHtml = Object.values(byId).map((e) => e._h).join('') + allBoxes.map((b) => b._h).join('');
console.log('  「—」以外的占位符: ' + (/undefined|NaN|\[object/.test(allHtml) ? '✗ 有' : '✓ 无'));
console.log('  各分区是否都有内容: ' + ['head-sub', 'sec-now', 'sec-summary', 'sec-table', 'sec-cycles', 'footer', 'legend'].map((k) => k + (byId[k] && byId[k]._h ? '✓' : '✗')).join(' '));
console.log('  图表数: ' + allBoxes.length + '（全部叠加模式＝3 个指数）');

/* ── 数据新鲜度（2026-09-27 加）──
   教训：fetch.mjs 里 TODAY 曾被硬编码成 '2026-09-17'，Nasdaq 接口的 todate 于是永远停在那天 →
   NDX / SOX 悄悄落后 SPX 整整一周，而本脚本只检渲染（占位符 / 分区 / 折线条数都正常），
   于是"绿灯"放行了一份残缺数据。下面两条专门盯这类静默降级：
     ① 三条序列的最新交易日必须一致（这天事故里正是这里露馅：NDX/SOX 比 SPX 晚 6 个交易日）；
     ② 最新交易日距今不得超过 5 个自然日（容周末 + 假日；超了说明抓取静默失败了）。
   任一条不过就把退出码设为 1 —— update.sh 用的是 `set -e`，会当场失败，不再绿着糊过去。 */
const S = JSON.parse(fs.readFileSync('fed-data.json', 'utf8'));
const lastOf = (k) => (Array.isArray(S[k]) && S[k].length ? S[k][S[k].length - 1].d : null);
const L = { spx: lastOf('spx'), ndx: lastOf('ndx'), sox: lastOf('sox') };
const uniq = [...new Set(Object.values(L).filter(Boolean))].sort();
const newest = uniq[uniq.length - 1] || null;
const calDays = newest ? Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(newest)) / 86400000) : NaN;
const problems = [];
if (Object.values(L).some((v) => !v)) problems.push('有条序列是空的：' + JSON.stringify(L));
else if (uniq.length !== 1) problems.push('三条序列最新日期不一致 ' + JSON.stringify(L) + '（事故原型：NDX/SOX 落后 SPX 一周）');
if (Number.isFinite(calDays) && calDays > 5) problems.push('最新交易日 ' + newest + ' 距今 ' + calDays + ' 天（> 5）→ 抓取可能静默失败了');
console.log('\n=== 数据新鲜度 ===');
console.log('  spx ' + L.spx + ' · ndx ' + L.ndx + ' · sox ' + L.sox + '  → 最新 ' + newest + '（距今 ' + calDays + ' 天）' + (problems.length ? '  ✗' : '  ✓'));
problems.forEach((p) => console.log('    ✗ ' + p));
if (problems.length) process.exitCode = 1;

