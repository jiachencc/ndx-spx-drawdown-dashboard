#!/usr/bin/env node
/* 补齐 data.js 的 BENCH（基准点位，供持仓页「收益率」视图画纳指对照线）。
 *
 * 数据来源（合并使用）：
 *   ① 在线 NDX 日线：scripts/fetch_and_update.mjs 的 series()（Yahoo ^NDX，失败自动退 Stooq）
 *   ② 兄弟仓库 fed-cycle-dashboard/data/series.json（本地开发常有，含 1996 起全史）
 *   合并规则：本地先放、在线覆盖同日（两者都是官方收盘，同日期一般只差舍入）。
 *
 * 为什么必须有 ①（2026-09-22 的教训）：CI 里没有兄弟仓库那个文件 ✗，
 *   而 workflow 给本脚本挂了 continue-on-error → 结果是**本地能补、CI 永远补不上**，
 *   表现为 GitHub Pages 上那条灰虚线停在上一期（本期就是这样断在 09-18 的）。
 *   现在改成自给自足：优先在线抓，CI 与本地同一套逻辑；抓不到才退回本地序列。
 *
 * 取值规则：对每个快照日期，取「截至该日的最新收盘」——非交易日自动落到前一个交易日
 *           （如 09-07 美国劳动节休市 → 取 09-04 收盘），这正是「躺平到那天能拿到的点位」。
 *
 * 原则：**只补缺失日期，已有值一律不覆盖**；序列末端早于待补日期时也不补 ——
 *       closeAt 会返回一个更早的旧点位，那不是「截至该日的最新收盘」
 *       （09-22 实测：series.json 停在 09-16 的 28,945.06，而 09-21 真值 30,482.35，差 5%）。
 *
 * 用法：
 *   node scripts/sync-bench.mjs            # 补齐并写回 data.js
 *   node scripts/sync-bench.mjs --dry      # 只打印将要补的内容，不写文件
 *   node scripts/sync-bench.mjs --offline  # 不联网，只用本地 series.json
 */
import fs from "node:fs";
import { isDate } from "./data-quality.mjs";
import { series as fetchBars } from "./fetch_and_update.mjs";

const DRY = process.argv.includes("--dry");
const OFFLINE = process.argv.includes("--offline");
const DATA = "data.js";
const SERIES = "fed-cycle-dashboard/data/series.json";
const SNAPS = "positions.html";

const readDates = () => {
  const src = fs.readFileSync(SNAPS, "utf8");
  const m = src.match(/const SNAPSHOTS = \[[\s\S]*?\n\];/);
  if (!m) throw new Error("positions.html 里找不到 SNAPSHOTS");
  return [...m[0].matchAll(/\bd:\s*"(\d{4}-\d{2}-\d{2})"/g)].map((x) => x[1]);
};

/* 本地序列：可缺、可坏，都只警告不中断（在线源才是主力） */
function readLocal() {
  if (!fs.existsSync(SERIES)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(SERIES, "utf8"));
    if (!Array.isArray(j.ndx)) throw new Error("没有 ndx 序列");
    const rows = j.ndx.map((x) => ({ d: x.d, c: x.c })).filter((x) => isDate(x.d) && Number.isFinite(x.c));
    return rows.length ? rows : null;
  } catch (e) {
    console.warn("⚠ 本地 " + SERIES + " 读取失败：" + e.message);
    return null;
  }
}

/* 在线序列：CI 里唯一可用的来源，失败不致命（有本地序列就继续） */
async function readOnline() {
  if (OFFLINE) return null;
  try {
    const raw = await fetchBars("^NDX", "^ndx", "10y");
    const rows = raw.dates.map((d, i) => ({ d, c: raw.close[i] })).filter((x) => isDate(x.d) && Number.isFinite(x.c));
    if (!rows.length) throw new Error("序列为空");
    console.log("在线 " + raw.source + "：" + rows.length + " 根，到 " + rows[rows.length - 1].d);
    return rows;
  } catch (e) {
    console.warn("⚠ 在线序列获取失败（" + e.message + "）→ 只用本地序列");
    return null;
  }
}

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

const local = readLocal();
const localLast = local && local.length ? local[local.length - 1].d : null;
/* 本地序列已覆盖全部快照日就不折腾网络：本机直连外网常受限，
   注意 Node 的 fetch **不认** https_proxy（那个变量是给 git / curl / npm 的），
   所以本机联不上就只能靠本地序列；真正依赖在线源的是 CI —— 那里没有兄弟仓库的 series.json。 */
const needOnline = !OFFLINE && (!localLast || dates.some((d) => d > localLast));
const online = needOnline ? await readOnline() : null;
if (!needOnline && !OFFLINE) console.log("本地序列已覆盖全部快照日（到 " + localLast + "），跳过在线抓取");
if (!local && !online) {
  console.error("本地与在线序列都拿不到，未写文件" + (OFFLINE ? "（--offline 且本地序列缺失）" : "（检查网络/代理）"));
  process.exit(1);
}

/* 合并：本地铺底，在线覆盖同日；最后按日期升序 —— closeAt 依赖升序 */
const merged = new Map();
for (const r of local || []) merged.set(r.d, r.c);
for (const r of online || []) merged.set(r.d, r.c);
const serie = [...merged.entries()].map(([d, c]) => ({ d, c })).sort((a, b) => (a.d < b.d ? -1 : 1));

/* 序列最后一条的日期：只有它 ≥ 待补日期时，「取 ≤d 的最新收盘」才真的等于「截至该日的最新收盘」 */
const seriesLast = serie.length ? serie[serie.length - 1].d : null;
const added = [], uncovered = [];
dates.forEach((d) => {
  if (have[d] !== undefined) return;
  if (!seriesLast || d > seriesLast) { uncovered.push(d); return; }
  const c = closeAt(serie, d);
  if (c === null) return;
  have[d] = c;
  added.push([d, c]);
});

console.log("快照日期 " + dates.length + " 个，已有基准 " + Object.keys(bm[1].match(/"\d{4}-\d{2}-\d{2}"/g) || []).length + " 个，本次补 " + added.length + " 个" +
  "（序列 " + serie.length + " 根" + (seriesLast ? "，到 " + seriesLast : "") + "）");
added.forEach(([d, c]) => console.log("  + " + d + "  NDX " + c.toFixed(2)));
if (uncovered.length) console.log("⚠ 序列末端（" + seriesLast + "）早于这些快照日，**不补**：" + uncovered.join("、") +
  "\n   → 这几天的点位请人工记入（可用 data.js 的 DEFAULT.ndx.close），或等序列更新后再跑本脚本。");

const missing = dates.filter((d) => have[d] === undefined);
if (missing.length) console.log("⚠ 序列未覆盖，仍缺：" + missing.join("、"));

if (!added.length || DRY) {
  if (DRY) console.log("--dry：未写入");
  else console.log("无变化，未写入");
  process.exit(0);
}

/* 只插入缺失行，不重写整块 —— BENCH 里有人写的注释（休市说明、"别用本脚本补这几天"的警告）
   和手调的排版，重写一次就全没了；数值也保持原样输出，避免 29507.70 → 29507.7 这种无意义 diff。
   插入位置：最后一个日期早于新日期的条目之后（注释行不参与比较，免得把注释和它解释的条目拆开）。 */
const lines = bm[1].split("\n");
const dateOf = (l) => { const m = l.match(/^\s*"(\d{4}-\d{2}-\d{2})":/); return m ? m[1] : null; };
for (const [d, c] of added) {
  let at = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) { const x = dateOf(lines[i]); if (x && x < d) { at = i + 1; break; } }
  lines.splice(at, 0, '  "' + d + '": ' + c + ",");
}
fs.writeFileSync(DATA, src.replace(blockRe, () => "const BENCH = {" + lines.join("\n") + "\n};"));
console.log("✓ 已插入 " + added.length + " 行并写回 " + DATA + "（原注释与排版保持不动）");
