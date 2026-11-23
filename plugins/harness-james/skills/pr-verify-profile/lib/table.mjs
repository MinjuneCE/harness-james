// 사용자 확인 표(Markdown). 구조 이름, 중요도, 검토 문턱(쉬운 말), 파일 수, 왜 중요한지. 등록본이 있으면 바뀐 곳만 표시한다.
import { criticalityWord, ruleCell } from "./rule.mjs";

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function confirmTable({ profile, rows, scoring, diff = null }) {
  const defThr = scoring.defaults.structure_review_threshold;
  const mark = new Map();
  if (diff) {
    for (const id of diff.added) mark.set(id, "새로 넣음");
    for (const r of diff.renamed) mark.set(r.to, `⚠ id 바꿈(전 ${r.from})`);
    for (const c of diff.changed) {
      const parts = [];
      if (c.criticality) parts.push(`중요도 ${c.criticality[0]}→${c.criticality[1]}`);
      if (c.review_threshold) parts.push(`문턱 ${c.review_threshold[0] ?? defThr}→${c.review_threshold[1] ?? defThr}`);
      if (c.paths) parts.push(`경로 +${c.paths.added.length}/−${c.paths.removed.length}`);
      if (c.files[0] !== null && c.files[0] !== c.files[1]) parts.push(`파일 ${c.files[0]}→${c.files[1]}`);
      if (c.exclude) parts.push("제외 경로 바뀜");
      if (c.specs) parts.push("specs 바뀜");
      if (c.name && !parts.length) parts.push("이름 바뀜");
      if (c.why && !parts.length) parts.push("설명 바뀜");
      mark.set(c.id, parts.join(", "));
    }
  }
  const L = [];
  L.push(`### ${profile.repo?.name ?? "?"} 구조 목록 ${diff ? "변경안" : "초안"}`, "");
  L.push(`| 구조 | 중요도 | 사람이 직접 보게 되는 변경 | 파일 수 |${rows.some((r) => r.changed !== null) ? " 바뀐 파일 |" : ""} 왜 중요한지 |${diff ? " 바뀌는 점 |" : ""}`);
  L.push(`|---|---|---|---:|${rows.some((r) => r.changed !== null) ? "---:|" : ""}---|${diff ? "---|" : ""}`);
  for (const r of rows) {
    const thr = r.review_threshold ?? defThr;
    L.push(`| ${cell(r.name)} \`${r.id}\` | ${r.criticality} (${criticalityWord(r.criticality)}) | 문턱 ${thr}: ${cell(ruleCell(scoring, r.criticality, thr))} | ${r.files}${r.files ? "" : " ⚠"} |${r.changed !== null ? ` ${r.changed} |` : ""} ${cell(r.why)} |${diff ? ` ${cell(mark.get(r.id) ?? "")} |` : ""}`);
  }
  L.push("");
  if (diff) {
    for (const id of diff.removed) L.push(`- ⚠ 구조 \`${id}\`를 없애요.`);
    for (const it of diff.items.filter((i) => i.check === "structure-id-change")) L.push(`- ⚠ ${it.message}${it.files?.length ? `: ${it.files.join(", ")}` : ""}`);
    for (const c of diff.changed.filter((c) => c.paths)) L.push(`- \`${c.id}\` 경로${c.paths.added.length ? ` 더함: ${c.paths.added.map((g) => `\`${g}\``).join(", ")}` : ""}${c.paths.removed.length ? ` 뺌: ${c.paths.removed.map((g) => `\`${g}\``).join(", ")}` : ""}`);
    const dp = diff.dependents;
    if (dp && (dp.added.length || dp.removed.length || dp.refs.length)) L.push(`- 다른 레포 대조(dependents)가 바뀌어요: ${[dp.added.length ? `더함 ${dp.added.length}곳` : "", dp.removed.length ? `뺌 ${dp.removed.length}곳` : "", ...dp.refs.map((r) => `ref ${r.move} ${r.n}곳`)].filter(Boolean).join(", ")}`);
    if (diff.version && diff.version[0] !== diff.version[1]) L.push(`- version ${diff.version[0]} → ${diff.version[1]}`);
    if (diff.coverage_ignore.added.length) L.push(`- 구조에서 빼는 경로(coverage_ignore)에 더해요: ${diff.coverage_ignore.added.map((g) => `\`${g}\``).join(", ")}`);
    if (diff.coverage_ignore.removed.length) L.push(`- coverage_ignore에서 빼요: ${diff.coverage_ignore.removed.map((g) => `\`${g}\``).join(", ")}`);
    if (diff.unchanged) L.push("- 등록본과 구조 목록이 같아요.");
  }
  L.push("- 중요도는 0–100이고, 높을수록 적은 변경에도 사람이 봐요. 문턱은 구조 영향도(중요도 × 변경 규모, 중간 이상 지적이 있으면 +20)가 넘어야 하는 값이에요.");
  L.push(`- 변경 규모는 주석·공백을 뺀 줄 수로 세요(1–10줄 0.6, 11–50줄 0.8, 51줄 이상 1.0). 피크 시즌 기간은 산식 파일(평가 폴더의 \`config/scoring.json\`, 없으면 /pr-verify 기본값)의 \`season\`이에요.`);
  if (rows.some((r) => !r.files)) L.push("- ⚠ 파일 수 0인 구조는 지금 트리에서 아무 파일도 못 잡아요.");
  return L.join("\n");
}
