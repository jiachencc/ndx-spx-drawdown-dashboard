#!/usr/bin/env node
"use strict";
/* 场外 6 只的**当日净值 / 市值 / 当日收益**自动刷新（2026-11-26 加）
 *
 * 为什么需要：
 *   在此之前，场外这一块的 `nav.close` / `closeDate` / `value` / `day` / `pnl` 全靠用户
 *   每晚截图、我手抄 —— 而净值本来就在公开接口上，每天抄 6 张图既慢又容易错
 *   （实测 11-25 那次就把 021000 的 closeDate 抄成了 11-25，实际是 11-24）✗
 *
 * 为什么单独一个脚本、不并进 refresh-otc.mjs：
 *   `refresh-otc.mjs` 干的是**慢变量**（52 周 hi/lo、买点分位，一年也用不着改几次），
 *   本脚本干的是**快变量**（每天的新净值）。两者频率差 100 倍，
 *   合在一起会让「只想更一次净值」也去拉 240 天 × 6 只的数据 ✗
 *
 * ── 数据源（两个，交叉校验）──────────────────────────────────────────────
 *   ① 天天基金 `api.fund.eastmoney.com/f10/lsjz?fundCode=X&pageSize=5`
 *      → `FSRQ`（净值日）/ `DWJZ`（单位净值）/ `JZZZL`（日涨跌 %）
 *      ⚠ pageSize 上限 **20**，超过 50 会返回 0 条
 *   ② 腾讯 `qt.gtimg.cn/q=jjX`（GBK）→ 字段 [5]=单位净值、[7]=日涨跌、[8]=净值日
 *      实测 6 只与天天基金**逐位一致** ✓（用作交叉校验，不一致就跳过该只）
 *
 * ── 三个口径 ────────────────────────────────────────────────────────────
 *   份额  = 最新快照 `SNAPSHOTS.at(-1).items[code].qty`
 *   在途  = `items.val / 现有nav.close − qty` 反推（只有 021000 有，约 197.5 份 ≈ 400 元）
 *           ⚠ 直接 `qty × nav` 会少算那 400 —— 实测 021000 差正好 400.00 ✓
 *           ⚠ 不能把 400 当**金额**加：那 400 也会随净值涨跌。所以要还原成**份额**再加 ✓
 *   value = (份额 ＋ 在途份额) × 新净值
 *   day   = (份额 ＋ 在途份额) × (新净值 − 前一交易日净值)   ← 与 App「持仓收益/今日收益」同口径
 *   pnl   = value − cost
 *
 * ── 安全边界 ────────────────────────────────────────────────────────────
 *   · 净值日 ≤ 现有的 → 跳过（还没公布）
 *   · 两个源不一致（|Δ| > 0.001）→ 跳过该只并告警
 *   · 单只失败不影响其他只（保留旧值）
 *   · 任一只 `value` 相对旧值变动 > 8% → 跳过该只（防脏数据/份额突变）
 *
 * 用法：node scripts/refresh-otc-nav.mjs           只打印（dry-run）
 *      node scripts/refresh-otc-nav.mjs --write   写回 positions-data.js
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "positions-data.js");
const WRITE = process.argv.includes("--write");
const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://fundf10.eastmoney.com/" };
const DAY_MS = 86400000;
/* ⚠ 15% 而不是 8%（2026-11-26）——
   CI 隔周末/长假才跑到时，几天累计的净值变动就可能超过 8%（实测 11-21→11-24 两天就有 6.7%），
   那样的「保护」会变成「经常无故不更新」✗ 15% 仍能拦住真正的脏数据（份额突变/串号）✓ */
const MAX_JUMP = 15;         // value 相对旧值的最大允许变动 %

const src0 = readFileSync(FILE, "utf8");
const ctx = vm.createContext({});
vm.runInContext(
  (src0.match(/^const OTC = \{[\s\S]*?^\};/m) || [""])[0] + "\nthis.O = OTC;",
  ctx, { timeout: 5000 });
vm.runInContext(
  (src0.match(/^const SNAPSHOTS = \[[\s\S]*?^\];/m) || [""])[0] + "\nthis.S = SNAPSHOTS;",
  ctx, { timeout: 8000 });
const OTC = ctx.O, SNAPSHOTS = ctx.S;
if (!OTC || !Array.isArray(OTC.funds)) throw new Error("读不到 OTC.funds");

const last = SNAPSHOTS.filter((s) => s && s.items).at(-1);
if (!last) throw new Error("读不到最新快照的 items");
const items = last.items;

/* ── 取数 ─────────────────────────────────────────────────────────────── */
async function emNav(code) {
  const u = "https://api.fund.eastmoney.com/f10/lsjz?fundCode=" + code + "&pageIndex=1&pageSize=5";
  const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const list = (j.Data && j.Data.LSJZList) || [];
  return list
    .map((x) => ({ d: x.FSRQ, nav: +x.DWJZ, chg: +x.JZZZL }))
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.d) && Number.isFinite(x.nav) && x.nav > 0);
}

async function tencentNav(code) {
  const r = await fetch("https://qt.gtimg.cn/q=jj" + code,
    { headers: { ...UA, Referer: "https://finance.qq.com/" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const t = new TextDecoder("gbk").decode(Buffer.from(await r.arrayBuffer()));
  const m = /v_jj\d+="([^"]*)"/.exec(t);
  if (!m) throw new Error("无数据");
  const a = m[1].split("~");
  const nav = +a[5];
  return { d: a[8], nav, chg: +a[7] };
}

/* ── 逐只 ─────────────────────────────────────────────────────────────── */
const results = [];
let src = src0;
let changed = 0;

for (const f of OTC.funds) {
  const it = items[f.code];
  const old = f.nav || {};
  const tag = "  " + f.code + " " + String(f.name || "").slice(0, 14).padEnd(15);

  if (!it || !Number.isFinite(it.qty)) { console.log(tag + "跳过（快照里没有份额）"); continue; }

  let em = null, tc = null, err = null;
  try { em = await emNav(f.code); } catch (e) { err = "东财 " + e.message; }
  try { tc = await tencentNav(f.code); } catch (e) { err = (err ? err + " / " : "") + "腾讯 " + e.message; }

  if (!em || !em.length) {
    console.log(tag + "跳过（" + (err || "没拿到净值") + "）");
    continue;
  }
  const newest = em[0];                        // 最新一条
  const prev = em[1] || null;                  // 前一交易日

  /* ⚠ 2026-11-27 修正：必须**同时更新最新快照的 items**（原来这里写「不碰 SNAPSHOTS」是错的）
     `OTC.funds[code].value` 与 `SNAPSHOTS.at(-1).items[code].val` 是「同一批读数」的两处副本，
     `cross-check` ① 与 `check-data` 都要求逐分相等 ✓
     只改 OTC.funds 的后果（2026-11-27 CI 实测）：
       「① 021778 快照 items val/pl +19567.88/−3012.12 ≠ OTC.funds +19439.60/−3140.40」
       → 审计失败 → 整条流水线红、当天数据推不上去 ✗
     ⚠ 前一轮尝试「放宽校验」是**错的方向**：净值日（11-25）通常**早于**快照日（11-26），
       那种情况永远判「不一致」，放宽成「净值日 ≥ 快照日才跳过」根本覆盖不到 ✗
     ⚠ 只同步**最新那一期**（历史快照是真历史，不该被后来的净值改写）；
       同步时 items 的 val/pl 与快照的 Σpl 一起改，否则又会「Σpl 对不上」✗ */

  /* ① 净值日必须有前进 */
  if (old.closeDate && newest.d <= old.closeDate) {
    console.log(tag + "跳过（净值日 " + newest.d + " 未前进，现有 " + old.closeDate + "）");
    continue;
  }
  /* ② 双源校验 */
  if (tc && tc.d === newest.d && Math.abs(tc.nav - newest.nav) > 0.001) {
    console.log(tag + "跳过（两源不一致：东财 " + newest.nav + " / 腾讯 " + tc.nav + "）");
    continue;
  }
  /* ③ 在途份额（只有 021000 有） */
  const curNav = Number.isFinite(old.close) && old.close > 0 ? old.close : null;
  const pendingShares = curNav && Number.isFinite(it.val)
    ? Math.max(0, it.val / curNav - it.qty) : 0;
  const totalShares = it.qty + pendingShares;

  const value = totalShares * newest.nav;
  const day = prev ? totalShares * (newest.nav - prev.nav) : 0;
  const cost = Number.isFinite(it.cost) ? it.cost : (it.val - it.pl);
  const pnl = value - cost;
  const rate = cost > 0 ? (pnl / cost) * 100 : 0;

  /* ④ 异常跳变保护（份额没变时，市值不该一天变 8% 以上） */
  if (Number.isFinite(f.value) && f.value > 0) {
    const jump = Math.abs(value / f.value - 1) * 100;
    if (jump > MAX_JUMP) {
      console.log(tag + "跳过（市值跳变 " + jump.toFixed(1) + "% > " + MAX_JUMP
        + "%：旧 " + f.value + " → 新 " + value.toFixed(2) + "）");
      continue;
    }
  }

  results.push({ f, newest, prev, pendingShares, totalShares, value, day, pnl, rate });

  const sameNav = Math.abs(value - (f.value || 0)) < 0.005 && newest.d === old.closeDate;
  console.log(tag
    + (sameNav ? "无变化" : "更新")
    + " · 净值 " + (old.close || "-") + "@" + (old.closeDate || "-") + " → **" + newest.nav + "@" + newest.d + "**"
    + " · 市值 " + (f.value || 0).toFixed(2) + " → **" + value.toFixed(2) + "**"
    + " · 当日 " + day.toFixed(2)
    + (pendingShares > 0.001 ? " · 在途 " + pendingShares.toFixed(2) + " 份" : "")
    + (tc ? " · 腾讯校验 " + (tc.d === newest.d ? "✓" : "日期差 " + tc.d) : " · 腾讯校验 —"));
}

if (!results.length) {
  console.log("\n没有需要写回的（全部已是最新）");
  process.exit(0);
}

/* ── 写回：只改该只那一行的 5 个数字 + nav.close / closeDate ──────────── */
if (WRITE) {
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 16).replace("T", " ");
  const oldItems = (last && last.items) || {};
  let plDelta = 0;
  for (const r of results) {
    const { f, newest, value, day, pnl, rate } = r;
    const anchor = 'code: "' + f.code + '"';
    const i0 = src.indexOf(anchor);
    if (i0 < 0) { console.warn("  ⚠ 定位不到 " + f.code); continue; }

    /* ① 该行的 value / day / pnl / rate / upd（都在 code 之后、nav 之前） */
    const navPos = src.indexOf("nav: {", i0);
    const segEnd = navPos > i0 ? navPos : i0 + 900;
    let seg = src.slice(i0, segEnd);
    const before = seg;
    seg = seg.replace(/value: -?\d+(?:\.\d+)?/, "value: " + value.toFixed(2));
    seg = seg.replace(/day: -?\d+(?:\.\d+)?/, "day: " + day.toFixed(2));
    seg = seg.replace(/pnl: -?\d+(?:\.\d+)?/, "pnl: " + pnl.toFixed(2));
    seg = seg.replace(/rate: -?\d+(?:\.\d+)?/, "rate: " + rate.toFixed(2));
    seg = seg.replace(/upd: "[^"]*"/, 'upd: "' + stamp + '"');
    if (seg === before) { console.warn("  ⚠ " + f.code + " 的 value/day 没匹配到"); continue; }
    src = src.slice(0, i0) + seg + src.slice(segEnd);

    /* ② nav 块里的 close / closeDate（nav 紧随其后） */
    const n0 = src.indexOf("nav: {", i0);
    const n1 = src.indexOf("}", n0);
    if (n0 > 0 && n1 > n0) {
      let navSeg = src.slice(n0, n1);
      navSeg = navSeg.replace(/close: -?\d+(?:\.\d+)?/, "close: " + newest.nav);
      navSeg = navSeg.replace(/closeDate: "[^"]*"/, 'closeDate: "' + newest.d + '"');
      src = src.slice(0, n0) + navSeg + src.slice(n1);
    }
    /* ③ 同步最新快照的 items（val / pl）—— 见上面注释，不同步会让审计每天红 ✗ */
    /* ⚠ 快照的写法是 `{ d: "2026-11-26", cash: ...`（键**不带引号**）——
       第一版写成 `'"d": "'` 定位不到，静默什么都没改，审计照旧报错 ✗ */
    const sd = src.indexOf('{ d: "' + last.d + '"');
    if (sd > 0) {
      const ci = src.indexOf('"' + f.code + '": { name:', sd);
      if (ci > 0) {
        const ce = src.indexOf("}", ci);
        if (ce > ci) {
          let is = src.slice(ci, ce);
          const before2 = is;
          is = is.replace(/val: -?\d+(?:\.\d+)?/, "val: " + value.toFixed(2));
          is = is.replace(/pl: -?\d+(?:\.\d+)?/, "pl: " + pnl.toFixed(2));
          if (is !== before2) {
            const oldPl = Number.isFinite(oldItems[f.code] && oldItems[f.code].pl) ? oldItems[f.code].pl : null;
            if (oldPl !== null) plDelta += pnl - oldPl;
            src = src.slice(0, ci) + is + src.slice(ce);
          }
        }
      }
    }
    changed++;
  }

  /* ④ 快照的 Σpl 跟着改（items 变了但 Σpl 没变 → 「Σpl ≠ 记录值」✗） */
  if (Math.abs(plDelta) > 0.005) {
    const re2 = new RegExp('(\\{ d: "' + last.d + '", cash: [\\d.]+, pl: )(-?[\\d.]+)');
    if (re2.test(src)) {
      src = src.replace(re2, (mm, p1, p2) => p1 + (Number(p2) + plDelta).toFixed(2));
      console.log("  快照 " + last.d + " 的 Σpl " + plDelta.toFixed(2) + " → 已同步");
    } else {
      console.warn("  ⚠ 定位不到快照 " + last.d + " 的 pl 字段，Σpl 未同步");
    }
  }

  /* ⑤ OTC.updated = 各只里最新的那个净值日 */
  const newestDay = results.map((r) => r.newest.d).sort().at(-1);
  const uMatch = /^  updated: "[^"]*",/m.exec(src);
  if (uMatch && newestDay) {
    src = src.replace(/^  updated: "[^"]*",/m, '  updated: "' + newestDay + '",');
  }
  writeFileSync(FILE, src);
  console.log("\n已写回 " + changed + " 只 · OTC.updated → " + newestDay);
  console.log("⚠ 份额（qty）与成本（cost）没动 —— 那两项只有成交才会变，本脚本不碰 ✓");
} else {
  console.log("\n（dry-run，加 --write 才写回）");
}
