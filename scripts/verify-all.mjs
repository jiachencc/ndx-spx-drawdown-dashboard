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
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const DEEP = process.argv.includes("--deep");
const has = (cmd) => { try { execFileSync("sh", ["-c", "command -v " + cmd], { stdio: "ignore" }); return true; } catch (e) { return false; } };
const hasPlaywright = () => { try { const gp = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(); return existsSync(gp + "/playwright"); } catch (e) { return false; } };

const steps = [
  ["check-data（schema ＋ 全部历史快照）", ["node", ["scripts/check-data.mjs"]]],
  ["check-finance（财务矩阵四条恒等式）", ["node", ["scripts/check-finance.mjs"]]],
  ["check-fed（加息周期看板数据）", ["node", ["scripts/check-fed.mjs"]]],
  ["cross-check（跨文件一致性）", ["node", ["scripts/cross-check.mjs"]]],
  ["regression（回归测试）", ["node", ["--test", "scripts/test-dashboard.mjs"]]],
  ["inline-compile（页面内联脚本可编译）", ["node", ["--input-type=module", "-e",
    "import{readFileSync}from\x27node:fs\x27;for(const f of [\x27index.html\x27,\x27positions.html\x27,\x27finance/index.html\x27,\x27fed-cycle/index.html\x27]){const h=readFileSync(f,\x27utf8\x27);const m=[...h.matchAll(/<script\\b(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)<\\/script>/gi)].map(x=>x[1]).join(String.fromCharCode(10)+\x27;\x27+String.fromCharCode(10));new Function(m);}"]]],
  has("eslint") ? ["eslint（7 个检查单元）", ["node", ["scripts/lint.mjs", "--quiet"]]]
    : ["eslint", null, "跳过：未安装 eslint（本地工具，CI 与门禁不依赖）"],
  hasPlaywright() ? ["dom-check（页面 DOM 断言）", ["node", ["scripts/dom-check.mjs"]]]
    : ["dom-check", null, "跳过：未找到全局 playwright"],
  /* 2026-10-09 加：dom-check 跑在 jsdom 里（没有布局 ✗），
     "元素撑破容器 / 页面横向溢出"这类**真实版面**问题它抓不到 ✗ —— 见 layout-check.mjs 头的由来 ✓ */
  hasPlaywright() ? ["layout-check（真实版面 · 无横向溢出）", ["node", ["scripts/layout-check.mjs"]]]
    : ["layout-check", null, "跳过：未找到全局 playwright"],
];
if (DEEP) steps.push(["typecheck（深度）", ["node", ["scripts/typecheck.mjs"]]]);

let fail = 0;
console.log("═══ 门禁总检（scripts/verify-all.mjs）═══");
steps.forEach(([name, cmd, skip]) => {
  if (skip) { console.log("  ⏭ " + name + " —— " + skip); return; }
  const t0 = Date.now();
  try {
    const out = execFileSync(cmd[0], cmd[1], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const tail = (out.trim().split("\n").slice(-1)[0] || "").trim();
    console.log("  ✓ " + name + "  " + ((Date.now() - t0) / 1000).toFixed(1) + "s  " + tail.slice(0, 80));
  } catch (e) {
    fail++;
    console.log("  ✗ " + name + " 失败");
    ((e.stdout || "") + (e.stderr || "")).split("\n")
      .filter((l) => /✗|error|Error|失败|未通过|not ok|# fail [1-9]/.test(l)).slice(0, 8)
      .forEach((l) => console.log("      " + l.trim().slice(0, 140)));
  }
});
console.log(fail ? "\n门禁未通过：" + fail + " 项失败" : "\n全部门禁通过 ✓" + (DEEP ? "" : "（typecheck 需加 --deep）"));
process.exit(fail ? 1 : 0);
