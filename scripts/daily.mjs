#!/usr/bin/env node
/* 每日收尾一条命令（2026-10-23 建）—— 把三个 AUTO 脚本按**依赖顺序**串起来。

   为什么需要它：这三个块都得在「当天的流水已经写进 data.js」之后跑，而且各有各的前提：
     · fetch-trade-range   —— 要腾讯**当日K**（收盘后就有）→ 缺则页面少几个刻度、门禁会红
     · fetch-hold-history  —— 同上（逐日收盘价）
     · fetch-trade-premium —— 要东财**当日单位净值**（QDII T+1 才有）→ 缺则跳过（脚本已内建守卫 ✓）
   分开跑的时候，顺序错 / 漏跑 / 在净值没出来时跑了（会静默用前一天的净值算出假溢价 ✗），
   都是"看起来成功、数据悄悄错"的那一类 ✗ —— 这正是本仓库最忌讳的失效模式。

   用法：
     node scripts/daily.mjs              # 三个都跑
     node scripts/daily.mjs --only=rng   # 只跑某一个（rng / hold / prem，逗号分隔）

   退出码：任意一个失败 → 1（失败的那个会把原因打出来；**已成功的不会回滚**——
   它们各自都是「校验后才原子写」，互不依赖）。

   ⚠ 顺序不能反：range / hold 只读 POSITIONS.log，premium 读 log ＋ 联网取净值；
   三者写的是 data.js 的**三个不同块**（RANGE_LOG / HOLD_HIST / PREM_LOG），互不覆盖 ✓。 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = new URL("../", import.meta.url);
const argv = process.argv.slice(2);
const onlyArg = (argv.find((a) => a.startsWith("--only=")) || "").slice(7);
const only = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim()).filter(Boolean)) : null;

const STEPS = [
  { key: "rng", label: "当日区间（RANGE_LOG）", file: "scripts/fetch-trade-range.mjs" },
  { key: "hold", label: "各标的浮盈曲线（HOLD_HIST）", file: "scripts/fetch-hold-history.mjs" },
  { key: "prem", label: "逐笔溢价（PREM_LOG）", file: "scripts/fetch-trade-premium.mjs" },
  /* 回撤历史对照（2026-10-24 加）：纯本地计算（RECENT + 十年代理序列），不请求网络，几十毫秒。
     放在最后：它读 RECENT，而 RECENT 由 CI 的行情更新负责 —— 这里只重算「峰谷/排名/条件统计」✓ */
  { key: "dd", label: "回撤历史对照（DDHIST）", file: "scripts/build-ddhist.mjs" },
  /* 溢价扫描（2026-10-28 加）：10 只纳指 ETF 的日K ＋ 净值（约 25 秒、20 多个请求）。
     放在最后：它**只写自己的块**，失败不影响前面那些；页面缺这块时会整卡隐藏 ✓ */
  { key: "scan", label: "溢价扫描（PREM_SCAN）", file: "scripts/fetch-premium-scan.mjs" },
];

/* 前置检查（只提示、不拦）：① 今天的流水录了没 ② 溢价块会不会因净值未公布而跳过 */
function preflight() {
  const dataSrc = readFileSync(fileURLToPath(new URL("data.js", ROOT)), "utf8");
  const posSrc = readFileSync(fileURLToPath(new URL("positions-data.js", ROOT)), "utf8");
  const pick = (src, name) => {
    const m = src.match(new RegExp("^const " + name + " = [\\[{][\\s\\S]*?^[\\]}];", "m"));
    if (!m) return null;
    const c = { }; vm.createContext(c);
    vm.runInContext(m[0] + "\nthis.o = " + name + ";", c, { timeout: 5000 });
    return c.o;
  };
  const POS = pick(dataSrc, "POSITIONS");
  const SNAPS = pick(posSrc, "SNAPSHOTS") || [];
  const lastTrade = ((POS && POS.log) || []).map((e) => e.d).filter(Boolean).sort().at(-1) || null;
  const lastSnap = (SNAPS.at(-1) || {}).d || null;
  if (lastTrade && lastSnap && lastTrade > lastSnap) {
    console.log("  ⚠ 流水里最新成交日 " + lastTrade + " 还没有对应的快照（末日 " + lastSnap + "）——"
      + " 若今天确实有成交，先跑 apply-screenshot 录期，否则这几个块会按旧流水算 ✓");
  } else {
    console.log("  · 流水与快照都到 " + (lastSnap || "—") + " ✓");
  }
  return lastTrade;
}

const t0 = Date.now();
console.log("═══ 每日收尾（scripts/daily.mjs）═══");
preflight();
const bad = [];
for (const s of STEPS) {
  if (only && !only.has(s.key)) continue;
  const t = Date.now();
  process.stdout.write("  " + s.label + " … ");
  try {
    const out = execFileSync(process.execPath, [s.file], { cwd: fileURLToPath(ROOT), encoding: "utf8" });
    const lines = out.trim().split("\n").filter(Boolean);
    const hints = lines.filter((l) => /净值还没公布|未公布/.test(l));
    /* 「结论行」= 最后一条**不是**提示的行（否则 ⏳ 那句会被印两遍 ✗） */
    const tail = lines.filter((l) => !/净值还没公布|未公布/.test(l)).at(-1) || "";
    console.log("✓ " + ((Date.now() - t) / 1000).toFixed(1) + "s  " + tail.slice(0, 120));
    /* 把「⏳ 净值未公布」这类**成功但有缺口**的提示带出来（别让人以为全齐了 ✓） */
    hints.forEach((l) => console.log("      " + l.trim()));
  } catch (e) {
    console.log("✗ 失败");
    bad.push(s.label + "：\n" + String(e.stdout || "") + String(e.stderr || "") + String(e.message || ""));
  }
}
console.log("");
if (bad.length) {
  console.error("✗ 有 " + bad.length + " 项失败（其余已成功写入、不会回滚）：\n" + bad.join("\n"));
  process.exit(1);
}
console.log("✓ 全部完成（" + ((Date.now() - t0) / 1000).toFixed(1) + "s）。建议随后跑 node scripts/verify-all.mjs 确认门禁 ✓");
