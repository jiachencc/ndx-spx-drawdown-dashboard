import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import vm from "node:vm";

export const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
export function readModel(src) {
  const ctx = vm.createContext({});
  vm.runInContext(src + "\nthis.model = { DEFAULT, MONTHLY, POSITIONS, DCA_META, DCA_NDX, DCA_SPX, SOURCE_META };", ctx, { timeout: 1500 });
  return JSON.parse(JSON.stringify(ctx.model));
}
export function compileHtml(html, file = "page") {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].filter(m => m[1].trim());
  scripts.forEach((m, i) => new vm.Script(m[1], { filename: file + ":inline:" + i }));
}
export function snapshotIssues(html) {
  const m = html.match(/^const SNAPSHOTS = \[[\s\S]*?^\];/m);
  if (!m) throw new Error("SNAPSHOTS declaration missing");
  const ctx = vm.createContext({});
  vm.runInContext(m[0] + "\nthis.rows = SNAPSHOTS;", ctx, { timeout: 500 });
  const issues = [];
  let prev = "";
  for (const s of ctx.rows) {
    if (!isDate(s.d) || s.d <= prev) issues.push(s.d + ": snapshot dates must be unique/ascending");
    prev = s.d;
    if (!s.items) {
      if (![s.total, s.pl].every(Number.isFinite)) issues.push(s.d + ": non-finite total/pl");
      continue;
    }
    let sum = 0;
    for (const [code, it] of Object.entries(s.items)) {
      const residual = it.val - it.cost - it.pl;
      if (![it.val, it.cost, it.pl].every(Number.isFinite) || Math.abs(residual) > 1)
        issues.push(s.d + ":" + code + ": val-cost-pl residual=" + residual.toFixed(2));
      sum += it.pl;
    }
    if (Number.isFinite(s.pl) && Math.abs(sum - s.pl) > 2) issues.push(s.d + ": item P&L sum mismatch");
  }
  return issues;
}
export function validateModel(m) {
  const d = m.DEFAULT, errors = [];
  const finite = (v, label) => { if (!Number.isFinite(v)) errors.push(label + " is not finite"); };
  if (!d || !isDate(d.date) || !isDate(d.asOf?.us) || d.date !== d.asOf.us) errors.push("invalid core date/asOf");
  for (const key of ["ndx", "spx"]) {
    const q = d?.[key] || {};
    for (const p of ["close", "ath", "ma50", "ma200", "low52", "prevYr", "rsi", "chg", "days", "ddYtd"]) finite(q[p], key + "." + p);
    if (!(q.close > 0 && q.ath >= q.close && q.low52 > 0 && q.low52 <= q.close && q.ma50 > 0 && q.ma200 > 0 && q.prevYr > 0)) errors.push(key + ": invalid price range");
    if (q.rsi < 0 || q.rsi > 100 || q.days < 0 || q.ddYtd > 0 || !isDate(q.athDate)) errors.push(key + ": invalid indicators");
  }
  for (const key of ["vix", "fg", "tnx", "tnx2", "fx", "putcall", "peFwd", "peTtm", "pePct", "ndxPeFwd", "ndxPePct", "cape", "epsGrowth"]) finite(d?.[key], key);
  for (const key of ["vix", "fx", "putcall", "peFwd", "peTtm", "ndxPeFwd", "cape"]) if (!(d[key] > 0)) errors.push(key + ": must be positive");
  for (const key of ["fg", "pePct", "ndxPePct"]) if (!(d[key] >= 0 && d[key] <= 100)) errors.push(key + ": outside 0..100");
  const th = Object.values(d?.thresholds || {});
  if (th.length !== 4 || !th.every((x, i) => Number.isFinite(x) && x < 0 && x > -100 && (!i || x < th[i - 1]))) errors.push("threshold ordering invalid");
  for (const key of ["etfNdx", "etfSpx", "kr", "n225", "hkus"]) {
    const q = d[key];
    if (!q || ![q.close, q.chg, q.low52, q.ath].every(Number.isFinite) || !(q.low52 > 0 && q.ath >= q.close && q.close >= q.low52)) errors.push(key + ": invalid ETF quote");
  }
  const codes = new Set();
  for (const p of m.POSITIONS?.hold || []) {
    if (codes.has(p.code) || !/^\d{6}$/.test(p.code) || !Number.isInteger(p.qty) || p.qty < 0 || !(p.cost > 0) || p.cost !== p.idxAtCost) errors.push("invalid position " + p.code);
    codes.add(p.code);
    const net = m.POSITIONS.log.filter(e => e.sym === p.sym).reduce((n, e) => n + (/卖出|减仓|清仓/.test(e.act) ? -e.qty : e.qty), 0);
    if (net !== p.qty) errors.push("quantity reconciliation " + p.code);
  }
  for (const [code, p] of Object.entries(m.POSITIONS?.premiums || {})) {
    if (!Number.isFinite(p.pct) || !Number.isFinite(p.nav) || p.nav <= 0 || !isDate(p.navDate)) errors.push("premium invalid " + code);
  }
  if (!isDate(m.DCA_META?.start) || !isDate(m.DCA_META?.end) || m.DCA_META.start >= m.DCA_META.end) errors.push("DCA metadata invalid");
  for (const key of ["DCA_NDX", "DCA_SPX"]) if (!Array.isArray(m[key]) || m[key].length < 2 || !m[key].every(x => Number.isFinite(x) && x > 0)) errors.push(key + " invalid");
  if (m.DCA_NDX?.length !== m.DCA_SPX?.length) errors.push("DCA lengths differ");
  if (!m.MONTHLY?.length || m.MONTHLY.length > 12 || !m.MONTHLY.every((r, i) => r.m === (i + 1) + "月" && [r.ndx, r.spx].every(x => Number.isFinite(x) && x > -100))) errors.push("monthly invalid");
  for (const [k, meta] of Object.entries(m.SOURCE_META || {})) {
    if (!["ok", "retained", "unverified"].includes(meta.status) || (meta.asOf !== null && !isDate(meta.asOf)) || typeof meta.source !== "string") errors.push("invalid provenance " + k);
  }
  return errors;
}
export function metrics(raw) {
  // Filter whole rows, never filter close separately from dates/highs.
  const rows = raw.dates.map((date, i) => ({ date, close: raw.close[i], high: raw.high[i], low: raw.low[i] }))
    .filter(r => isDate(r.date) && [r.close, r.high, r.low].every(Number.isFinite));
  if (rows.length < 260) throw new Error("insufficient valid bars");
  if (rows.some((r, i) => r.close <= 0 || r.high < r.close || r.low > r.close || r.low <= 0 || (i && r.date <= rows[i - 1].date))) throw new Error("invalid OHLC ordering/range");
  const last = rows.at(-1), prev = rows.at(-2), year = last.date.slice(0, 4);
  const prevYr = rows.filter(r => r.date.slice(0, 4) < year).at(-1)?.close;
  if (!(prevYr > 0)) throw new Error("previous year close missing");
  const hi = rows.reduce((a, r, i) => r.high > rows[a].high ? i : a, 0);
  const avg = n => rows.slice(-n).reduce((s, r) => s + r.close, 0) / n;
  let gain = 0, loss = 0;
  for (let i = rows.length - 14; i < rows.length; i++) { const c = rows[i].close - rows[i - 1].close; gain += Math.max(0, c); loss += Math.max(0, -c); }
  let peak = prevYr, ddYtd = 0;
  rows.filter(r => r.date.startsWith(year)).forEach(r => { peak = Math.max(peak, r.close); ddYtd = Math.min(ddYtd, (r.close / peak - 1) * 100); });
  const round = (x, n = 2) => +x.toFixed(n);
  return { close: round(last.close), ath: round(rows[hi].high), athDate: rows[hi].date, days: rows.length - 1 - hi, chg: round((last.close / prev.close - 1) * 100), ma50: round(avg(50)), ma200: round(avg(200)), rsi: round(gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss), 1), low52: round(Math.min(...rows.slice(-252).map(r => r.low))), high52: round(Math.max(...rows.slice(-252).map(r => r.high))), prevYr, ddYtd: round(ddYtd, 1), date: last.date, rows };
}
export function monthly(rows) {
  const year = rows.at(-1).date.slice(0, 4);
  let prev = rows.filter(r => r.date.slice(0, 4) < year).at(-1)?.close;
  const map = new Map();
  rows.filter(r => r.date.startsWith(year)).forEach(r => map.set(+r.date.slice(5, 7), r.close));
  const out = [];
  for (let i = 1; i <= 12; i++) { if (!map.has(i)) break; out.push((map.get(i) / prev - 1) * 100); prev = map.get(i); }
  return out;
}
export function createRecorder(oldMeta, now = new Date()) {
  const meta = structuredClone(oldMeta || {}), fetchedAt = now.toISOString();
  function success(key, asOf, source, extra = {}) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
    if (!isDate(asOf) || asOf > today) throw new Error(key + ": missing/invalid source date");
    if (meta[key]?.asOf && asOf < meta[key].asOf) throw new Error(key + ": source date regressed");
    meta[key] = { asOf, source, fetchedAt, status: "ok", ...extra };
  }
  function failure(key, source, reason) {
    meta[key] = { asOf: null, source, ...meta[key], status: "retained", attemptedAt: fetchedAt, error: String(reason).slice(0, 200) };
  }
  return { meta, success, failure };
}
export function stableBusiness(meta) {
  return Object.fromEntries(Object.entries(meta).map(([k, m]) => { const { fetchedAt, attemptedAt, error, ...business } = m; return [k, business]; }));
}
/* Inline rendering that keeps data.js hand-written: unquoted identifier keys,
 * entries on their original lines. Values are re-emitted from the model, so a
 * trailing zero may be dropped (4.730 -> 4.73); never compare textual forms. */
const IDENT = /^[A-Za-z_$][\w$]*$/;
function inlineLiteral(v) {
  if (v === null || typeof v === "boolean") return String(v);
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("non-finite value in data"); return String(v); }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(inlineLiteral).join(", ") + "]";
  return "{ " + Object.entries(v).map(([k, x]) => (IDENT.test(k) ? k : JSON.stringify(k)) + ": " + inlineLiteral(x)).join(", ") + " }";
}
/* Rewrite `const NAME = { ... };` value-by-value so the block keeps its layout
 * and its AUTO/MANUAL comments across every automated update. Several pairs may
 * share one line, so values are located by scanning rather than per line. The
 * round-trip check refuses anything this writer cannot reproduce exactly. */
const canonical = v => (Array.isArray(v) ? v.map(canonical)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v);
export function replaceConst(src, name, value) {
  const anchor = new RegExp("^const " + name + " = \\{[\\s\\S]*?^\\};", "m");
  const block = src.match(anchor);
  if (!block) throw new Error("missing object anchor " + name);
  const text = block[0];
  let body = text.slice(text.indexOf("{") + 1, text.lastIndexOf("};")).replace(/\n[ \t]*$/, "");
  const seen = new Set();
  // A key starts a line or follows a comma; its value is a flat {...} or runs up to the next comma.
  body = body.replace(/(^[ \t]*|[,{][ \t]*)([A-Za-z_$][\w$]*)([ \t]*:[ \t]*)(\{[^}]*\}|[^,\n]+)/gm, (all, lead, key, sep) => {
    if (!Object.hasOwn(value, key)) return all;
    seen.add(key);
    return lead + key + sep + inlineLiteral(value[key]);
  });
  const missing = Object.entries(value).filter(([k]) => !seen.has(k));
  if (missing.length) {
    if (!/,[ \t]*$/.test(body)) body += ",";
    body += "\n" + missing.map(([k, v]) => "  " + (IDENT.test(k) ? k : JSON.stringify(k)) + ": " + inlineLiteral(v) + ",").join("\n");
  }
  const rebuilt = "const " + name + " = {" + body + "\n};";
  const ctx = vm.createContext({});
  vm.runInContext(rebuilt + "\nthis.out = " + name + ";", ctx, { timeout: 1500 });
  if (JSON.stringify(canonical(ctx.out)) !== JSON.stringify(canonical(value))) throw new Error(name + ": rewritten block does not round-trip");
  return src.replace(anchor, () => rebuilt);
}
/* Rewrite a `name: { ... },` member of a larger literal. Keeps the comment that
 * trails the opening brace; entries are re-emitted one per line. */
export function replaceMember(src, name, value, indent = "  ") {
  const anchor = new RegExp("^" + indent + name + ": \\{([^\\n]*)\\n[\\s\\S]*?^" + indent + "\\},", "m");
  const found = src.match(anchor);
  if (!found) throw new Error("missing member anchor " + name);
  const body = Object.entries(value).map(([k, v]) => indent + "  " + JSON.stringify(k) + ": " + inlineLiteral(v) + ",").join("\n");
  return src.replace(anchor, () => indent + name + ": {" + found[1] + "\n" + body + "\n" + indent + "},");
}
export function atomicWrite(target, content) {
  const temp = target + ".pending-" + process.pid;
  try { writeFileSync(temp, content, { flag: "wx" }); renameSync(temp, target); }
  finally { try { unlinkSync(temp); } catch (e) { if (e.code !== "ENOENT") throw e; } }
}
export function auditFiles(root) {
  const data = readFileSync(new URL("data.js", root), "utf8");
  const pos = readFileSync(new URL("positions.html", root), "utf8");
  compileHtml(pos, "positions.html");
  compileHtml(readFileSync(new URL("index.html", root), "utf8"), "index.html");
  return [...validateModel(readModel(data)), ...snapshotIssues(pos)];
}
