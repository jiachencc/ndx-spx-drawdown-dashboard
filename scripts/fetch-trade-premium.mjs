#!/usr/bin/env node
/* ===== 逐笔成交时的溢价率（2026-10-20 加） =====
   用户：「场内持仓与操作记录 的明细里 逐笔流水 是否还能加上当时的溢价？」
   做成了：每笔买入/卖出的那一行，显示「当时溢价 +8.8%」。

   口径：溢价 = 成交价 ÷ **当日单位净值** − 1
     · 净值来源：东方财富 f10/lsjz（每只 ETF 都有，2023 年至今约 800 天）
     · 成交价：POSITIONS.log 里录的券商成交价
     · QDII 净值公布滞后 1 天，但**净值日**与交易日一致（T 日净值在 T+1 公布）
       → 按成交日直接查表；查不到时向前回退最多 6 个自然日（跨周末/假期）

   为什么值得做：溢价是「买贵了还是买便宜了」的唯一量化依据。
     实测纳指ETF广发从 6-23 的 +8.8% 一路涨到 10-16 的 +19.0%，
     而港美互联网 LOF 在 8-13 是 **−2.9%（折价）** —— 这些在流水里看不出来。

   ⚠ 净值是**基金公司公布值**，与场内实时价存在正常时滞；这里只作参考，不作估值依据。
   输出：data.js 的 PREM_LOG（按 标的 → 日期 → 溢价% 两层索引，约 3KB）。 */

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDate, atomicWrite } from "./data-quality.mjs";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataFile = path.join(ROOT, "data.js");

const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://fundf10.eastmoney.com/" };
const LOG = (POSITIONS) => POSITIONS.log || [];

/* 场内外代码映射：只处理有场内价格的标的（场外基金没有溢价概念） */
const CODE = {
  纳指ETF广发: "159941",
  标普500ETF南方: "513650",
  日经225ETF华安: "513880",
  港美互联网LOF: "160644",
  中韩半导体ETF华泰: "513310",
};

async function navSeries(code) {
  const m = {};
  for (let p = 1; p <= 40; p++) {
    const r = await fetch(`https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${p}&pageSize=20`,
      { headers: UA, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(code + " HTTP " + r.status);
    const j = await r.json();
    const list = (j.Data && j.Data.LSJZList) || [];
    if (!list.length) break;
    for (const x of list) if (isDate(x.FSRQ)) m[x.FSRQ] = +x.DWJZ;
  }
  return m;
}

/* 成交日 → 净值：精确命中优先；否则向前回退最多 6 天（周末 / 假期）。
   ⚠ 2026-10-23 加**上限判定**（见调用处）：`date > maxDate`（＝该日净值还没公布）时**直接跳过**，
     不许回退 —— 否则 10-22 收盘后才成交的那笔会拿 10-21 的净值算出一个"看着正常其实错"的溢价 ✗
     （2026-10-22 实测：回退会把 4 笔全算成 +15.9% 那档，页面上与真值长得一模一样 ✗）。
     回退**只**服务于"那天是周末/假期/该只暂停估值"这类历史情形 ✓。 */
function navAt(map, date) {
  if (map[date]) return { nav: map[date], d: date };
  let t = Date.parse(date);
  for (let i = 1; i <= 6; i++) {
    const d = new Date(t - i * 864e5).toISOString().slice(0, 10);
    if (map[d]) return { nav: map[d], d };
  }
  return null;
}

async function main() {
  const src = fs.readFileSync(dataFile, "utf8");
  /* 读 POSITIONS.log：不经过 readModel（它在「data.js 里有两个大 JSON 块」时偶发
     HOLD_HIST is not defined，原因是 vm 的 1500ms 超时与行号映射），直接抽 const 块求值。 */
  const pm = src.match(/^const POSITIONS = \{[\s\S]*?^\};/m);
  if (!pm) throw new Error("POSITIONS anchor missing");
  const ctx = { console }; vm.createContext(ctx);
  vm.runInContext(pm[0] + "\nthis.P = POSITIONS;", ctx, { timeout: 3000 });
  const log = LOG(JSON.parse(JSON.stringify(ctx.P)));
  if (!log.length) { console.error("POSITIONS.log 为空，保留旧值"); process.exit(1); }

  const items = {};
  let hit = 0, miss = 0, unpub = 0;
  /* 5 只并行（2026-10-20）：原来串行 for，每只 40 页分页请求 × 5 只共 200 次、
     实测 10.4 秒；并行后 ≈2 秒（各只之间无依赖，写入时也不互相覆盖）。 */
  const jobs = await Promise.all(Object.entries(CODE).map(async ([name, code]) => {
    const rows = log.filter((e) => e.sym === name && isDate(e.d) && Number.isFinite(+e.cost));
    if (!rows.length) return null;
    let nav;
    try {
      nav = await navSeries(code);
    } catch (e) {
      return { name, err: e.message };
    }
    const out = {};
    let h = 0, m = 0, ub = 0;
    const maxNav = Object.keys(nav).sort().at(-1) || "";      // 该只**已公布**的最后一个净值日
    for (const e of rows) {
      if (e.d > maxNav) { ub++; continue; }                   // 净值还没出 → 跳过（不回退 ✗，见 navAt 注释）
      const n = navAt(nav, e.d);
      if (!n) { m++; continue; }
      out[e.d] = Math.round(((+e.cost / n.nav) - 1) * 1000) / 10;   // 保留 1 位小数
      h++;
    }
    return { name, out, h, m, ub, maxNav };
  }));
  for (const r of jobs) {
    if (!r) continue;
    if (r.err) { console.error("  ⚠ " + r.name + " 净值抓取失败：" + r.err + "（该只跳过）"); continue; }
    hit += r.h; miss += r.m; unpub += r.ub || 0;
    if (Object.keys(r.out).length) items[r.name] = r.out;
    console.log("  " + r.name.padEnd(18) + Object.keys(r.out).length + " 笔"
      + (r.ub ? " · 净值未公布 " + r.ub + " 笔（该只最新净值日 " + r.maxNav + "）" : ""));
  }

  /* ⚠ asOf 的语义（2026-10-24 修）：原先取「流水里最新的**成交日**」→ 净值还没公布时，
     日志/数据块会写「截至 10-23」，而 10-23 那几笔其实**没算进去** ✗ —— 看着像齐了，最容易误判。
     现在：
       · asOf      ＝ **已算出溢价的最大日期**（真正覆盖到哪天）✓
       · tradeAsOf ＝ 流水里最新的成交日（用来对照：asOf < tradeAsOf 就说明还有交易日在等净值）
     两者分开存，页面/脚本都能一眼看出「有没有缺口」。 */
  const coveredDates = Object.values(items).flatMap((m) => Object.keys(m));
  const asOf = coveredDates.sort().at(-1) || null;
  const tradeAsOf = log.map((e) => e.d).filter(isDate).sort().at(-1) || null;
  const next = { asOf, tradeAsOf, source: "Eastmoney unit NAV / POSITIONS.log trade price", items };
  const block = "const PREM_LOG = " + JSON.stringify(next, null, 1) + ";";
  if (!/^const PREM_LOG = \{/m.test(src)) throw new Error("PREM_LOG anchor missing");
  const candidate = src.replace(/^const PREM_LOG = \{[\s\S]*?^\};/m, () => block);

  /* 写盘 → 用 check-data 独立校验 → 失败则回滚（不再依赖 readModel） */
  const backup = dataFile + ".prem.bak";
  fs.writeFileSync(backup, src);
  atomicWrite(dataFile, candidate);
  const r = spawnSync(process.execPath, ["scripts/check-data.mjs"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    fs.copyFileSync(backup, dataFile);
    fs.unlinkSync(backup);
    console.error("候选被拒（已回滚）：" + (r.stdout || r.stderr || "").split("\n").filter(Boolean).slice(-3).join("; "));
    process.exit(1);
  }
  fs.unlinkSync(backup);
  console.log(`data.js: PREM_LOG 已更新（${Object.keys(items).length} 只 / ${hit} 笔命中${miss ? " / " + miss + " 笔缺净值" : ""}，覆盖到 ${asOf || "—"}`
    + (tradeAsOf && tradeAsOf !== asOf ? `；流水最新成交日 ${tradeAsOf} 尚未算完（等净值）` : "") + "）");
  if (unpub) console.log(`  ⏳ ${unpub} 笔的**成交日净值还没公布** → 本次跳过、不写假值 ✓；等净值出来再跑一次会自动补上（页面这几行的溢价 chip 暂时不出现，不是渲染坏了）。`);
}

main().catch((e) => { console.error(e); process.exit(1); });
