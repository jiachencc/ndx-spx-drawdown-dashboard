#!/usr/bin/env node
/* 加息周期看板（fed-cycle/）的数据门禁（2026-10-06 加）
 *
 * 为什么需要：此前 fed **完全不在仓库门禁里** —— scripts/lint.mjs 的 5 个单元没有它，
 *   check-data / test-dashboard / cross-check / data-quality 里 "fed" 出现 0 次 ✗；
 *   唯一的检查是它自己的 verify.mjs，而那要有人跑 update.sh 才触发。
 *
 * 本文件把断言前移，并按**两类**分开处置（这是与 verify.mjs 的关键差别）：
 *   ① 结构类：文件缺失 / 不可解析 / 键不全 → exit 1，阻止提交
 *   ② 新鲜度类：三条序列末日期不一致（外部源滞后造成）→ 只警告、exit 0
 *   ⚠ 分级理由：verify.mjs 现在把两类都判失败，于是 CI 那一步长期红 ✗ ——
 *     "真坏了"和"已知告警"就分不开了（假红会训练人忽略它）。
 *
 * 数据归属（2026-10-06 定）：fed-data.js = 构建产物，入库；fed-data.json = 原始日线，
 *   .gitignore 忽略、CI 里不存在 —— 所以新鲜度检查只在本机生效，这是预期行为。
 */
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";

const P_JS = "fed-cycle/fed-data.js", P_JSON = "fed-cycle/fed-data.json";
const bad = [], warn = [];

if (!existsSync(P_JS)) bad.push(P_JS + " 不存在（构建产物必须入库；跑 sh fed-cycle/update.sh 生成）");
else {
  const c = vm.createContext({});
  try {
    vm.runInContext(readFileSync(P_JS, "utf8") + "\n;this.__k = { META, CYCLES, SUMMARY };", c, { timeout: 5000 });
  } catch (e) { bad.push(P_JS + " 无法解析：" + e.message); }
  const k = c.__k || {};
  if (!k.META || typeof k.META !== "object") bad.push("缺 META");
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(k.META.fetchedAt || ""))) bad.push("META.fetchedAt 不是日期：" + k.META.fetchedAt);
  if (!Array.isArray(k.CYCLES) || k.CYCLES.length < 4) bad.push("CYCLES 不是数组或不足 4 个周期");
  else if (!k.CYCLES.every((x) => x && typeof x === "object")) bad.push("CYCLES 里有非对象项");
  if (!k.SUMMARY || typeof k.SUMMARY !== "object") bad.push("缺 SUMMARY");
}

if (!existsSync(P_JSON)) console.log("  （fed-data.json 不存在 —— CI 里正常，跳过新鲜度检查）");
else {
  let j = null;
  try { j = JSON.parse(readFileSync(P_JSON, "utf8")); } catch (e) { bad.push(P_JSON + " 不可解析：" + e.message); }
  if (j) {
    const last = {};
    ["ndx", "sox", "spx"].forEach((k) => {
      const a = j[k];
      if (!Array.isArray(a) || a.length < 1000) { bad.push("序列 " + k + " 缺失或过短（" + (Array.isArray(a) ? a.length + " 根" : "无") + "）"); return; }
      last[k] = a[a.length - 1].d;
    });
    if (Object.keys(last).length === 3 && new Set(Object.values(last)).size > 1)
      warn.push("三条序列末日期不一致 " + JSON.stringify(last) + " —— 外部源滞后（spx/sox 常态），非本仓库问题");
  }
}

console.log("加息周期看板 · 数据门禁");
bad.forEach((x) => console.log("  ✗ " + x));
warn.forEach((x) => console.log("  ⚠ " + x));
if (bad.length) { console.log("  → 结构问题 " + bad.length + " 条，阻止提交"); process.exit(1); }
console.log("  ✓ 结构检查通过" + (warn.length ? "（含 " + warn.length + " 条新鲜度告警，不阻断）" : ""));
