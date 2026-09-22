#!/usr/bin/env node
/* 本地渲染快照：把 positions.html / index.html 按「桌面 + 手机」两种宽度渲染出来，
 * 逐个卡片截图，并扫一遍渲染结果里有没有非法图元坐标。
 *
 * 为什么需要这个（2026-09-22 的教训）：浮点拼接成 "935.921.10…" 这类错误，
 *   在纯文本测试里完全看不见（函数返回的是字符串、断言也能通过），
 *   但浏览器会把解析失败的坐标按 0 处理 → 图上冒出一大片横跨全屏的错位填充。
 *   当时是靠肉眼在截图里发现的，排查花了半小时；这个脚本把「看一眼」变成一条命令。
 *
 * 依赖（本地工具，CI 不跑、门禁不依赖）：Playwright
 *   npm i -g playwright && npx playwright install chromium
 *
 * 用法：
 *   node scripts/screenshot.mjs                    # 输出到 outputs/review/
 *   node scripts/screenshot.mjs --out /tmp/shots   # 换个目录
 *   node scripts/screenshot.mjs --only trend       # 只截指定的卡片（名字见 CARDS）
 *   node scripts/screenshot.mjs --page index       # 只截 index.html
 *
 * 退出码：0 = 渲染正常；1 = 发现非法坐标或页面报错（适合挂到本地脚本/钩子里）。
 */
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const outDir = path.resolve(root, argOf("--out", "outputs/review"));
const onlyCards = argOf("--only", "").split(",").filter(Boolean);
const onlyPages = argOf("--page", "").split(",").filter(Boolean);

/* 两种宽度：桌面看信息密度、手机看断行与横向溢出（历史上窄屏挤字改过一版） */
const VIEWPORTS = [
  { tag: "desktop", width: 1440, height: 1000 },
  { tag: "mobile", width: 390, height: 844 },
];
/* 卡片名 → 选择器。整页图（<page>-<viewport>.png）之外，卡片图便于逐张对比改动前后。 */
const CARDS = {
  trend: "#trend-box",          // 资产走势：填充/折线最容易出非法坐标的地方
  sum: "#sum-grid",             // 汇总：总资产 / 浮盈亏
  principal: "#sec-principal",  // 本金与收益（含折叠区）
  snap: "#sec-snap",            // 快照对比：14 期，最长的一张
  pos: "#pos-list",             // 成交流水
};

/* Playwright 装在哪都可能：本项目刻意不引入 npm 依赖（CI 不跑 npm install），
   所以先试常规解析，再回退到全局包目录 —— ESM 不认 NODE_PATH，只能用绝对路径引。 */
async function loadChromium() {
  for (const spec of ["playwright", await globalSpec()]) {
    if (!spec) continue;
    try {
      const m = await import(spec);
      const c = m.chromium || (m.default && m.default.chromium);
      if (c) return c;
    } catch { /* 换下一个候选 */ }
  }
  return null;
}
async function globalSpec() {
  try {
    const { execSync } = await import("node:child_process");
    const g = execSync("npm root -g", { encoding: "utf8" }).trim();
    return pathToFileURL(path.join(g, "playwright", "index.js")).href;
  } catch { return null; }
}

const chromium = await loadChromium();
if (!chromium) {
  console.error("未找到 Playwright。先装一次：npm i -g playwright && npx playwright install chromium");
  process.exit(2);
}

/* 在页面里扫非法图元坐标：SVG 属性里出现 NaN / Infinity / undefined 就是渲染事故 */
const SCAN = () => {
  const bad = [];
  document.querySelectorAll("svg *").forEach((el) => {
    for (const a of el.attributes) {
      if (/NaN|Infinity|undefined/.test(a.value)) {
        bad.push(el.tagName.toLowerCase() + "[" + a.name + "=" + a.value.slice(0, 70) + "]");
      }
    }
  });
  const t = document.querySelector("#trend-box svg");
  return {
    badCount: bad.length,
    bad: bad.slice(0, 6),
    trendSvg: !!t,
    polygons: t ? t.querySelectorAll("polygon").length : 0,
    paths: t ? t.querySelectorAll("path").length : 0,
  };
};

const pages = (onlyPages.length ? onlyPages : ["positions", "index"]).map((p) => ({ tag: p, file: p + ".html" }));
const cards = Object.entries(CARDS).filter(([name]) => !onlyCards.length || onlyCards.includes(name));

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
let problems = 0;

for (const pg of pages) {
  const url = pathToFileURL(path.join(root, pg.file)).href;
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 160)); });

    await page.goto(url, { waitUntil: "load" });
    /* 页面首屏是同步渲染的，但图表卡依赖 devicePixelRatio / ResizeObserver，给一拍缓冲 */
    await page.waitForTimeout(600);

    const scan = await page.evaluate(SCAN);
    const full = path.join(outDir, pg.tag + "-" + vp.tag + ".png");
    await page.screenshot({ path: full, fullPage: true });
    console.log(pad(pg.tag + " " + vp.tag) + " 整页 → " + rel(full) + "  " + kb(full));

    if (scan.badCount || errors.length) {
      problems += scan.badCount + errors.length;
      console.log("  ⚠ 非法坐标 " + scan.badCount + " 处" + (scan.bad.length ? "：" + scan.bad.join(" | ") : ""));
      errors.slice(0, 4).forEach((e) => console.log("  ⚠ " + e));
    } else {
      console.log("  ✓ 图元坐标正常（走势卡 polygon " + scan.polygons + " / path " + scan.paths + "）");
    }

    for (const [name, sel] of cards) {
      const el = page.locator(sel).first();
      if (await el.count() === 0) continue;
      /* 元素截图会自动滚动到可视区并裁剪——这正是 agent-browser 做不到的那一步 */
      const out = path.join(outDir, "card-" + name + "-" + vp.tag + ".png");
      try {
        await el.screenshot({ path: out, timeout: 5000 });
        console.log("      · " + pad(name, 12) + rel(out) + "  " + kb(out));
      } catch (e) {
        problems++;
        console.log("      · " + name + " 截图失败：" + String(e.message).split("\n")[0]);
      }
    }
    await ctx.close();
  }
}

await browser.close();
console.log(problems ? "\n发现 " + problems + " 个问题（非法坐标 / 页面报错 / 截图失败）" : "\n渲染正常，产物在 " + rel(outDir));
process.exit(problems ? 1 : 0);

function pad(s, n = 16) { return String(s).padEnd(n); }
function rel(p) { return path.relative(root, p); }
function kb(p) { try { return Math.round(statSync(p).size / 1024) + "KB"; } catch { return "?"; } }
