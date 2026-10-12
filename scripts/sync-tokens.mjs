#!/usr/bin/env node
/* 令牌副本同步（2026-10-12 修「子目录页背景丢失」）
 *
 * 起因：第三批把色板收进根目录的 tokens.css 后，finance/ 与 fed-cycle/ 两个**子目录页面**用
 *   `../tokens.css` 引用它 ✗ —— 在"服务根不是仓库根 / 部署时漏拷上级文件 / 只把子目录单独发布"
 *   这类环境里，这个引用会 404 ✓，而 CSS 变量一失效，`body { background: … var(--bg) … }`
 *   整条声明就作废 → **背景全没** ✗（实测复现：服务根取 finance/ 时 --bg 为空、渐变 none ✗）。
 *   → 子目录页改为引用**同级副本**（同级引用在 file:// / 任意服务根 / 独立部署下都成立 ✓）。
 *
 * 单一真源仍然是根目录的 tokens.css ✓ —— 两个副本是**逐字节拷贝**，由本脚本生成，
 * 并由 scripts/check-tokens.mjs 断言"三者完全一致" ✓（手改副本会被门禁当场抓住 ✗）。
 * 用法：node scripts/sync-tokens.mjs        （改完 tokens.css 后跑一次 ✓；门禁只校验、不自动改 ✗）
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "tokens.css";
const MIRRORS = ["finance/tokens.css", "fed-cycle/tokens.css"];

const src = readFileSync(path.join(root, SRC), "utf8");
let changed = 0;
MIRRORS.forEach((rel) => {
  const abs = path.join(root, rel);
  let cur = null;
  try { cur = readFileSync(abs, "utf8"); } catch { /* 首次生成 ✓ */ }
  if (cur === src) { console.log("  ⏭ " + rel + " 已是最新 ✓"); return; }
  writeFileSync(abs, src);
  changed++;
  console.log("  ✏ " + rel + " 已同步（" + src.length + " 字节）");
});
console.log(changed ? "\n同步完成：" + changed + " 个副本 ← " + SRC + "（单一真源 ✓）" : "\n全部已同步 ✓（真源 " + SRC + "）");
