#!/usr/bin/env node
/* 一条命令跑全部门禁（2026-10-06 加）
 *
 * 为什么需要：此前门禁散在 7 处（check-data / check-finance / check-fed / cross-check /
 *   dom-check / lint / test-dashboard），pre-commit 钩子手写串联、CI 又另有一套 →
 *   两处容易不一致 ✗，且每次人工验证要手打 6~7 条命令。
 *
 * 设计三条：
 *   ① 单一真源：钩子与 CI 都调本文件；以后新增门禁**只改这里一处**
 *   ② 工具缺失即跳过、不阻断：eslint 是本地工具（lint.mjs 自己声明"CI 与门禁不依赖"）、
 *      playwright 需全局安装 → 缺了就打印"跳过 + 原因"，不让环境问题挡住提交 ✓
 *   ③ 逐项报时与结论；任一非 0 → 整体 exit 1（钩子据此拦提交）
 *
 * 用法：node scripts/verify-all.mjs [--deep]      （--deep 追加 typecheck）
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const DEEP = process.argv.includes("--deep");
const has = (cmd) => { try { execFileSync("sh", ["-c", "command -v " + cmd], { stdio: "ignore" }); return true; } catch (e) { return false; } };
const hasPlaywright = () => { try { const gp = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(); return existsSync(gp + "/playwright"); } catch (e) { return false; } };
/* jsdom：dom-check 的真依赖（2026-10-12 加 —— 见下面 dom-check 那一步的注释 ✓） */
const hasJsdom = () => { try { const gp = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(); return existsSync(gp + "/jsdom") || existsSync("node_modules/jsdom"); } catch (e) { return false; } };

const steps = [
  ["check-data（schema ＋ 全部历史快照）", ["node", ["scripts/check-data.mjs"]]],
  ["check-finance（财务矩阵四条恒等式）", ["node", ["scripts/check-finance.mjs"]]],
  ["check-fed（加息周期看板数据）", ["node", ["scripts/check-fed.mjs"]]],
  /* 2026-10-12 第三批加：色板/字体栈收进 tokens.css 后，防止有人（或复制粘贴）又抄回各页 ✗ */
  ["check-tokens（跨页令牌唯一出处）", ["node", ["scripts/check-tokens.mjs"]]],
  /* 2026-10-16 加：两套主题的**对比度**（文字 ≥4.5 · 图形 ≥3）。
     为什么需要它：主题规则是「深色为基座、body.light 覆盖」，而 Playwright 默认跑在浅色 ✗ ——
     截图与 layout-check 一直只覆盖浅色，用户主用的深色从没验过 ✗。这条纯算数、不依赖浏览器 ✓ */
  ["check-contrast（深浅两套主题对比度）", ["node", ["scripts/check-contrast.mjs"]]],
  ["cross-check（跨文件一致性）", ["node", ["scripts/cross-check.mjs"]]],
  ["regression（回归测试）", ["node", ["--test", "scripts/test-dashboard.mjs"]]],
  ["inline-compile（页面内联脚本可编译）", ["node", ["--input-type=module", "-e",
    "import{readFileSync}from\x27node:fs\x27;for(const f of [\x27index.html\x27,\x27positions.html\x27,\x27finance/index.html\x27,\x27fed-cycle/index.html\x27]){const h=readFileSync(f,\x27utf8\x27);const m=[...h.matchAll(/<script\\b(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)<\\/script>/gi)].map(x=>x[1]).join(String.fromCharCode(10)+\x27;\x27+String.fromCharCode(10));new Function(m);}"]]],
  has("eslint") ? ["eslint（7 个检查单元）", ["node", ["scripts/lint.mjs", "--quiet"]]]
    : ["eslint", null, "跳过：未安装 eslint（本地工具，CI 与门禁不依赖）"],
  /* ⚠ 2026-10-12 纠偏：dom-check 跑在 **jsdom** 里（见其头注释"依赖：jsdom"✓），
     此前却用 hasPlaywright() 判它 ✗ —— 只装 jsdom 没装 playwright 时它会被**静默跳过** ✗
     （"门禁假绿"：看着跑了，其实没跑）。判据与依赖对齐：谁被用，就判谁 ✓ */
  hasJsdom() ? ["dom-check（页面 DOM 断言）", ["node", ["scripts/dom-check.mjs"]]]
    : ["dom-check", null, "跳过：未找到 jsdom（npm i -g jsdom）"],
  /* 2026-10-09 加：dom-check 跑在 jsdom 里（没有布局 ✗），
     "元素撑破容器 / 页面横向溢出"这类**真实版面**问题它抓不到 ✗ —— 见 layout-check.mjs 头的由来 ✓ */
  /* ⚠ 2026-10-16：**深浅各跑一遍** —— 主题基座是深色、浅色是覆盖层，而 Playwright 默认跑浅色 ✗，
     此前 20 条版面检查只覆盖浅色，用户主用的深色从没验过（同一天补的 check-contrast 管颜色、
     这一条管版面：深色下的断行 / 溢出 ✓）。代价 ~3s，值得 ✓ */
  hasPlaywright() ? ["layout-check 浅色（真实版面 · 无横向溢出）", ["node", ["scripts/layout-check.mjs"]]]
    : ["layout-check", null, "跳过：未找到全局 playwright"],
  /* ⚠ 2026-10-17 修：这里原来漏写 else 分支（`: null`），CI 上没有全局 playwright →
     steps 里出现 null → 下面 map 解构直接 TypeError，**整个 validate job 9 秒挂掉**。
     本地有 playwright、永远走 true 分支，所以本地一直是绿的 ✗（连挂 4 次 CI 才被发现）。
     现在与上一条同款：缺依赖就给带 skip 说明的三元组，绝不返回 null。 */
  hasPlaywright() ? ["layout-check 深色（同上 · 用户主用主题）", ["node", ["scripts/layout-check.mjs", "--dark"]]]
    : ["layout-check 深色", null, "跳过：未找到全局 playwright"],
];
if (DEEP) steps.push(["typecheck（深度）", ["node", ["scripts/typecheck.mjs"]]]);

let fail = 0;
console.log("═══ 门禁总检（scripts/verify-all.mjs）═══");
/* ⚠ 并行跑（2026-10-12 提速 ✓）：各门禁互不依赖、都只读文件/各自起进程 ✓ ——
   墙钟 ≈ 最慢那项、而不是相加 ✓（串行时 dom-check 2.9s ＋ layout-check 6.7s ＝ 9.6s ✗ → 并行 ≈ 6.7s ✓）。
   结果仍按**原顺序**打印（不按完成先后 ✗），失败项照旧收集、任一非 0 整体 exit 1 ✓ —— 判定力一分没减 ✓。 */
/* 防御（2026-10-17）：三元漏写 else 会产生 null → map 解构 TypeError，
   而原报错只给一行 "object null is not iterable"，完全看不出是哪一项 ✗。
   现在先点名，把「静默崩」变成「指名道姓」。 */
const badSteps = steps.filter((s) => !Array.isArray(s));
if (badSteps.length) {
  console.error("  ✗ 门禁清单里有无效项（多半是三元表达式漏写 else 分支）：" + JSON.stringify(badSteps));
  process.exit(1);
}
const results = await Promise.all(steps.map(([name, cmd, skip]) => new Promise((resolve) => {
  if (skip) return resolve({ name, skip });
  const t0 = Date.now();
  execFile(cmd[0], cmd[1], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ name, err, out: (stdout || "") + "\n" + (stderr || ""), ms: Date.now() - t0 }));
})));
for (const r of results) {
  if (r.skip) { console.log("  ⏭ " + r.name + " —— " + r.skip); continue; }
  const tail = (r.out.trim().split("\n").slice(-1)[0] || "").trim();
  if (r.err) {
    fail++;
    console.log("  ✗ " + r.name + " 失败");
    r.out.split("\n")
      .filter((l) => /✗|error|Error|失败|未通过|not ok|# fail [1-9]/.test(l)).slice(0, 8)
      .forEach((l) => console.log("      " + l.trim().slice(0, 140)));
  } else {
    console.log("  ✓ " + r.name + "  " + (r.ms / 1000).toFixed(1) + "s  " + tail.slice(0, 80));
  }
}
console.log(fail ? "\n门禁未通过：" + fail + " 项失败" : "\n全部门禁通过 ✓" + (DEEP ? "" : "（typecheck 需加 --deep）"));
process.exit(fail ? 1 : 0);
