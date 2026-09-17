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
const TODAY = '2026-09-17';
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
for (const [key, sym] of [['ndx', 'NDX'], ['sox', 'SOX']]) {
  const raw = parseNasdaq(await get(`https://api.nasdaq.com/api/quote/${sym}/historical?assetclass=index&fromdate=1990-01-01&todate=${TODAY}&limit=99999`));
  /* 恒定值段体检：连续 ≥20 个交易日收盘完全相同的开头，判为占位数据 */
  let cut = 0;
  for (let i = 0; i < raw.length - 20; i++) {
    if (raw[i].c === raw[i + 19].c) { cut = i + 20; } else break;
  }
  if (cut > 0) {
    console.log('  ⚠ ' + sym + ' 开头 ' + cut + ' 个交易日（' + raw[0].d + ' → ' + raw[cut - 1].d + '）收盘恒为 ' + raw[0].c + '，判定为占位数据，已丢弃');
  }
  idx[key] = cut ? raw.slice(cut) : raw;
  console.log('  ' + sym + '  ' + idx[key].length + ' 个交易日  ' + idx[key][0].d + ' → ' + idx[key][idx[key].length - 1].d + '   （来源 Nasdaq 官方 API）');
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

fs.writeFileSync('data/series.json', JSON.stringify({
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
console.log('  → data/series.json  ' + (fs.statSync('data/series.json').size / 1024).toFixed(0) + ' KB');
