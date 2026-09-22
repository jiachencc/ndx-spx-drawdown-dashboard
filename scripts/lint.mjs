#!/usr/bin/env node
/* ESLint 检查 data.js 与两个页面的内联脚本（把 data.js 拼在前面，模拟运行时可见的顶层 const）。
 *
 * 为什么需要：这两个页面的大头是手写内联 JS（positions.html 4000+ 行），
 *   改数据时最容易犯的是「写了不存在的变量名」「对象字面量里重复键」「case 忘 break」——
 *   这类问题不影响语法、页面照跑，但结果悄悄错掉。规则集只取这类，不做风格检查。
 *   ⚠ 不跑 prettier --write：本项目的对齐排版是手工调的，全文格式化会冲掉几万行 diff。
 *
 * 依赖：eslint（npm i -g eslint）。本地工具，CI 与门禁不依赖。
 * 用法：node scripts/lint.mjs [--quiet]（--quiet 只打印 error，不列 warning）
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUIET = process.argv.includes("--quiet");

const dataJs = readFileSync(path.join(root, "data.js"), "utf8");
const inlineOf = (file) => {
  const html = readFileSync(path.join(root, file), "utf8");
  return [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n;\n");
};
const units = [
  ["data.js", dataJs],
  ["positions.inline.js", dataJs + "\n;\n" + inlineOf("positions.html")],
  ["index.inline.js", dataJs + "\n;\n" + inlineOf("index.html")],
];

const dir = path.join(tmpdir(), "ndx-lint-" + process.pid);
mkdirSync(dir, { recursive: true });
const files = units.map(([name, code]) => {
  const f = path.join(dir, name);
  writeFileSync(f, code);
  return f;
});

/* 临时 flat config：script 模式（内联脚本不是模块）+ 浏览器全局。
   规则只挑「改数据时容易犯、且会静默算错」的那类。 */
const config = path.join(dir, "eslint.config.mjs");
writeFileSync(config, `export default [{
  files: ["**/*.js"],
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "script",
    globals: {
      window: "readonly", document: "readonly", console: "readonly", navigator: "readonly",
      location: "readonly", localStorage: "readonly", matchMedia: "readonly", getComputedStyle: "readonly",
      requestAnimationFrame: "readonly", cancelAnimationFrame: "readonly", setTimeout: "readonly",
      clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", structuredClone: "readonly",
      ResizeObserver: "readonly", IntersectionObserver: "readonly", SVGElement: "readonly", HTMLElement: "readonly",
      fetch: "readonly", URL: "readonly", URLSearchParams: "readonly", Intl: "readonly", AbortSignal: "readonly",
      CustomEvent: "readonly", Event: "readonly", Node: "readonly", Math: "readonly", Date: "readonly",
    },
  },
  rules: {
    "no-undef": "error",
    "no-redeclare": "error",
    "no-dupe-keys": "error",
    "no-dupe-args": "error",
    "no-unreachable": "error",
    "no-self-assign": "error",
    "no-self-compare": "error",
    "no-constant-condition": "warn",
    "no-cond-assign": "error",
    "no-fallthrough": "error",
    "no-sparse-arrays": "error",
    "no-obj-calls": "error",
    "use-isnan": "error",
    "valid-typeof": "error",
    "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
    "no-empty": ["warn", { allowEmptyCatch: true }],
  },
}];`);

let json = "";
try {
  json = execFileSync("eslint", ["--config", config, "--format", "json", "--no-warn-ignored", ...files],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  if (e.code === "ENOENT") {
    console.error("未找到 eslint。先装一次：npm i -g eslint");
    process.exit(2);
  }
  json = e.stdout || "";       // 有 lint 错误时退出码为 1，报告在 stdout
}

let report = [];
try { report = JSON.parse(json); } catch { console.error("eslint 未返回 JSON：\n" + json.slice(0, 500)); process.exit(2); }

const counts = {};
let errors = 0, warnings = 0;
for (const f of report) {
  for (const m of f.messages) {
    counts[m.ruleId || "(parse)"] = (counts[m.ruleId || "(parse)"] || 0) + 1;
    if (m.severity === 2) errors++; else warnings++;
  }
}
console.log("检查单元：" + units.map(([n]) => n).join(" · "));
console.log("error " + errors + " · warning " + warnings +
  (Object.keys(counts).length ? "（" + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + "×" + v).join("  ") + "）" : ""));

for (const f of report) {
  const msgs = f.messages.filter((m) => m.severity === 2 || !QUIET);
  if (!msgs.length) continue;
  console.log("\n" + path.basename(f.filePath));
  msgs.slice(0, 40).forEach((m) => console.log("  " + m.line + ":" + m.column + "  " + (m.severity === 2 ? "✗" : "·") + " " + (m.ruleId || "parse") + "  " + m.message));
  if (msgs.length > 40) console.log("  …还有 " + (msgs.length - 40) + " 条");
}
process.exit(errors ? 1 : 0);
