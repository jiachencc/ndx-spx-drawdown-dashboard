#!/usr/bin/env node
import { auditFiles } from "./data-quality.mjs";
try {
  const issues = auditFiles(new URL("../", import.meta.url));
  if (issues.length) {
    console.error("Data audit failed; do not auto-correct historical records:\n" + issues.map(s => "- " + s).join("\n"));
    process.exitCode = 1;
  } else console.log("Schema, inline JavaScript, quantities and all historical snapshot items passed.");
} catch (e) { console.error(e.message); process.exitCode = 1; }
