#!/usr/bin/env node
"use strict";
/* ============================================================================
 * 费率表（AUTO）：抓东方财富基金档案页的 管理费率 / 托管费率 / 销售服务费率 + 资产规模，
 * 写入 data.js 的 FEES 块，供页面「💸 费率体检」算「换成更便宜的同口径产品，每年能省多少」。
 *
 * 为什么单独一个脚本：费率与行情不同频 —— 行情天天变，费率一年也未必动一次。
 * 放进每日 CI 顺带刷一遍最省事；抓失败时保留旧值，不会污染行情数据。
 *
 * 口径：综合费率 = 管理费 + 托管费 + 销售服务费（年化）。销售服务费只在 C 类等份额上存在，
 *       这正是同一只基金不同份额（A/C/F/I）费率差的主要来源（例：华安纳指 A 0.80% vs C 1.00%）。
 *       这些费用每日从基金资产计提、已含在净值里，不需要投资者另付 → 它不影响「今天赚多少」，
 *       只决定「长期少赚多少」，是确定性成本。
 *
 * 代码清单：我持有的场内（data.js POSITIONS.hold）+ 我持有的场外（positions.html OTC.funds）
 *          + 回测候选（scripts/alt-etf-backtest.mjs 的 UNIVERSE）+ PEERS 指向的替代产品。
 * 数据源：https://fundf10.eastmoney.com/jbgk_<code>.html（基金基本概况，招募说明书口径）
 * 运行：node scripts/fetch-fees.mjs [--dry] [--max-age-days N]
 *       --dry 只打印不写盘；--max-age-days N（默认 7）＝费率表 N 天内视为新鲜、直接跳过抓取（0 = 总是刷新）。
 *       逐日抓 28 个档案页是纯浪费（费率一年未必动一次），故加了这条门控；CI 不加参数即按默认 7 天走 ✓。
 * ⚠ PEERS 是 MANUAL 判断，不在东财数据里，改这里即可（null = 当前没有更便宜的同口径选择）。
 * ========================================================================== */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readModel, validateModel, auditFiles, atomicWrite } from "./data-quality.mjs";
import { UNIVERSE } from "./alt-etf-backtest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_URL = new URL("../", import.meta.url);
const DATA = join(ROOT, "data.js");
const DRY = process.argv.slice(2).includes("--dry");
const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://fundf10.eastmoney.com/" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- MANUAL：同口径更便宜的替代（换它就能省费率差）----------
 * 判断标准：同一指数 / 同一市场、同类份额，且综合费率更低。
 * 跨渠道（场外↔场内）不算「同口径」，所以不在这里体现 —— 那条对比在「标的替换回测」的反向表里。
 * 159941（纳指场内 1.00%）→ 159501（纳指场内 0.60%，同类最低且规模 124 亿、流动性够用）。 */
const PEERS = {
  "159941": "159501",
  "513650": "159655",   // 同为 0.75%：指向同类最低档，页面据此显示「已是同类最低」而不是「无同类候选」
  "513310": null,       // 中韩半导体只有这一只 ETF
  "513880": null,       // 日经 0.25%（表内最低）
  "160644": null,       // 港美互联网 LOF，表内无更便宜的同口径
  "021000": null,       // 纳指场外最低（0.66%）
  "021778": "021000",
  "018738": null,       // 标普场外最低（0.81%）
  "040046": "021000",
  "014978": "021000",
  "023402": null,       // 主动型（全球精选），无同口径被动替代
  "007280": null,       // 主动型（日本精选）
  "015884": null,       // 主动型（港股数字）
};

/* ---------- 读数据 ---------- */
function readPositions() {
  const src = readFileSync(DATA, "utf8");
  const m = src.match(/const POSITIONS = \{[\s\S]*?\n\};/);
  if (!m) throw new Error("data.js 里找不到 POSITIONS");
  return eval("(" + m[0].replace("const POSITIONS =", "").replace(/;$/, "") + ")");
}
function readOtc() {
  const src = readFileSync(join(ROOT, "positions.html"), "utf8");
  const head = "const OTC = ";
  const i = src.indexOf(head);
  if (i < 0) throw new Error("positions.html 里找不到 OTC");
  let j = i + head.length, depth = 0, inStr = null, end = -1;
  for (; j < src.length; j++) {
    const c = src[j], p = src[j - 1];
    if (inStr) { if (c === inStr && p !== "\\") inStr = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") { depth--; if (!depth) { end = j + 1; break; } }
  }
  const box = {}; vm.createContext(box);
  vm.runInContext("this.X = " + src.slice(i + head.length, end) + ";", box, { timeout: 3000 });
  return box.X;
}

/* ---------- 抓单只 ---------- */
const num = (s) => { const m = String(s).match(/([\d.]+)/); return m ? +m[1] : null; };
async function fetchFee(code) {
  const r = await fetch("https://fundf10.eastmoney.com/jbgk_" + code + ".html", { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const txt = (await r.text())
    .replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, "|").replace(/&nbsp;/g, " ").replace(/\|+/g, "|").replace(/[ \t\r\n]+/g, " ");
  const rate = (label) => {
    const m = txt.match(new RegExp(label + "\\s*\\|?\\s*([\\d.]+|—+|--+)\\s*%"));
    return m ? (num(m[1]) || 0) : null;   //「---（每年）」= 该份额不收这项 → 记 0（不是未知）
  };
  const manage = rate("管理费率"), trust = rate("托管费率"), sale = rate("销售服务费率");
  if (manage === null || trust === null) throw new Error("页面未找到费率字段");
  const scale = (txt.match(/资产规模\s*\|?\s*([\d.]+)\s*亿元/) || [])[1];
  const full = (txt.match(/基金全称\s*\|?\s*([^|]{2,60}?)\s*\|/) || [])[1];
  return {
    manage: +manage.toFixed(2),
    trust: +trust.toFixed(2),
    sale: +(sale || 0).toFixed(2),
    total: +(manage + trust + (sale || 0)).toFixed(2),
    scale: scale ? +scale : null,
    full: full ? full.trim() : null,
  };
}

function writeFees(payload) {
  const src = readFileSync(DATA, "utf8");
  const anchor = /^const FEES = \{[\s\S]*?^\};/m;
  if (!anchor.test(src)) throw new Error("data.js 里缺少 const FEES = {...}; 锚点（先手工加占位块）");
  const literal = JSON.stringify(payload, null, 2).replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, "$1$2:");
  const next = src.replace(anchor, () => "const FEES = " + literal + ";");
  const errors = validateModel(readModel(next));
  if (errors.length) throw new Error("候选数据未过 schema 校验：" + errors.join("；"));
  if (readFileSync(DATA, "utf8") !== src) throw new Error("data.js 在抓取期间被改动，放弃写入");
  const gate = auditFiles(ROOT_URL);
  if (gate.length) throw new Error("写前审计未通过：" + gate.join("；"));
  atomicWrite(DATA, next);
}

async function main() {
  const P = readPositions(), OTC = readOtc();
  const old = readModel(readFileSync(DATA, "utf8")).FEES || { items: {} };
  const codes = [];
  P.hold.forEach((h) => codes.push(h.code));
  OTC.funds.forEach((f) => codes.push(f.code));
  UNIVERSE.forEach((g) => { g.etf.forEach(([c]) => codes.push(c)); g.otc.forEach(([c]) => codes.push(c)); });
  Object.values(PEERS).forEach((p) => { if (p) codes.push(p); });
  const list = [...new Set(codes)].sort();
  /* 短名：页面要显示「→ 159501 纳指ETF嘉实 0.60%」，光有代码认不出来。
     三个来源（持仓场内 sym / 持仓场外 name / 候选清单 name）都带上；都没有就留空，页面只显示代码。 */
  const SHORT = {};
  P.hold.forEach((h) => { SHORT[h.code] = h.sym; });
  OTC.funds.forEach((f) => { SHORT[f.code] = f.name.replace(/\(QDII\)/g, "").replace(/发起式|型证券投资基金/g, "").trim(); });
  UNIVERSE.forEach((g) => { [...g.etf, ...g.otc].forEach(([c, n]) => { SHORT[c] = n; }); });

  /* 新鲜度门控（2026-09-22，请求量优化 C）：费率与行情不同频 —— 一年也未必动一次，
     逐日抓 28 个档案页纯属浪费（约占日更请求量 17%）。同时满足两条才跳过：
       ① FEES.asOf 距今天数 < maxAge（默认 7）；
       ② 清单里每一只都已有费率记录 —— 新加了持仓/候选就必须补抓，不能因为"表还新"漏掉新成员。
     跳过 = 保持旧块不动 ✓，与「抓失败保留旧值」语义一致。强制刷新：--max-age-days 0。 */
  const maxAge = (() => {
    const i = process.argv.indexOf("--max-age-days");
    const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
    return Number.isFinite(v) && v >= 0 ? v : 7;
  })();
  const today = new Date().toISOString().slice(0, 10);
  const gapDays = old.asOf ? Math.floor((Date.parse(today) - Date.parse(old.asOf)) / 86400000) : Infinity;
  const missing = list.filter((c) => !(old.items && old.items[c]));
  if (maxAge > 0 && gapDays < maxAge && !missing.length) {
    console.log("跳过抓取：费率表 asOf " + old.asOf + "（" + gapDays + " 天前，阈值 " + maxAge + " 天），且 " + list.length + " 只全都有记录 ✓");
    console.log("  强制刷新：node scripts/fetch-fees.mjs --max-age-days 0");
    return;
  }
  if (missing.length) console.log("需要刷新：清单里有 " + missing.length + " 只尚无费率记录（" + missing.slice(0, 8).join("、") + (missing.length > 8 ? " 等" : "") + "）");

  console.log("抓取 " + list.length + " 只的费率（东财基金档案）…");
  const items = {};
  let ok = 0, failed = [];
  for (const code of list) {
    try {
      items[code] = await fetchFee(code);
      ok++;
    } catch (e) {
      if (old.items && old.items[code]) { items[code] = old.items[code]; console.log("  ⚠ " + code + " 抓取失败（" + e.message + "），保留旧值"); }
      else { failed.push(code + "(" + e.message + ")"); console.log("  ⚠ " + code + " 抓取失败且无旧值：" + e.message); }
    }
    await sleep(150);
  }
  console.log("  成功 " + ok + "/" + list.length + (failed.length ? " · 无值 " + failed.length + " 只：" + failed.join("、") : ""));

  /* 控制台也给一份决策视图：按「每年可省」降序 */
  const mv = {};
  P.hold.forEach((h) => { mv[h.code] = null; });          // 场内市值要现价，这里只列费率与可省（市值口径见页面）
  const money = (x) => Math.round(x).toLocaleString("en-US");
  console.log("");
  console.log("=== 与替代产品的费率差（同口径，年化）===");
  Object.keys(PEERS).filter((c) => PEERS[c]).forEach((c) => {
    const a = items[c], b = items[PEERS[c]];
    if (!a || !b) return;
    console.log("  " + c + " " + (a.total.toFixed(2) + "%").padStart(6) + "  →  " + PEERS[c] + " " + (b.total.toFixed(2) + "%").padStart(6) +
      "   每 1 万元每年省 " + money(10000 * (a.total - b.total) / 100) + " 元");
  });

  const payload = {
    asOf: new Date().toISOString().slice(0, 10),
    source: "东方财富基金档案：管理费率 + 托管费率 + 销售服务费率",
    peers: PEERS,
    items,
  };
  Object.entries(items).forEach(([code, f]) => { if (SHORT[code]) f.name = SHORT[code]; });
  if (DRY) { console.log(""); console.log("（--dry：未写入 data.js）"); return; }
  writeFees(payload);
  console.log("");
  console.log("data.js: FEES 已更新（" + Object.keys(items).length + " 只，抓取日 " + payload.asOf + "）");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("失败：" + e.message); process.exitCode = 1; });
}
