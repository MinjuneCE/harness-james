// 중요도·검토 문턱을 쉬운 말로: "이 구조가 몇 줄 바뀌면 사람이 직접 보게 되는가".
// 산식은 /pr-verify framework.md 4.4·5·7장, 숫자는 config/scoring.json에서 읽는다(pr-verify score.mjs와 같은 계산).
export function reviewRule(scoring, criticality, threshold, { season = false } = {}) {
  const si = scoring.structure_impact;
  const sf = scoring.season ?? {};
  const t = season ? Math.round(threshold * (sf.review_threshold_factor ?? 1)) : threshold;
  if (season && criticality >= (sf.freeze_criticality ?? Infinity)) return { from: 1, with_finding_from: 1, threshold: t, freeze: true };
  const bands = [];
  let prev = 0;
  for (const st of si.magnitude_steps) {
    if (st.factor > 0) bands.push({ from: prev + 1, impact: Math.min(100, Math.round(criticality * st.factor)) });
    if (st.max_lines !== null) prev = st.max_lines;
  }
  const first = (bonus) => bands.find((b) => Math.min(100, b.impact + bonus) >= t)?.from ?? null;
  return { from: first(0), with_finding_from: first(si.finding_bonus), threshold: t, freeze: false };
}
const lines = (n) => (n === 1 ? "한 줄만 바뀌어도" : `${n}줄 이상 바뀌면`);
const linesAnd = (n) => (n === 1 ? "한 줄이라도 바뀌고" : `${n}줄 이상 바뀌고`);
export function ruleText(r) {
  if (r.freeze) return "한 줄만 바뀌어도 사람이 봐요(시즌 변경 동결)";
  if (r.from !== null) return `${lines(r.from)} 사람이 봐요`;
  if (r.with_finding_from !== null) return `줄 수만으로는 안 걸려요. ${linesAnd(r.with_finding_from)} 중간 이상 지적이 같이 나오면 봐요`;
  return "이 문턱으로는 안 걸려요";
}
export function ruleCell(scoring, criticality, threshold) {
  const normal = reviewRule(scoring, criticality, threshold);
  let text = ruleText(normal);
  if (normal.from !== null && normal.with_finding_from !== null && normal.with_finding_from < normal.from) text += ` (중간 이상 지적이 있으면 ${lines(normal.with_finding_from)})`;
  const season = reviewRule(scoring, criticality, threshold, { season: true });
  const st = ruleText(season);
  return st === ruleText(normal) ? text : `${text} · 피크 시즌: ${st}`;
}
export function criticalityWord(c) {
  return c >= 90 ? "가장 높음" : c >= 80 ? "높음" : c >= 70 ? "보통" : "낮음";
}
