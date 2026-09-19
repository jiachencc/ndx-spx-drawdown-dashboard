#!/usr/bin/env node
/* 补齐 data.js 的 BENCH（基准点位，供持仓页「收益率」视图画纳指对照线）。
 *
 * 数据来源：fed-cycle-dashboard/data/series.json 里已存的 NDX 日线（1996 起，每日更新）。
 * 取值规则：对每个快照日期，取「截至该日的最新收盘」——非交易日自动落到前一个交易日
 *           （如 09-07 美国劳动节休市 → 取 09-04 收盘），这正是「躺平到那天能拿到的点位」。
 *
 * 原则：**只补缺失日期，已有值一律不覆盖**。序列文件可能滞后（落盘早于当日收盘），
 *       人工/官方读数更可信，不能被它冲掉。
 *
 * 用法：
 *   node scripts/sync-bench.mjs          # 补齐并写回 data.js
 *   node scripts/sync-bench.mjs --dry    # 只打印将要补的内容，不写文件
 */
import fs from "node:fs";

const DRY = process.argv.includes("--dry");
const DATA = "data.js";
const SERIES = "fed-cycle-dashboard/data/series.json";
const SNAPS = "positions.html";

const readDates = () => {
  const src = fs.readFileSync(SNAPS, "utf8");
  const m = src.match(/const SNAPSHOTS = \[[\s\S]*?\n\];/);
  if (!m) throw new Error("positions.html 里找不到 SNAPSHOTS");
  return [...m[0].matchAll(/\bd:\s*"(\d{4}-\d{2}-\d{2})"/g)].map((x) => x[1]);
};
const readSeries = () => {
  if (!fs.existsSync(SERIES)) throw new Error("缺少 " + SERIES);
  const j = JSON.parse(fs.readFileSync(SERIES, "utf8"));
  if (!Array.isArray(j.ndx)) throw new Error("series.json 里没有 ndx 序列");
  return j.ndx;
};
const closeAt = (series, d) => {
  let v = null;
  for (const x of series) { if (x.d <= d) v = x.c; else break; }
  return v;
};

const src = fs.readFileSync(DATA, "utf8");
const blockRe = /const BENCH = \{([\s\S]*?)\n\};/;
const bm = src.match(blockRe);
if (!bm) throw new Error("data.js 里找不到 const BENCH = {…};");

const have = {};
[...bm[1].matchAll(/"(\d{4}-\d{2}-\d{2})":\s*([\d.]+)/g)].forEach((m) => { have[m[1]] = +m[2]; });
const dates = readDates();
const series = readSeries();

const added = [];
dates.forEach((d) => {
  if (have[d] !== undefined) return;
  const c = closeAt(series, d);
  if (c === null) return;
  have[d] = c;
  added.push([d, c]);
});

console.log("快照日期 " + dates.length + " 个，已有基准 " + Object.keys(bm[1].match(/"\d{4}-\d{2}-\d{2}"/g) || []).length + " 个，本次补 " + added.length + " 个");
added.forEach(([d, c]) => console.log("  + " + d + "  NDX " + c.toFixed(2)));

const missing = dates.filter((d) => have[d] === undefined);
if (missing.length) console.log("⚠ 序列未覆盖，仍缺：" + missing.join("、") + "（等 series.json 更新后再跑一次）");

if (!added.length || DRY) {
  if (DRY) console.log("--dry：未写入");
  else console.log("无变化，未写入");
  process.exit(0);
}

const body = Object.keys(have).sort().map((d) => '  "' + d + '": ' + have[d] + ",").join("\n");
fs.writeFileSync(DATA, src.replace(blockRe, "const BENCH = {\n" + body + "\n};"));
console.log("✓ 已写回 " + DATA);
