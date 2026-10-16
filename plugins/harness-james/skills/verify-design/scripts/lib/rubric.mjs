// rubric 기준 목록 파싱과 적용 기준 선택(traits·프로파일 끄기·증분 범위)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { asArray } from "./util.mjs";

export const SCOPE_KO = { "절": "section", "문서": "document", "묶음": "bundle" };

// rubrics/<DIM>.md 의 "기준 목록" 표를 읽는다.
export function parseRubricDir(rubricDir) {
  const criteria = [];
  const versionFile = join(rubricDir, "..", "framework.md");
  let rubricVersion = null;
  if (existsSync(versionFile)) {
    const m = readFileSync(versionFile, "utf8").match(/버전:\s*([0-9]+\.[0-9]+\.[0-9]+)/);
    if (m) rubricVersion = m[1];
  }
  for (const f of readdirSync(join(rubricDir)).filter((x) => /^[A-Z]{3}\.md$/.test(x)).sort()) {
    const text = readFileSync(join(rubricDir, f), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\|\s*([A-Z]{3}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
      if (!m) continue;
      const [, id, name, applies, scope, method, weight, threshold] = m;
      const traits = applies.trim() === "공통" ? [] : applies.split(",").map((s) => s.trim());
      criteria.push({
        id,
        dimension: id.slice(0, 3),
        name,
        applies: applies.trim(),
        traits,
        scope: SCOPE_KO[scope.trim()] || scope.trim(),
        method: method.trim(),
        uses_script: method.split("+").map((s) => s.trim()).includes("S"),
        script_only: method.trim() === "S",
        weight: Number.isFinite(Number(weight)) ? Number(weight) : null,
        review_threshold: Number.isFinite(Number(threshold)) ? Number(threshold) : null,
        excluded_from_verdict: /판정 제외/.test(threshold),
      });
    }
  }
  return { criteria, rubricVersion };
}

// 적용 기준과 상태를 정한다. changed가 있으면 증분 상태(skipped-unchanged)도 정한다.
export function selectCriteria(criteria, profile, changed = null) {
  const traits = new Set(asArray(profile.design?.traits));
  const dims = profile.dimensions || {};
  const crit = profile.criteria || {};
  return criteria.map((c) => {
    const out = { ...c };
    const po = crit[c.id] || {};
    const pd = dims[c.dimension] || {};
    out.weight = po.weight ?? pd.weight ?? c.weight ?? 1.0;
    out.review_threshold = po.review_threshold ?? c.review_threshold ?? 50;
    if (c.traits.length && !c.traits.some((t) => traits.has(t))) {
      out.status = "not-applicable";
      out.status_reason = `traits 꺼짐: ${c.traits.join(", ")}`;
    } else if (pd.enabled === false) {
      out.status = "disabled";
      out.status_reason = pd.reason;
    } else if (po.enabled === false) {
      out.status = "disabled";
      out.status_reason = po.reason;
    } else if (changed && !changed.any) {
      out.status = "skipped-unchanged";
      out.status_reason = "바뀐 문서 없음";
    } else {
      out.status = "to-evaluate";
      if (changed && c.scope === "section") out.incremental_targets = changed.sections;
      else if (changed && c.scope === "document") out.incremental_targets = changed.documents.map((d) => ({ doc: d }));
      else if (changed) out.incremental_targets = "bundle";
    }
    return out;
  });
}

export function applicableIds(selected) {
  return selected.filter((c) => c.status === "to-evaluate").map((c) => c.id);
}
