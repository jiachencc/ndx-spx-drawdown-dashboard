#!/usr/bin/env node
/* 版面检查（**真实浏览器** · playwright）—— 2026-10-09 建
 *
 * 为什么需要它 ✗：dom-check 跑在 **jsdom** 里 ✓ —— 没有布局引擎 ✗（clientWidth 恒 0 ✓），
 *   所以"元素撑破容器 / 页面横向溢出"这类**真实版面**问题它一条都抓不到 ✗。
 * 这次的由来 ✓：#acct-card 的月度盈亏图按 718px 画好后**不随窗口缩放重绘** ✗ ——
 *   从 1440 拖到 380 时页面横向溢出 **367px** ✗（＝718−344 ✓），而且**与本轮其它改动无关** ✓
 *   （不打开归因视图也能复现 ✓）。修完之后加这条探针，防止同类问题再溜进来 ✓。
 *
 * 断言（都只有真实布局才测得出来 ✓）：
 *   ① 1440 / 760 / 380 三档**首次加载**：页面无横向溢出 ✓
 *   ② 每个 <svg> 的宽度 ≤ 其容器的 clientWidth ✓（溢出 367px 时的直接症状 ✓）
 *   ③ 1440 → 380 **拖动缩放**后：无横向溢出 ＋ SVG 不超容器 ✓ ← 那个 bug 的回归探针 ✓
 *   ④ 380 → 1440 拖回后：无横向溢出 ✓（只增不减的另一种坏法 ✓）
 *   ⑤ 380px 下顺带把**按需渲染**的归因视图点亮（列头图也按真实像素画 ✓ → 一并纳入检查 ✓）
 *
 * 依赖：playwright（全局 ✓，与 dom-check 同一约定 ✓）—— 没装时由 verify-all **跳过**并说明 ✓，
 *   不让环境问题挡住提交 ✓。
 */
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = pathToFileURL(path.join(root, "positions.html")).href;
const gp = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const pw = await import(pathToFileURL(path.join(gp, "playwright", "index.js")).href);
const chromium = pw.chromium || pw.default.chromium;

const checks = [];
const check = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail || "" });

/* 一次"版面体检"：页面横向溢出 ＋ 每个 SVG 是否超出它的容器 ✓
   （用 getBoundingClientRect 与实际 clientWidth 比 ✓ —— 不靠肉眼、不看截图 ✓） */
const audit = (p) => p.evaluate(() => {
  const iw = window.innerWidth;
  const bad = [];
  document.querySelectorAll("svg").forEach((s) => {
    const c = s.parentElement;
    if (!c || !c.clientWidth) return;
    const w = s.getBoundingClientRect().width;
    if (w > c.clientWidth + 1)
      bad.push((c.id || String(c.className || "?")).split(" ")[0] + "：SVG " + Math.round(w) + " > 容器 " + c.clientWidth);
  });
  /* 图内元素**不得越出画布**（2026-10-10 加）—— 起因：归因列头图里「起点 +6,443」这个标签
     右对齐挂在绘图区左边界外 ✓ → 窄屏**越界出画布 5px** ✗ 被裁掉 ✗（用户报「折线图有遮挡」✓）。
     这类问题只有真实布局测得出 ✗（jsdom 的 getBoundingClientRect 全是 0 ✓）→ 做成常驻断言 ✓。 */
  const out = [];
  document.querySelectorAll("#snap-attr .sa-chart-svg").forEach((s) => {
    const sr = s.getBoundingClientRect();
    s.querySelectorAll("text, circle, rect, polyline").forEach((e) => {
      const q = e.getBoundingClientRect();
      if (q.width <= 0 && q.height <= 0) return;
      const over = Math.max(sr.left - q.left, q.right - sr.right, sr.top - q.top, q.bottom - sr.bottom);
      if (over > 0.5)
        out.push(e.tagName + "「" + (e.textContent || "").trim().slice(0, 8) + "」越界 " + Math.round(over) + "px");
    });
  });
  return { ov: document.documentElement.scrollWidth - iw, bad: bad, out: out, nSvg: document.querySelectorAll("svg").length };
});

/* 把按需渲染的归因视图也点亮（列头图是真实像素画的 ✓ 必须一起查 ✓）——
   用「目标元素已画出」当信号，替代固定 waitForTimeout(250) ✗（归因矩阵/列头图都在点击处理里同步渲染 ✓） */
const openAttr = async (p) => {
  await p.evaluate(() => {
    const b = [...document.querySelectorAll("#snap-switch .vs-btn")].find((v) => v.dataset.view === "attr");
    if (b) b.click();
  });
  await p.waitForFunction(() => !!document.querySelector("#snap-attr table.sa-mx"), { timeout: 3000 }).catch(() => {});
  await p.evaluate(() => {
    const th = document.querySelectorAll("#snap-attr thead th")[2];
    if (th) th.click();
  });
  await p.waitForFunction(() => {
    const s = document.querySelector("#snap-attr .sa-chart-svg");
    return !!(s && s.getBoundingClientRect().width > 0);
  }, { timeout: 3000 }).catch(() => {});
};

const browser = await chromium.launch();
const errs = [];

/* 就绪信号：等页面**真正画出图**（#trend-box 里有 svg 且非零宽）再测 ——
   替代原来的固定 waitForTimeout(900) ✗：本地 file:// 页面在 load 事件后内联脚本已同步渲染完，
   900ms 是纯空等（三档 ＋ 拖动页 ＝ 4×900 ＝ 3.6s 白等 ✗）。用信号等，画完即测 ✓。
   信号没等到也不硬报 ✗ —— audit 自己会量出真实值，等不到只是少了那次测量、不影响判定 ✓。 */
const waitReady = (p) => p.waitForFunction(() => {
  const svg = document.querySelector("#trend-box svg");
  const grid = document.getElementById("sum-grid");
  return !!(svg && svg.getBoundingClientRect().width > 0 && grid && grid.children.length > 0);
}, { timeout: 5000 }).catch(() => {});

/* ① 三档首屏 */
for (const w of [1440, 760, 380]) {
  const p = await browser.newPage({ viewport: { width: w, height: 1000 } });
  p.on("pageerror", (e) => errs.push(w + "px " + e.message));
  await p.goto(page, { waitUntil: "load" });
  await waitReady(p);
  if (w === 380) await openAttr(p);
  const r = await audit(p);
  check("首屏 " + w + "px：页面无横向溢出" + (w === 380 ? "（含归因列头图 ✓）" : ""), r.ov <= 0,
    r.ov > 0 ? "溢出 " + r.ov + "px" : "溢出 0px ✓");
  check("首屏 " + w + "px：每个 SVG 都不超出容器（共 " + r.nSvg + " 个）", r.bad.length === 0, r.bad.slice(0, 3).join(" · "));
  /* 只在 380 档查"图内元素越界" ✓：那一档才把按需渲染的列头图打开 ✓（没图时查了也是空 ✓ 假绿 ✗） */
  if (w === 380)
    check("首屏 380px：图内元素不越出画布（列头图已打开 ✓）", r.out.length === 0, r.out.slice(0, 3).join(" · "));
  await p.close();
}

/* ③④ 拖动缩放（那个 bug 的回归探针 ✓） */
{
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  p.on("pageerror", (e) => errs.push("resize " + e.message));
  await p.goto(page, { waitUntil: "load" });
  await waitReady(p);
  const a = await audit(p);
  check("拖动前 1440px：无横向溢出", a.ov <= 0, a.ov > 0 ? "溢出 " + a.ov + "px" : "溢出 0px ✓");
  await p.setViewportSize({ width: 380, height: 1000 });
  await p.waitForTimeout(300);   // 页内 resize 防抖 150ms 后重绘 → 留 300ms 余量 ✓（原 700 ✗ 空等翻倍）
  const b2 = await audit(p);
  check("1440 → 380 拖动缩放后：页面无横向溢出", b2.ov <= 0,
    b2.ov > 0 ? "溢出 " + b2.ov + "px（图没重绘 ✗ 就是这次的 bug ✓）" : "溢出 0px ✓");
  check("1440 → 380 拖动缩放后：每个 SVG 都不超出容器", b2.bad.length === 0, b2.bad.slice(0, 3).join(" · "));
  await p.setViewportSize({ width: 1440, height: 1000 });
  await p.waitForTimeout(300);
  const c2 = await audit(p);
  check("380 → 1440 拖回后：页面无横向溢出", c2.ov <= 0, c2.ov > 0 ? "溢出 " + c2.ov + "px" : "溢出 0px ✓");
  await p.close();
}
await browser.close();
check("版面检查过程无 JS 报错", errs.length === 0, errs.slice(0, 2).join(" | "));

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log((c.ok ? "  ✓ " : "  ✗ ") + c.name + (c.detail && !c.ok ? "   ← " + c.detail : ""));
}
console.log("\n版面校验：" + (checks.length - failed) + "/" + checks.length + " 通过（真实浏览器 · 1440/760/380 三档 ＋ 拖动缩放）");
process.exit(failed ? 1 : 0);
