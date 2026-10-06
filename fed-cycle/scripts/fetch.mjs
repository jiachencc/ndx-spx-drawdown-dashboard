/* 取数：三个指数的日线收盘
 *
 *  标普500     https://historyofmarket.com/api/sp500/price.json
 *              → 日线，1927-12-30 起，含 drawdown 字段。数据以 CC BY 4.0 授权，
 *                页面必须署名「History of Market · 美股编年史」（见 index.html 页脚）。
 *  纳指100     https://api.nasdaq.com/api/quote/NDX/historical?assetclass=index
 *  费城半导体  https://api.nasdaq.com/api/quote/SOX/historical?assetclass=index
 *
 * 质检：纳斯达克 API 的 SOX 序列在 1994-05 之前是一段「面值 479.49 一动不动」的
 *       占位数据，之后突然跳到 121.80（指数重构）。本脚本会自动丢弃这类恒定段，
 *       并把发现的问题打印出来 —— 不静默处理数据。
 */
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
/* 当天（按北京时区；+8h 换算，不依赖运行环境的时区设置）。
   ⚠ 原来这里硬编码成 '2026-09-17'（调试留下的），后果很隐蔽：
   它被拼进 Nasdaq 历史接口的 todate → NDX / SOX 两条序列**永远停在 09-17**，
   而 SPX 走的是 historyofmarket、不受影响 → 页面照常渲染、verify 照常通过，
   只在「纳指/费半少了最近一周」这种地方露馅（2026-09-27 用户发现）。 */
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const get = async (u, accept = 'application/json') => {
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: accept } });
  if (!r.ok) throw new Error(u + ' → HTTP ' + r.status);
  return r.text();
};

/* ── 标普 500 ── */
const sp = JSON.parse(await get('https://historyofmarket.com/api/sp500/price.json'));
const spx = sp.series.map((p) => ({ d: p.date, c: p.close })).filter((p) => p.c > 0);
console.log('  SPX  ' + spx.length + ' 个交易日  ' + spx[0].d + ' → ' + spx[spx.length - 1].d + '   （来源 historyofmarket，CC BY 4.0）');

/* ── 纳指100 / 费半 ── */
const parseNasdaq = (txt) => {
  const j = JSON.parse(txt);
  const rows = (j.data && j.data.tradesTable && j.data.tradesTable.rows) || [];
  return rows.map((r) => {                       // API 按日期倒序
    const [m, d, y] = r.date.split('/');
    return { d: y + '-' + m + '-' + d, c: parseFloat(String(r.close).replace(/[,$]/g, '')) };
  }).filter((x) => x.c > 0).reverse();
};
const idx = {};
/* ── 纳指100 / 费半 ──
 * 取数策略（2026-10-06 重构，按用户要求「短窗 ＋ 本地历史拼接」）：
 *   主体 ＝ 本地 fed-data.json 的全史（有就用它，快且免发长请求）
 *          —— 但**必须保留长窗分支**：fed-data.json 被 .gitignore 忽略，CI 是全新 checkout、没有它 ✗
 *   末梢 ＝ Nasdaq **短窗**（近 60 天）：实测长窗（1990 起 + limit=99999）末端只到 10-02，
 *          而同一 API 的短窗有到 10-05 → 短窗补上末尾那几天（同日以短窗为准，它更新更准）。
 *   于是「走势对比少一截」从源头不会发生，不再依赖后面的补末梢兜底。
 */
const localBody = (k) => {
  try {
    const j = JSON.parse(fs.readFileSync('fed-data.json', 'utf8'));
    const a = j[k];
    return Array.isArray(a) && a.length > 500 ? a.map((x) => ({ d: x.d, c: x.c })) : null;
  } catch (e) { return null; }
};
const nasdaqWindow = async (sym, days) => {
  const from = new Date(Date.parse(TODAY) - days * 864e5).toISOString().slice(0, 10);
  return parseNasdaq(await get(`https://api.nasdaq.com/api/quote/${sym}/historical?assetclass=index&fromdate=${from}&todate=${TODAY}&limit=9999`));
};
const mergeBy = (base, add) => { const m = new Map(base.map((x) => [x.d, x])); add.forEach((x) => m.set(x.d, x)); return [...m.values()].sort((a, b) => (a.d < b.d ? -1 : 1)); };

for (const [key, sym] of [['ndx', 'NDX'], ['sox', 'SOX']]) {
  let base = localBody(key), src = '本地 fed-data.json';
  if (!base) {
    const raw = parseNasdaq(await get(`https://api.nasdaq.com/api/quote/${sym}/historical?assetclass=index&fromdate=1990-01-01&todate=${TODAY}&limit=99999`));
    /* 恒定值段体检：连续 ≥20 个交易日收盘完全相同的开头，判为占位数据 */
    let cut = 0;
    for (let i = 0; i < raw.length - 20; i++) { if (raw[i].c === raw[i + 19].c) { cut = i + 20; } else break; }
    if (cut > 0) console.log('  ⚠ ' + sym + ' 开头 ' + cut + ' 个交易日（' + raw[0].d + ' → ' + raw[cut - 1].d + '）收盘恒为 ' + raw[0].c + '，判定为占位数据，已丢弃');
    base = cut ? raw.slice(cut) : raw;
    src = '长窗（Nasdaq 全史：CI 无本地文件时走这条）';
  }
  let tail = [];
  try { tail = await nasdaqWindow(sym, 60); } catch (e) { console.log('  ⚠ ' + sym + ' 短窗取数失败（' + e.message + '），末梢可能落后'); }
  const merged = mergeBy(base, tail);
  const added = merged.length - base.length;
  idx[key] = merged;
  console.log('  ' + sym + '  ' + merged.length + ' 个交易日  ' + merged[0].d + ' → ' + merged[merged.length - 1].d
    + '   （主体 ' + src + ' ＋ 短窗 60 天' + (added > 0 ? '，末梢补 ' + added + ' 根' : '，末梢无新增') + '）');
}

/* ── 最新报价（新浪，GBK）──
 * 目的：纳指/费半的历史接口有一天延迟，历史序列的最新点可能落后于"加息当日"。
 * 单独抓一条实时报价给"当前周期"卡用，不混进历史序列（避免同一根线里两种口径）。
 * 取不到就让页面自己降级，不阻断构建。 */
let quotes = null;
try {
  const r = await fetch('https://hq.sinajs.cn/list=gb_$ndx,gb_$inx,gb_$sox', { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' } });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = new TextDecoder('gbk').decode(buf);
  const pick = (sym) => {
    const head = 'hq_str_' + sym + '="';
    const at = text.indexOf(head);
    if (at < 0) return null;
    const body = text.slice(at + head.length);
    const f = body.slice(0, body.indexOf('"')).split(',');
    if (!f[1] || !(+f[1] > 0)) return null;
    return { name: f[0], price: +f[1], chgPct: +f[2], asOf: (f[3] || '').slice(0, 10) };
  };
  quotes = { ndx: pick('gb_$ndx'), spx: pick('gb_$inx'), sox: pick('gb_$sox') };
  const ok = Object.keys(quotes).filter((k) => quotes[k]);
  console.log('  报价  ' + (ok.length ? ok.map((k) => k.toUpperCase() + ' ' + quotes[k].price + ' (' + quotes[k].chgPct + '%) @' + quotes[k].asOf).join(' · ') : '未取到（页面会自动降级）'));
} catch (e) {
  console.log('  ⚠ 报价抓取失败（' + e.message + '），页面将只用历史序列');
}

/* ── 补末梢（2026-10-06 加）──────────────────────────────────────────────
 * 问题：三个源的更新速度不一样 —— 用户发现「走势对比」里 spx/sox 比 ndx 少一截。
 *   实测（2026-10-06）：historyofmarket（SPX）只到 10-02、Nasdaq 的 SOX 同样滞后，
 *   而腾讯 usINX / usNDX 的日线已到 10-05。
 * 规则：谁落后于「三条里最新的那天」，就用腾讯 qfq 日线补那几天（同日不覆盖、只在变长时采用）。
 * 说明：腾讯没有 usSOX 日线（实测返回空数组）→ SOX 补不上时会打印原因，不静默。
 */
const tencent = async (sym) => {
  const txt = await get('https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=' + sym + ',day,,,320,qfq', 'text/plain');
  const j = JSON.parse(txt);
  const d = j.data && j.data[sym] && j.data[sym].day;
  return Array.isArray(d) ? d.map((r) => ({ d: r[0], c: parseFloat(r[2]) })).filter((x) => x.c > 0) : [];
};
/* Nasdaq 短窗补数（2026-10-06 加，实测必需）：
 *   长窗请求（1990 起 + limit=99999）拿回的 SOX 只到 10-02，但**同一个 API 的短窗请求有到 10-05**
 *   —— 所以这不是源滞后，是本脚本的取数窗口问题；补末梢时用短窗再要一次即可。 */
const nasdaqTail = async (k) => {
  const sym = k === 'ndx' ? 'NDX' : k === 'sox' ? 'SOX' : null;
  if (!sym) return [];
  const from = new Date(Date.parse(TODAY) - 45 * 864e5).toISOString().slice(0, 10);
  const txt = await get('https://api.nasdaq.com/api/quote/' + sym + '/historical?assetclass=index&fromdate=' + from + '&todate=' + TODAY + '&limit=9999');
  return parseNasdaq(txt);
};
const TOPUP = { spx: 'usINX', ndx: 'usNDX', sox: 'usSOX' };
const S3 = { spx, ndx: idx.ndx, sox: idx.sox };
const maxD = Object.values(S3).map((a) => a[a.length - 1].d).sort().pop();
for (const k of Object.keys(S3)) {
  const cur = S3[k];
  const curEnd = cur[cur.length - 1].d;
  if (curEnd >= maxD) continue;
  try {
    let add = await tencent(TOPUP[k]);
    /* 腾讯拿不到或没到最新 → 再试 Nasdaq 短窗（SOX 走这条） */
    if (!add.length || add[add.length - 1].d <= curEnd) add = await nasdaqTail(k);
    const m = new Map(cur.map((x) => [x.d, x]));
    add.forEach((x) => { if (!m.has(x.d)) m.set(x.d, x); });
    const merged = [...m.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
    if (merged.length > cur.length) {
      console.log('  补末梢 ' + k + '：' + curEnd + ' → ' + merged[merged.length - 1].d + '（腾讯 ' + TOPUP[k] + '，+' + (merged.length - cur.length) + ' 根）');
      cur.length = 0; cur.push(...merged);
    } else console.log('  补末梢 ' + k + '：腾讯 ' + TOPUP[k] + ' 无可补数据（末仍 ' + curEnd + '）');
  } catch (e) { console.log('  补末梢 ' + k + ' 失败：' + e.message); }
}

fs.writeFileSync('fed-data.json', JSON.stringify({
  fetchedAt: new Date().toISOString().slice(0, 10),
  source: {
    spx: { name: 'History of Market', url: 'https://historyofmarket.com/api/sp500/price.json', license: 'CC BY 4.0' },
    ndx: { name: 'Nasdaq', url: 'https://api.nasdaq.com/api/quote/NDX/historical', license: 'Nasdaq 官方' },
    sox: { name: 'Nasdaq', url: 'https://api.nasdaq.com/api/quote/SOX/historical', license: 'Nasdaq 官方' },
    quote: { name: '新浪财经', url: 'https://hq.sinajs.cn/list=gb_$ndx,gb_$inx,gb_$sox', license: '仅作最新报价参考' },
  },
  quotes,
  ndx: idx.ndx, sox: idx.sox, spx,
}));
console.log('  → fed-data.json  ' + (fs.statSync('fed-data.json').size / 1024).toFixed(0) + ' KB');
