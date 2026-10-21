#!/usr/bin/env node
/* ===== 逐笔成交在「当日振幅」里的位置（2026-10-21 加） =====
   用户：「逐笔流水里还能更精确到当日的低~高的位置吗？」→ 讨论后选 A（**只做汇总、不进逐笔明细**）：

   为什么不做逐笔常显（当时的结论，别照着"优化"回去 ✗）：
     · 量级不对：10-21 那笔买在当日振幅 5% 位（＝最好的执行），可同一只的**溢价是 +15.9%** ——
       两者差三个量级，行内再放一个「当日 5% 位」只会把注意力引到错的那个数上 ✗。
     · 逐笔读数不成决策：单笔落在 20% 还是 80% 位，对长期持有是噪声；有价值的是**模式**
       （「是不是习惯性追高」）→ 所以只出「中位数 / 下半区几笔 / 上半区几笔」这种汇总 ✓。

   口径：
     · 区间：腾讯前复权日K的**当日最低 / 最高**（与 fetch-hold-history 同一个接口）
     · 位置 ＝ (成交价 − 低) ÷ (高 − 低)，落在 [0, 100]%
       ⚠ 用**比例**，所以"前复权价 vs 券商成交价"的差异不影响结果 ✓（分子分母同比例缩放）。
         但也正因如此，别拿这个表里的 hi/lo 去和券商成交价直接相减算滑点 ✗（那是两套数）。
     · 一字板（高＝低）算不出位置 → 跳过该笔（不写 0%、不写 100% ✓）
     · 只在**有成交的日期**留一条（同一天多笔共用一个区间），约 20 条 → 不到 2KB

   与 PREM_LOG 的分工：溢价（买贵了多少，相对净值）看**长期拖累**；这里（当日位置，相对当天区间）
   看**执行**。前者 T+1 才有净值，后者当天收盘就有 ✓。

   输出：data.js 的 RANGE_LOG（标的 → 日期 → [低, 高]）。 */

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDate, atomicWrite } from "./data-quality.mjs";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataFile = path.join(ROOT, "data.js");

const UA = { "User-Agent": "Mozilla/5.0" };

/* 场内代码映射（与 fetch-trade-premium / fetch-hold-history 一致；场外基金没有"当日振幅"这个概念） */
const CODE = {
  纳指ETF广发: "159941",
  标普500ETF南方: "513650",
  日经225ETF华安: "513880",
  港美互联网LOF: "160644",
  中韩半导体ETF华泰: "513310",
};
const sym = (c) => (/^(15|16)/.test(c) ? "sz" : "sh") + c;

/* 日K → { 日期: [低, 高] }。字段顺序：日期 / 开 / 收 / 高 / 低 / 量（复权口径下前两者与高低同源 ✓） */
async function barsOf(code) {
  const s = sym(code);
  const r = await fetch("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" + s + ",day,,,320,qfq",
    { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(s + " HTTP " + r.status);
  const j = await r.json();
  const b = j.data?.[s], list = b?.qfqday || b?.day;
  if (!Array.isArray(list) || list.length < 20) throw new Error(s + " bars missing");
  const out = {};
  for (const x of list) {
    const d = x[0], hi = +x[3], lo = +x[4];
    if (!isDate(d) || !Number.isFinite(hi) || !Number.isFinite(lo) || hi <= 0 || lo <= 0) continue;
    out[d] = [lo, hi];
  }
  return out;
}

async function main() {
  const src = fs.readFileSync(dataFile, "utf8");
  /* 直接抽 POSITIONS 块求值（不经过 readModel：理由见 fetch-trade-premium.mjs 同一处注释） */
  const pm = src.match(/^const POSITIONS = \{[\s\S]*?^\};/m);
  if (!pm) throw new Error("POSITIONS anchor missing");
  const ctx = { console }; vm.createContext(ctx);
  vm.runInContext(pm[0] + "\nthis.P = POSITIONS;", ctx, { timeout: 3000 });
  const log = (ctx.P && ctx.P.log) || [];
  if (!log.length) { console.error("POSITIONS.log 为空，保留旧值"); process.exit(1); }

  const items = {};
  let hit = 0, miss = 0, flat = 0;
  const jobs = await Promise.all(Object.entries(CODE).map(async ([name, code]) => {
    const rows = log.filter((e) => e.sym === name && isDate(e.d) && Number.isFinite(+e.cost));
    if (!rows.length) return null;
    let bars;
    try {
      bars = await barsOf(code);
    } catch (e) {
      return { name, err: e.message };
    }
    const out = {};
    let h = 0, m = 0, f = 0;
    for (const e of rows) {
      const rg = bars[e.d];
      if (!rg) { m++; continue; }                       // 当天休市 / 该笔不在 K 线覆盖范围内
      if (rg[1] <= rg[0]) { f++; continue; }            // 一字板：位置无意义 ✗
      out[e.d] = [Math.round(rg[0] * 1000) / 1000, Math.round(rg[1] * 1000) / 1000];
      h++;
    }
    return { name, out, h, m, f };
  }));
  for (const r of jobs) {
    if (!r) continue;
    if (r.err) { console.error("  ⚠ " + r.name + " 日K抓取失败：" + r.err + "（该只跳过）"); continue; }
    hit += r.h; miss += r.m; flat += r.f;
    if (Object.keys(r.out).length) items[r.name] = r.out;
    console.log("  " + r.name.padEnd(18) + Object.keys(r.out).length + " 天" + (r.m ? " · 缺 " + r.m + " 笔" : "") + (r.f ? " · 一字板 " + r.f + " 笔" : ""));
  }

  const asOf = log.map((e) => e.d).filter(isDate).sort().at(-1) || null;
  const next = { asOf, source: "Tencent qfq day bars (low/high) / POSITIONS.log trade price", items };
  const block = "const RANGE_LOG = " + JSON.stringify(next, null, 1) + ";";
  if (!/^const RANGE_LOG = \{/m.test(src)) throw new Error("RANGE_LOG anchor missing（请在 data.js 里保留该块）");
  const candidate = src.replace(/^const RANGE_LOG = \{[\s\S]*?^\};/m, () => block);

  const backup = dataFile + ".range.bak";
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
  console.log(`data.js: RANGE_LOG 已更新（${Object.keys(items).length} 只 / ${hit} 笔命中` +
    `${miss ? " / " + miss + " 笔缺当日K" : ""}${flat ? " / " + flat + " 笔一字板" : ""}，截至 ${asOf}）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
