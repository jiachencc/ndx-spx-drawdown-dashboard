#!/usr/bin/env node
/* 对比度门禁（2026-10-16 加）—— 起因：用户问「深色主题的 UI/配色要调什么」，
   一查才发现**深色从未被验证过**：本页主题规则是「深色为基座、body.light 覆盖、默认跟随系统」，
   而 Playwright 默认 prefers-color-scheme 是 light ✗ → 截图与 layout-check 一直只跑浅色 ✗✗。
   用户日常主要用深色 → 他天天看的那个主题零覆盖。这条门禁把两套主题的**可读性**都钉住 ✓。

判据（WCAG 2.1）：
  · 文字 ≥ 4.5:1 —— ⚠ 本页最大字号 15px、KPI 数值 13px 粗，**都不算** WCAG 的「大号文字」
    （需 ≥18.66px 粗 或 ≥24px），所以全页按 4.5 的严标准 ✓ 别给自己开后门 ✗
  · 非文字图形（游标 / 买点 / 卖出圈 / 轴刻度）≥ 3:1
被排除在外的（有意，不是漏了）：区间带的 α 填充、轨道底色、分隔线 —— 装饰性，且信息另有端点
  标签与游标承担 ✓（轨道硬追 3:1 需要在深色卡上画一道亮框 ✗，与整页气质冲突）。

用法：node scripts/check-contrast.mjs [--diag]
退出码 0 = 全部达标；1 = 有未达标项（会逐条给出实测值与建议方向）。
*/
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const diag = process.argv.includes("--diag");

const toRgb = (h) => {
  const s = String(h).trim().replace("#", "");
  const f = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  if (!/^[0-9a-fA-F]{6}$/.test(f)) return null;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};
const blend = (fg, a, bg) => fg.map((c, i) => Math.round(a * c + (1 - a) * bg[i]));
const lum = (rgb) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
const cr = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const hex = (rgb) => "#" + rgb.map((x) => x.toString(16).padStart(2, "0")).join("");
const f2 = (x) => x.toFixed(2);

/* ---- 令牌解析：把 tokens.css + positions.css 里 :root / body.light 两块的声明合成两套表 ---- */
function collect(file, sel) {
  const out = {};
  const lines = readFileSync(path.join(root, file), "utf8").split("\n");
  let inBlock = null;
  for (const raw of lines) {
    const line = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    if (inBlock === null) {
      const m = line.match(/^\s*([^@{}]*?)\s*\{/);
      if (!m) continue;
      const s = m[1].trim();
      inBlock = (s === ":root" || s === sel) ? s : false;   // false = 进了别的块，忽略其内容
      continue;
    }
    if (/^\s*\}/.test(line)) { inBlock = null; continue; }
    if (!inBlock) continue;
    const d = line.match(/^\s*(--[a-z0-9-]+):\s*([^;]+);/i);
    if (d) out[d[1]] = d[2].trim();
  }
  return out;
}
const RAW = collect("tokens.css", "__none__");                 // 调色板（:root）
const DARK = Object.assign({}, RAW, collect("positions.css", "__none__"));      // 深色 = 基座
const LIGHT = Object.assign({}, DARK, collect("positions.css", "body.light")); // 浅色 = 覆盖

/* var() 解析（本页最多一层，如 --up: var(--green)；解析不到就报错，别静默给个假值 ✗） */
function makeResolver(map, themeName) {
  return (name) => {
    let v = map[name];
    const seen = new Set();
    while (typeof v === "string" && /^var\(/.test(v)) {
      const inner = v.match(/^var\(\s*(--[a-z0-9-]+)\s*\)/i);
      if (!inner || seen.has(inner[1])) break;
      seen.add(inner[1]);
      v = map[inner[1]];
    }
    if (v === undefined) { bad.push(themeName + " 缺令牌 " + name); return null; }
    return toRgb(v);
  };
}
const bad = [];
const RES = { "深色": makeResolver(DARK, "深色"), "浅色": makeResolver(LIGHT, "浅色") };

/* ---- 断言表 ---- */
const TEXT = ["--tx", "--tx2", "--tx3", "--up", "--down", "--yellow", "--blue", "--cyan"];
const GRAPHIC = ["--up", "--down", "--cyan", "--tx", "--yellow"];
const issues = [];
const rows = [];
for (const theme of ["深色", "浅色"]) {
  const R = RES[theme];
  const card = R("--card"), card2 = R("--card2");
  if (!card || !card2) continue;
  for (const t of TEXT) {
    for (const [bgName, bg] of [["--card", card], ["--card2", card2]]) {
      const c = R(t); if (!c) continue;
      const v = cr(c, bg);
      rows.push([theme, t + " on " + bgName, v, 4.5]);
      if (v < 4.5) issues.push(theme + "：" + t + " 在 " + bgName + " 上只有 " + f2(v) + ":1（文字要 ≥ 4.5）");
    }
  }
  for (const g of GRAPHIC) {
    const c = R(g); if (!c) continue;
    const v = cr(c, card);
    rows.push([theme, g + "（图形）on --card", v, 3]);
    if (v < 3) issues.push(theme + "：" + g + " 在 --card 上只有 " + f2(v) + ":1（图形要 ≥ 3）");
  }
}

/* ---- 轴刻度：从 CSS 规则里**实际读**它的颜色与透明度（改坏了要能拦住 ✗）---- */
const css = readFileSync(path.join(root, "positions.css"), "utf8");
const rule = (sel) => {
  const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  return m ? m[1] : null;
};
const tickBody = rule(".bar-track .bar-tick");
if (!tickBody) issues.push("找不到 .bar-track .bar-tick 规则 —— 轴刻度被改名/删除，本条门禁已失效 ✗（请同步本文件）");
else {
  const tok = (tickBody.match(/background:\s*var\((--[a-z0-9-]+)\)/i) || [])[1];
  const op = parseFloat((tickBody.match(/opacity:\s*([\d.]+)/i) || [])[1]);
  if (!tok || !Number.isFinite(op)) issues.push(".bar-track .bar-tick 规则里读不到 background: var(--x) / opacity —— 门禁失效 ✗");
  else for (const theme of ["深色", "浅色"]) {
    const fg = RES[theme](tok), track = RES[theme]("--line-soft");
    if (!fg || !track) continue;
    const eff = blend(fg, op, track);
    const v = cr(eff, track);
    rows.push([theme, "轴刻度 " + tok + " " + (op * 100) + "% on --line-soft", v, 3]);
    if (v < 3) issues.push(theme + "：轴刻度（" + tok + " " + (op * 100) + "% 压在 --line-soft 上）只有 " + f2(v) +
      ":1（图形要 ≥ 3）—— 刻度是「分位」的参照，看不见等于没有");
  }
}

/* ---- 买点：淡填充必须靠**全色描边**兜底（这是时间三档能在两套主题都过 3:1 的唯一理由）----
   ⚠ 这条查的是**结构**而不是数值：只调 α 永远过不了（深色 30% → 1.94:1、浅色 30% → 1.40:1，
   加到 100% 也只有 3.23 ✗）→ 一旦有人把描边删掉、退回纯 α，这条必须报 ✗ */
const dotBody = rule(".buy-mark b");
if (!dotBody) issues.push("找不到 .buy-mark b 规则 —— 买点样式被改名/删除，本条门禁已失效 ✗");
else if (!/inset\s+0\s+0\s+0\s+1px\s+var\(--up\)/.test(dotBody))
  issues.push(".buy-mark b 丢了「inset 0 0 0 1px var(--up)」实心描边 ✗ —— 淡填充（--up-line 30%）在深色底上只有 " +
    "1.94:1、浅色底上 1.40:1，全靠这圈描边把它拉到 3:1 以上 ✓（同时 .t-mid 那一档也要有）");
if (!/inset\s+0\s+0\s+0\s+1px\s+var\(--up\)/.test(rule(".buy-mark.t-mid b") || ""))
  issues.push(".buy-mark.t-mid b 也必须有同一条实心描边（中档填充 --up-fill 60% 在浅色底上仍不到 3:1）✗");
const sellBody = rule(".sell-mark b") || "";
if (!/border:\s*1\.5px\s+solid\s+var\(--down\)/.test(sellBody))
  issues.push(".sell-mark b 的边框必须是**全色** var(--down) ✗ —— 空心圈的可见度只由边框色决定，" +
    "边框一淡化就直接掉到 2:1 以下（实测 --down-line 30% = 1.94:1）");

/* ---- 输出 ---- */
if (diag || issues.length) {
  console.log("对比度实测（深/浅两套主题）：");
  for (const [theme, what, v, need] of rows)
    console.log("  " + (v >= need ? "✓" : "✗") + " " + theme + "  " + what.padEnd(38) + f2(v) + ":1  (需 " + need + ":1)");
}
if (bad.length) { console.error("\n令牌解析失败：\n  - " + bad.join("\n  - ") + "\n（令牌改名/搬家时请同步 scripts/check-contrast.mjs ✗）"); process.exit(1); }
if (issues.length) {
  console.error("\n对比度门禁未通过（" + issues.length + " 项）：\n" + issues.map((s) => "  - " + s).join("\n"));
  process.exit(1);
}
console.log("对比度：两套主题 × 文字 " + TEXT.length + " 色 × 卡片/嵌套面 ＋ 图形 —— 全部达标 ✓" +
  "（深色 " + DARK["--tx"] + " 基座 / 浅色 " + LIGHT["--tx"] + " 覆盖；文字 ≥4.5 · 图形 ≥3，判据见本文件头）");
