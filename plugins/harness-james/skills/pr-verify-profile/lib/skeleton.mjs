// 새 레포 프로필의 뼈대. 훑은 사실로 채울 수 있는 칸만 채우고, 구조 목록과 dependents는 비워 둔다(판단이 필요한 칸).
export function skeleton({ inv, key, aliases = [], base, preset, rubricVersion = null, today }) {
  const name = inv.repo.name;
  // 별칭은 대소문자를 가리지 않고 찾으므로 그렇게 겹치는 것은 하나만 둔다
  const uniq = (a) => a.filter(Boolean).filter((x, i, all) => all.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
  return {
    $comment: `${name} 검증 프로파일. 필드 뜻은 pr-verify 스킬의 references/profile-guide.md, 산식 뜻은 framework.md. rubric${rubricVersion ? ` ${rubricVersion}` : ""}은 레포 무관 원칙이고, 적용 기준은 repo.traits로 고른다. ${today} 처음 만듦.`,
    version: "1.0.0",
    repo: {
      key, name, path: inv.repo.path, github: inv.repo.github,
      default_base: base ?? inv.repo.default_base_candidates[0] ?? null,
      aliases: uniq([key, ...aliases, name]),
      traits: inv.kind.traits,
    },
    dimensions: structuredClone(preset?.dimensions ?? {}),
    floors: structuredClone(preset?.floors ?? { dimension: 60, overall: 70 }),
    comment_syntax: inv.comment_syntax,
    ignore_line_patterns: inv.ignore_line_patterns,
    structures: [],
    coverage_ignore: inv.ignore_candidates.filter((c) => c.sure).map((c) => c.glob),
    long_lived_branches: [],
    dependents: [],
    ...(preset?.criteria ? { criteria: structuredClone(preset.criteria) } : {}),
    tools: [],
    secret_scan: { criterion: preset?.secret_scan?.criterion ?? "SEC-05", exclude: [] },
    parameters: { $comment: "판정 참고 파라미터. null은 미확인" },
  };
}
