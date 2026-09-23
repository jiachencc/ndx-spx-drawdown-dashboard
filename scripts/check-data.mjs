#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { auditFiles, readModel } from "./data-quality.mjs";
import { crossIssues } from "./cross-check.mjs";
try {
  const root = new URL("../", import.meta.url);
  const issues = auditFiles(root);
  /* 交叉门禁（2026-09-23 加，见 cross-check.mjs）：审计「同一份数据写在几处」的一致性。
     为什么需要：这类错只错一处时 schema 全对、页面照常渲染、肉眼也未必看出来 ——
     2026-09-23 当天是靠临时脚本人工对账「快照场外 Σ ↔ OTC.funds Σ」才敢提交的，现固化为门禁。 */
  const model = readModel(readFileSync(new URL("data.js", root), "utf8"));
  const html = readFileSync(new URL("positions.html", root), "utf8");
  issues.push(...crossIssues(model, html).issues);
  if (issues.length) {
    console.error("Data audit failed; do not auto-correct historical records:\n" + issues.map(s => "- " + s).join("\n"));
    process.exitCode = 1;
  } else console.log("Schema, inline JavaScript, quantities and all historical snapshot items passed.");
} catch (e) { console.error(e.message); process.exitCode = 1; }
