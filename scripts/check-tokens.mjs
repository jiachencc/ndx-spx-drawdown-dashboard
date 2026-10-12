#!/usr/bin/env node
/* 跨页令牌门禁（2026-10-12 第三批加）
 *
 * 为什么需要：色板曾被四个页面各抄一份 ✗（--green/--red/… 四次、字体栈四次），
 *   结果是"同一色号两个值"（--purple / --tx3 眼下就是这样 ✗），且调一次色要改四处、漏一处没人发现。
 *   本轮把它们收进 tokens.css ✓ —— 而**收进去之后就一定会有人再抄回去** ✗（新页面 / 复制粘贴），
 *   所以这里立三条契约，把"又出现第二份"变成**当场报红** ✓：
 *     ① 每页必须 link tokens.css，且**在主样式表之前** ✓（顺序错了，页面自己的覆盖会失效 ✗）
 *     ② 每页自己（HTML 内联 <style> ＋ 它的 .css 文件）**不得重新声明** tokens.css 里已有的令牌名 ✗
 *     ③ tokens.css 必须真的定义了那批共享令牌 ✓（防手滑删空 —— 那样四页会一起变白 ✗）
 *
 * 用法：node scripts/check-tokens.mjs        退出码 0 = 通过
 * ⚠ 有意**不**检查的：--up / --down 一族（语义映射，各页刻意相反 ✓）、
 *   --tx3 / --purple / --sox（四页取值不同，待拍板 ✗）、字号刻度（各页版式 ✓）。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(root, f), "utf8");

const TOKENS = "tokens.css";
/* 共享令牌名（唯一出处 = tokens.css ✓，这里只做"是否存在"的抽样，不复制它的值 ✗） */
const SHARED = ["--bg", "--card", "--card2", "--line", "--line-soft", "--tx", "--tx2",
  "--green", "--red", "--yellow", "--blue", "--cyan", "--mono", "--sans"];

/* 每页引用的令牌文件：子目录页用**同级副本** ✗→✓（2026-10-12 修背景丢失 —— 见 tokens.css 头注释 ✓） */
const pages = [
  { html: "index.html", css: [], link: "tokens.css" },
  { html: "positions.html", css: ["positions.css"], link: "tokens.css" },
  { html: "finance/index.html", css: ["finance/finance.css"], link: "tokens.css" },
  { html: "fed-cycle/index.html", css: ["fed-cycle/fed-cycle.css"], link: "tokens.css" },
];
/* 子目录副本：与根目录那份**逐字节**相同（由 scripts/sync-tokens.mjs 生成 ✓） */
const MIRRORS = ["finance/tokens.css", "fed-cycle/tokens.css"];

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || "" });
const styleBlocks = (html) => [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
/* 只看第一个 :root 块（light 主题块里的覆盖是**正常且必要**的 ✓，不算重复声明 ✗） */
const rootBlock = (src) => { const m = /:root\s*\{([\s\S]*?)\}/.exec(src); return m ? m[1] : ""; };
const declared = (src) => { const out = []; const re = /(--[a-z0-9-]+)\s*:/gi; let m; const b = rootBlock(src); while ((m = re.exec(b))) out.push(m[1]); return out; };

/* ③ tokens.css 自身 */
const tokSrc = read(TOKENS);
const tokNames = declared(tokSrc);
const missSelf = SHARED.filter((n) => tokNames.indexOf(n) < 0);
check("tokens.css 定义齐共享令牌（" + SHARED.length + " 个）", missSelf.length === 0, missSelf.length ? "缺：" + missSelf.join(" ") : tokNames.length + " 个令牌 ✓");

/* ③′ 子目录副本必须与根目录那份**逐字节相同** ✓（单一真源 = 根目录 tokens.css ✓；
   手改副本、或改了根目录却忘了同步 → 当场报红 ✗；修法：node scripts/sync-tokens.mjs） */
MIRRORS.forEach((m) => {
  let ok = false, detail = "";
  try {
    const s = readFileSync(path.join(root, m), "utf8");
    ok = s === tokSrc;
    detail = ok ? "逐字节相同 ✓（" + s.length + " 字节）" : "与根目录那份**不同** ✗ → 跑 node scripts/sync-tokens.mjs";
  } catch (e) { detail = "不存在 ✗ → 跑 node scripts/sync-tokens.mjs"; }
  check(m + " 与根目录 tokens.css 逐字节相同", ok, detail);
});

/* ①② 每页 */
pages.forEach((p) => {
  const html = read(p.html);
  const linkIdx = html.indexOf(TOKENS);
  const mainCss = p.css[0] ? html.indexOf(p.css[0]) : html.indexOf("</head>");
  const linkTag = new RegExp('<link[^>]+href="' + p.link.replace(".", "\\.") + '"');
  check(p.html + " 引了 tokens.css 且在它自己的样式表之前",
    linkIdx >= 0 && linkTag.test(html) && (mainCss < 0 || linkIdx < mainCss),
    linkIdx < 0 ? "没有 <link … " + p.link + ">" : "tokens 位置 " + linkIdx + " vs 主样式表 " + mainCss);
  /* ⚠ 子目录页**不许**写 ../tokens.css ✗ —— 2026-10-12 背景丢失就出在这里：
     "服务根不是仓库根 / 部署漏拷上级文件"时 `../` 取不到 → --bg 失效 → body 整条 background 作废 ✗ */
  if (p.html.indexOf("/") >= 0) {
    check(p.html + " 用**同级**副本（未写 ../tokens.css ✗）",
      !/href="[^"]*\.\.\/tokens\.css"/.test(html), /href="[^"]*\.\.\/tokens\.css"/.test(html) ? "写成了 ../tokens.css ✗（改同级 + 跑 sync-tokens.mjs ✓）" : "同级引用 ✓");
  }
  const srcs = [{ f: p.html + "（内联 <style>）", s: styleBlocks(html) }].concat(p.css.map((c) => ({ f: c, s: read(c) })));
  const dup = [];
  srcs.forEach(({ f, s }) => { declared(s).filter((n) => tokNames.indexOf(n) >= 0).forEach((n) => dup.push(f + " 重复声明 " + n)); });
  check(p.html + " 未重复声明共享令牌（唯一出处 " + TOKENS + " ✓）", dup.length === 0, dup.slice(0, 6).join("；") || "无重复 ✓");
});

let failed = 0;
console.log("═══ 跨页令牌检查（scripts/check-tokens.mjs）═══");
checks.forEach((c) => { if (!c.ok) failed++; console.log((c.ok ? "  ✓ " : "  ✗ ") + c.name + (c.ok ? "" : "   ← " + c.detail)); });
console.log("\n令牌校验：" + (checks.length - failed) + "/" + checks.length + " 通过（" + TOKENS + " 共 " + tokNames.length + " 个令牌 · 四页共用 ✓）");
process.exit(failed ? 1 : 0);
