#!/usr/bin/env node
/* 静态类型检查：用 tsc --checkJs 扫 data.js 与两个页面的内联脚本。
 *
 * 为什么需要：2026-09-22 的 trendSegFill 把 P() = toFixed(1) 传来的**字符串**当数字相加
 *   （"935.9" + 21.1 → "935.921.10…"），产出非法坐标、图上冒出横跨全屏的大三角。
 *   只要那个函数的参数标了 {number|string}，tsc 就会报 TS2365「+ 不能用于这些类型」✗。
 *
 * 判读口径（重要）：这是「手写内联 JS + 无类型注解」的代码库，全量诊断必然千条
 *   （隐式 any、索引签名、DOM lib 的 Element/EventTarget 差异）。所以只拦**算术与参数类**错误：
 *     TS2362 / TS2363 / TS2365  算术运算的操作数类型不对 ← 上述事故的类别
 *     TS2367                    比较两边类型不重叠（永远为假）
 *     TS2554                    参数个数不对
 *     TS2304 / TS2451 / TS2448 / TS2454  未定义名 / 重复声明 / 先用后声明
 *   其余只计数。
 *
 * 实现要点：① 每个文件**分别编译** —— 合在一起会把各文件顶层的 const 当成重复声明（TS2451 假报）；
 *   ② 内联脚本检查时把 data.js 拼在前面（模拟运行时可见性），并用「补空行对齐」把内联代码在
 *   unit 里的行号对齐到 HTML 行号，再按段映射回去（否则拿到的是拼接后的行号，报错定不到源码行）。
 *
 * 依赖：typescript（npm i -g typescript）。本地工具，CI 与门禁不依赖。
 * 用法：node scripts/typecheck.mjs [--all]
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOW_ALL = process.argv.includes("--all");
const STRICT = new Set(["TS2362", "TS2363", "TS2365", "TS2367", "TS2554", "TS2304", "TS2451", "TS2448", "TS2454"]);

const dataJs = readFileSync(path.join(root, "data.js"), "utf8");

/* 取出页面的每个内联脚本及它在 HTML 里的起始行（1-based，指向代码首行） */
function inlineScripts(file) {
  const html = readFileSync(path.join(root, file), "utf8");
  const re = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const contentStart = m.index + m[0].indexOf(">") + 1;
    out.push({ code: m[1], htmlLine: html.slice(0, contentStart).split("\n").length });
  }
  return out;
}

/* 组装检查单元：data.js 打底，再逐段拼接内联脚本（每段前面补空行，使该段的行号 == HTML 行号）。
   记下每段在 unit 里的起始行，用于把诊断行号换算回 HTML 行号。 */
function buildUnit(file) {
  const segs = [];
  let unit = dataJs + "\n";
  let line = unit.split("\n").length;                 // unit 里「下一行」的行号
  for (const s of inlineScripts(file)) {
    const pad = Math.max(0, s.htmlLine - line);        // 补到该段代码首行 == htmlLine
    unit += "\n".repeat(pad) + s.code + "\n";
    segs.push({ unitLine: line + pad, htmlLine: s.htmlLine, label: file });
    line = unit.split("\n").length;
  }
  return { code: unit, segs, label: file + " 内联", name: file.replace(/\.html$/, ".inline.js") };
}

const units = [
  { code: dataJs, segs: [{ unitLine: 1, htmlLine: 1, label: "data.js" }], label: "data.js", name: "data.js" },
  buildUnit("positions.html"),
  buildUnit("index.html"),
];

/* unit 行号 → (文件, 源行号)：找最后一个起始行 ≤ 该行的段 */
const locate = (u, ln) => {
  let hit = u.segs[0];
  for (const s of u.segs) if (s.unitLine <= ln) hit = s;
  return { where: hit.label, line: hit.htmlLine + (ln - hit.unitLine) };
};

const dir = path.join(tmpdir(), "ndx-typecheck-" + process.pid);
mkdirSync(dir, { recursive: true });

const diags = [];
for (const u of units) {
  const f = path.join(dir, u.name);
  writeFileSync(f, u.code);
  let out = "";
  try {
    out = execFileSync("tsc", ["--noEmit", "--allowJs", "--checkJs", "--target", "es2022", "--lib", "es2022,dom",
      "--skipLibCheck", "--pretty", "false", f], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (e.code === "ENOENT") {
      console.error("未找到 tsc。先装一次：npm i -g typescript");
      process.exit(2);
    }
    out = (e.stdout || "") + (e.stderr || "");   // 有诊断时退出码为 2，诊断在 stdout
  }
  out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l)).forEach((l) => {
    const m = l.match(/\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    const at = locate(u, +(m?.[1] || 0));
    diags.push({ file: at.where, line: at.line, code: m?.[3] || "TS?", msg: m?.[4] || l });
  });
}
try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录残留无妨 */ }

const byCode = {};
for (const d of diags) byCode[d.code] = (byCode[d.code] || 0) + 1;
const strict = diags.filter((d) => STRICT.has(d.code));

/* 已知且接受（不拦）：键 = 文件|错误码|消息，值 = 允许出现的条数。
   用「计数」而不是「行号」比对 —— 改动导致行号漂移不算新问题，同一消息多冒一条才算。
   往里加条目之前先判断是不是真错；每条都要写清楚为什么可以接受。 */
const ACCEPTED = {
  /* v4 由 (r.drift !== null && r.drift < -0.05) ? "watch" : "ok" 得出，永不为 "na" → 那个 === "na" 是死分支，
     属防御性写法，不影响结果（IC[v4] 查得到）。 */
  "positions.html|TS2367|This comparison appears to be unintentional because the types '\"ok\" | \"watch\"' and '\"na\"' have no overlap.": 1,
  /* Date 相减：TS 认为 - 的操作数不能是 Date；运行时按 valueOf 取毫秒，行为正确。 */
  "index.html|TS2362|The left-hand side of an arithmetic operation must be of type 'any', 'number', 'bigint' or an enum type.": 1,
  "index.html|TS2363|The right-hand side of an arithmetic operation must be of type 'any', 'number', 'bigint' or an enum type.": 1,
};

const seen = {};
for (const d of strict) { const k = [d.file, d.code, d.msg].join("|"); seen[k] = (seen[k] || 0) + 1; }
const fresh = strict.filter((d) => {
  const k = [d.file, d.code, d.msg].join("|");
  return !ACCEPTED[k] || seen[k] > ACCEPTED[k];       // 没登记过，或同一消息条数超过登记数
});
const accepted = strict.filter((d) => !fresh.includes(d));

console.log("检查单元：" + units.map((u) => u.label).join(" · ") + "（分别编译；行号已换算回源文件）");
console.log("诊断合计 " + diags.length + " 条：" + (Object.entries(byCode).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + "×" + v).join("  ") || "无"));
if (SHOW_ALL) diags.forEach((d) => console.log("  " + d.file + ":" + d.line + "  " + d.code + "  " + d.msg));
else {
  accepted.forEach((d) => console.log("  · 已知不拦  " + d.file + ":" + d.line + "  " + d.code + "  " + d.msg));
  fresh.forEach((d) => console.log("  ✗ 新问题    " + d.file + ":" + d.line + "  " + d.code + "  " + d.msg));
}

if (fresh.length) {
  console.log("\n有 " + fresh.length + " 条新问题（算术类型 / 参数个数 / 未定义名 / 重复声明）；" +
    "另有 " + accepted.length + " 条在已知清单里、" + (diags.length - strict.length) + " 条为隐式 any 与 DOM lib 差异。");
  console.log("确认不是 bug 就加进 scripts/typecheck.mjs 的 ACCEPTED（写清理由）。");
  process.exit(1);
}
console.log("\n无新问题（已知 " + accepted.length + " 条；其余 " + (diags.length - strict.length) + " 条为隐式 any 与 DOM lib 差异）");
