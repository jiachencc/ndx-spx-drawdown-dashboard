/* 持仓页的**共享口径**（单一出处）—— 2026-10-16 新增
 *
 * 为什么有它：同一条判据原先在**页面 / apply-screenshot / dom-check 各写一份**，于是同一次更新里漂了 3 处：
 *   ① 「本期已同步」（`upd` vs `OTC.updated`）：页面 2026-09-25 放宽成 `>=`（补录合法），
 *      录入器仍要求 `==`（跨零点截图被拒 ✗）、门禁也是 `==`（把正确的页面判成错 ✗）；
 *   ② 场外「当日合计」的有效集合：页面 `dayVals` / 录入器 `dayIn` / 门禁 `otcDayApp` 三处各一套；
 *   ③ 「组合已到 X」的日期：页面会补一个**今日估算点**，门禁却把期望写死成快照末日 ✗。
 *   修的时候改的是**副本**而不是逻辑 ✗，而且每期都要重新推理「谁是准的」✗。
 * → 判据只在这里定义一次：positions.html 直接调用 ✓；scripts/ 侧用 data-quality.mjs 的
 *   `readPosLogic()` 读**同一份源码**（vm 跑）✓。改这一处 = 页面与门禁同时改 ✓。
 *
 * ⚠ 红线：
 *   · 本文件**只放判据**（纯函数），不放任何持仓数值 ✗ —— 数据在 positions-data.js ✓。
 *   · 与 positions-data.js 同规矩：常量声明在**行首**、Node 侧用 vm 求值 →
 *     不 import / 不 export / 不碰 DOM / 不依赖其它文件 ✓（只读传进来的参数）。
 *   · 加载顺序：data.js → positions-data.js → **positions-logic.js** → 页面主 <script> ✓
 *     （scripts/lint.mjs 的 positions.inline 单元按同一顺序拼接，别只改一边 ✗）。
 */
const POS_LOGIC = {
  /* ① 「本期已同步」：upd（该基金截图时刻）**不早于** updated（快照/数据日）即算本期。
     晚于的属**补录** —— 当晚没拍、次日凌晨/上午补拍是常态 ✓，不该标成「待更」✗；
     且**绝不能**为了让它等于快照日而伪造时刻 ✗（handoff 底线）。
     没有 upd 的历史数据按「已同步」算：那些期没有「待更」标记可用 ✓（与页面历来行为一致）。 */
  synced(upd, updated) {
    if (!upd) return true;
    if (!updated) return false;
    return String(upd).slice(0, 10) >= String(updated).slice(0, 10);
  },
  /* ② 场外「当日收益」的**有效集合**：`null` = 该只本期未更新 → **不计入**当日合计 ✓
     （沿用旧读数会把它那天的 day 混进今天 ✗ —— 2026-10-12 就是这么判错副标的）。 */
  dayVals(funds, updated) {
    return (funds || []).map((f) => (Number.isFinite(f.day) && POS_LOGIC.synced(f.upd, updated) ? f.day : null));
  },
  sumDay(funds, updated) {
    return POS_LOGIC.dayVals(funds, updated).reduce((a, v) => a + (v === null ? 0 : v), 0);
  },
  /* ③ 「组合已到 X」的日期：页面在「系统当日 > 快照末日」时会补一个**今日估算点**（isToday ✓）
     → 组合末期日期 = max(快照末日, 系统当日) ✓；拿不到今日估值（useToday=false）时退回快照末日 ✓。
     ⚠ 同日不补（否则同一天出两个点、diff 里多一条假的日线点 ✗），故判据是**严格大于** ✓。 */
  trendLastD(snapLastD, todayISO, useToday) {
    if (!snapLastD) return todayISO || "";
    return (useToday && todayISO && todayISO > snapLastD) ? todayISO : snapLastD;
  },
};
