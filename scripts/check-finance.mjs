#!/usr/bin/env node
/* 个人财务看板 · 数据门禁（2026-10-01 建）
 *
 * 为什么需要它：收益矩阵是**手抄**的（7 账户 × 9 月 = 63 格），手抄错一个数，
 * 页面照样画得出来、肉眼看不出 —— 但它会破坏「行合计 / 列合计 / 阶段 / 全年」这四条恒等式。
 * 本脚本把这四条固化成断言：**任何一格抄错，都会在两处以上暴露**（行、列各一次）。
 *
 * 跑法：node scripts/check-finance.mjs        （退出码非 0 = 有问题）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(ROOT, "finance", "finance-data.js"), "utf8");

const ctx = vm.createContext({});
/* ⚠ 数据文件里是 `const` 声明 —— vm 里 const 不会挂到 context 上（只有 var 会），
   故显式把要用的名字抛到 this 上一次取回（与 scripts/check-data.mjs 同一手法）。 */
vm.runInContext(src + "\nthis.__fin = { FIN_ASOF, FIN_MONTHS, FIN_ACCOUNTS, FIN_PL, FIN_EMPTY, FIN_DERIVED, FIN_CLAIMS, FIN_NOTES, FIN_BALANCE, FIN_CASH, FIN_FLOW, FIN_MTD };", ctx);
const {
  FIN_ASOF, FIN_MONTHS, FIN_ACCOUNTS, FIN_PL, FIN_EMPTY, FIN_DERIVED, FIN_CLAIMS, FIN_NOTES,
  FIN_BALANCE, FIN_CASH, FIN_FLOW, FIN_MTD,
} = ctx.__fin;

const fails = [];
const ok = [];
const check = (name, pass, detail) => (pass ? ok : fails).push(name + (detail ? "  ← " + detail : ""));
const near = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;
const money = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2);
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
const num = (v) => typeof v === "number" && Number.isFinite(v);

/* ── ① 结构 / 三态 ───────────────────────────────────────────────────── */
const KNOWN = new Set(FIN_ACCOUNTS.map((a) => a.id));
check("账户数与数据键一致（" + FIN_ACCOUNTS.length + " 个）",
  FIN_ACCOUNTS.length === Object.keys(FIN_PL).length && Object.keys(FIN_PL).every((k) => KNOWN.has(k)),
  "账户 " + FIN_ACCOUNTS.map((a) => a.id).join("/") + "｜数据 " + Object.keys(FIN_PL).join("/"));

const badVal = [];
Object.entries(FIN_PL).forEach(([id, row]) =>
  Object.entries(row).forEach(([m, v]) => {
    if (v === null) return;                                   // null = 空仓 ✓ 合法
    if (!num(v)) badVal.push(id + "/" + m + " = " + v);        // 既不是数字也不是 null ✗
    if (FIN_MONTHS.indexOf(m) < 0) badVal.push(id + " 月份非法：" + m);
  }));
check("每格都是「数字 或 null（空仓）」，没有 NaN / 非法月份", badVal.length === 0, badVal.join("；"));

const badEmpty = [];
Object.entries(FIN_EMPTY).forEach(([id, ms]) =>
  ms.forEach((m) => { if (FIN_PL[id] && FIN_PL[id][m] !== null) badEmpty.push(id + "/" + m + " 应为 null"); }));
check("FIN_EMPTY 里声明的空仓月份，数据层确实是 null", badEmpty.length === 0, badEmpty.join("；"));

/* ── ② 行合计 = 账户年度（表内声明值）───────────────────────────────── */
const badRow = [];
FIN_ACCOUNTS.forEach((a) => {
  const t = sum(Object.values(FIN_PL[a.id] || {}));
  if (!near(t, FIN_CLAIMS.annual[a.id])) badRow.push(a.name + " 实算 " + money(t) + " ≠ 声明 " + money(FIN_CLAIMS.annual[a.id]));
});
check("行合计 = 账户年度（" + FIN_ACCOUNTS.length + " 行）", badRow.length === 0, badRow.join("；"));

/* ── ③ 列合计 = 逐月合计（表内声明值）──────────────────────────────── */
const colTot = {};
FIN_MONTHS.forEach((m) => { colTot[m] = sum(FIN_ACCOUNTS.map((a) => (FIN_PL[a.id] || {})[m])); });
const badCol = FIN_MONTHS.filter((m) => !near(colTot[m], FIN_CLAIMS.monthly[m]))
  .map((m) => m + " 实算 " + money(colTot[m]) + " ≠ 声明 " + money(FIN_CLAIMS.monthly[m]));
check("列合计 = 逐月合计（" + FIN_MONTHS.length + " 列）", badCol.length === 0, badCol.join("；"));

/* ── ④ 阶段（1–6 / 7 / 8–9）+ 全年 ─────────────────────────────────── */
const p16 = sum(FIN_MONTHS.slice(0, 6).map((m) => colTot[m]));
const p7 = colTot["2026-07"];
const p89 = sum(FIN_MONTHS.slice(7).map((m) => colTot[m]));
check("阶段 1–6 月 = " + money(FIN_CLAIMS.phases["1–6月"]), near(p16, FIN_CLAIMS.phases["1–6月"]), "实算 " + money(p16));
check("阶段 7 月 = " + money(FIN_CLAIMS.phases["7月"]), near(p7, FIN_CLAIMS.phases["7月"]), "实算 " + money(p7));
check("阶段 8–9 月 = " + money(FIN_CLAIMS.phases["8–9月"]), near(p89, FIN_CLAIMS.phases["8–9月"]), "实算 " + money(p89));
check("全年 = Σ阶段 = " + money(FIN_CLAIMS.total), near(p16 + p7 + p89, FIN_CLAIMS.total) && near(sum(Object.values(colTot)), FIN_CLAIMS.total),
  "Σ阶段 " + money(p16 + p7 + p89) + "｜Σ列 " + money(sum(Object.values(colTot))));

/* ── ⑤ 推得值：标记必须存在，且算法要能复算出该值 ─────────────────── */
const badDerived = [];
Object.entries(FIN_DERIVED).forEach(([id, ms]) =>
  Object.entries(ms).forEach(([m, d]) => {
    const v = (FIN_PL[id] || {})[m];
    if (!num(v)) { badDerived.push(id + "/" + m + " 标了推得但没有值"); return; }
    if (!d || !d.text) { badDerived.push(id + "/" + m + " 缺说明文字"); return; }
    /* 复算：年度 − 同账户其余月之和 == 该推得值 */
    const rest = sum(Object.entries(FIN_PL[id]).filter(([k]) => k !== m).map(([, x]) => x));
    if (!near(FIN_CLAIMS.annual[id] - rest, v)) badDerived.push(id + "/" + m + " 复算 " + money(FIN_CLAIMS.annual[id] - rest) + " ≠ 值 " + money(v));
  }));
const nDer = Object.values(FIN_DERIVED).reduce((a, o) => a + Object.keys(o).length, 0);
const nCell = FIN_ACCOUNTS.length * FIN_MONTHS.length;
check(nDer
  ? "推得值（" + nDer + " 格）带标记，且「年度 − 其余月」能复算出同值"
  : "推得值 0 格 —— " + nCell + " 格全部是 App 原读数（每格都能指到某张截图）",
  badDerived.length === 0, badDerived.join("；"));

/* ── ⑥ 口径说明 ──────────────────────────────────────────────────────── */
check("口径说明齐（" + FIN_NOTES.length + " 条）", FIN_NOTES.length >= 6);

/* ── ⑦ 预留字段（第 2 / 3 步）：允许暂空，但一旦填了就必须合法 ────────
 * 为什么现在就校验：余额/流水是**分批**填的（7 个账户要发 7 次截图），
 * 中途抄错一个账户 id 或月份，页面（第 2 步）会静默少画一块，肉眼看不出来。 */
const fieldBad = { 余额: [], 现金: [], 流水: [] };
const scanMoney = (name, obj) => {
  Object.entries(obj).forEach(([id, ms]) => {
    if (!KNOWN.has(id)) fieldBad[name].push("未知账户 " + id);
    Object.entries(ms || {}).forEach(([m, v]) => {
      if (FIN_MONTHS.indexOf(m) < 0) fieldBad[name].push(id + " 月份非法：" + m);
      else if (!num(v)) fieldBad[name].push(id + "/" + m + " = " + v + "（应为数字）");
    });
  });
};
scanMoney("余额", FIN_BALANCE);
scanMoney("现金", FIN_CASH);   // 现金与余额分开存：余额 = 投资市值，两者相加才是 App 总资产
Object.entries(FIN_FLOW).forEach(([id, ms]) => {
  if (!KNOWN.has(id)) fieldBad.流水.push("未知账户 " + id);
  Object.entries(ms || {}).forEach(([m, v]) => {
    if (FIN_MONTHS.indexOf(m) < 0) fieldBad.流水.push(id + " 月份非法：" + m);
    else if (!v || !num(v.in) || !num(v.out)) fieldBad.流水.push(id + "/" + m + " 缺 in / out 数字");
  });
});
const nAcc = FIN_ACCOUNTS.length;
const balIds = Object.keys(FIN_BALANCE), cashIds = Object.keys(FIN_CASH), flowIds = Object.keys(FIN_FLOW);
const missBal = FIN_ACCOUNTS.filter((a) => balIds.indexOf(a.id) < 0).map((a) => a.name);
const missCash = FIN_ACCOUNTS.filter((a) => cashIds.indexOf(a.id) < 0).map((a) => a.name);
check("预留字段结构合法 —— 余额 " + balIds.length + "/" + nAcc + " · 现金 " + cashIds.length + "/" + nAcc + " · 流水 " + flowIds.length + "/" + nAcc + " 账户",
  !fieldBad.余额.length && !fieldBad.现金.length && !fieldBad.流水.length,
  [].concat(fieldBad.余额, fieldBad.现金, fieldBad.流水).join("；")
    || [missBal.length ? "待补余额：" + missBal.join(" / ") : "",
        missCash.length ? "现金未确认（缺键 ≠ 0）：" + missCash.join(" / ") : ""].filter(Boolean).join("；"));

/* ── ⑧ FIN_MTD（本月 · 进行中）—— 2026-10-10 加 ──────────────────────
 * 这一列最危险的失败方式是**悄悄混进恒等式** ✗：一旦有人把它并进 FIN_MONTHS 或 FIN_PL，
 * 上面 ②③④ 四条会当场报红 ✓（值是新的、四条恒等式必然对不上）；本块再加两道独立闸：
 *   ① FIN_MTD.month **不在** FIN_MONTHS 里 ✓（在里面 = 有人把"进行中"当收官月份了 ✗）
 *   ② 逐账户合法：id 认识 ✓ · 值是有限数 ✓ · 有 asof（该户这次读数的截止日 ✓）
 *      ⚠「未提供」的正确写法是**缺键** ✓；写 null（借用"空仓"语义 ✗）或 0（借用"持平"语义 ✗）
 *        都会与 FIN_PL 的三态打架 → 本闸直接拦下 ✓
 *   ③ month / cutoff 是合法日期串 ✓（防止手抖写成 2026-1 之类，页面 monthLabel 会切错 ✗） */
if (!FIN_MTD) {
  check("FIN_MTD（本月 · 进行中）存在", false, "数据层里没有 FIN_MTD —— 页面会少一列（不报错，但用户看不到进行中读数 ✗）");
} else {
  check("FIN_MTD 的月份不在已收官月份里（" + FIN_MTD.month + "）—— 不会混进行/列/阶段/全年四条恒等式",
    FIN_MONTHS.indexOf(FIN_MTD.month) < 0, "FIN_MONTHS = " + FIN_MONTHS.join("/"));
  const mtdBad = [];
  Object.entries(FIN_MTD.pl || {}).forEach(([id, v]) => {
    if (!KNOWN.has(id)) mtdBad.push("未知账户 " + id);
    else if (!num(v)) mtdBad.push(id + " = " + v + "（应为有限数；「未提供」请用缺键，别用 null / 0 ✗）");
    if (!(FIN_MTD.asof || {})[id]) mtdBad.push(id + " 缺 asof（该户这次读数的截止日）");
  });
  const nRead = Object.keys(FIN_MTD.pl || {}).length;
  const dRe = /^\d{4}-\d{2}(-\d{2})?$/;
  check("FIN_MTD 逐账户合法（" + nRead + "/" + nAcc + " 账户有读数，其余＝未提供 ✗ 不是 0）",
    mtdBad.length === 0 && dRe.test(FIN_MTD.month) && dRe.test(FIN_MTD.cutoff),
    mtdBad.concat(dRe.test(FIN_MTD.month) ? [] : ["month 格式 " + FIN_MTD.month], dRe.test(FIN_MTD.cutoff) ? [] : ["cutoff 格式 " + FIN_MTD.cutoff]).join("；"));
}

/* ── 输出 ─────────────────────────────────────────────────────────── */
console.log("个人财务看板 · 数据门禁（基准日 " + FIN_ASOF + "）");
ok.forEach((s) => console.log("  ✓ " + s));
if (fails.length) {
  console.log("");
  fails.forEach((s) => console.log("  ✗ " + s));
  console.log("\n" + fails.length + " 项不通过 · " + ok.length + " 项通过");
  process.exit(1);
}
console.log("\n" + ok.length + "/" + ok.length + " 全部通过 ✓");
