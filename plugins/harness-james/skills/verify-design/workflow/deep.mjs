export const meta = {
  name: 'verify-design-deep',
  description: '설계 문서 묶음을 관점별(Opus 5.5)로 검증하고 집계한 뒤 high 이상을 Fable 5.1이 반증한다(읽기 전용)',
  whenToUse: '/verify-design deep — 사용자가 deep을 명시적으로 요청했을 때만',
  phases: [
    { title: 'Review', detail: '관점별 검토(구현자·운영자·공격자·검증자·결정 검토자), Opus 5.5', model: 'opus' },
    { title: 'Aggregate', detail: '중복 제거·같은 원인 합치기, Opus 5.5', model: 'opus' },
    { title: 'Refute', detail: 'critical·high 전부(최대 8건), 찾은 모델과 다른 Fable 5.1', model: 'fable' },
  ],
}

// args: `verdict.mjs workflow-args <RUN_DIR>`가 만든 <RUN_DIR>/workflow-args.json 내용을 그대로 넘긴다(손으로 모으지 않는다).
// 이 스크립트는 파일을 읽지 못한다.
//   run_dir, profile_path, extract_dir, criteria_path, rubric_dir, framework_path : 경로 문자열
//                 extract_dir = RUN_DIR/extract (index.json + <차원>.json, 판정자용 분할)
//   applicable  : 적용 기준 [{id, scope, method, weight}] (criteria.json의 status=to-evaluate)
//   documents   : [{path, fs_path, role, tokens, large}] (extract.json documents)
//   perspectives: reference/perspectives.json 내용 (관점 → 주 담당 기준·보조 기준·읽을 문서 역할)
//   incremental : 선택. {sections:[{doc,section,state}], carried_ids:[...]} — 바뀐 곳만 볼 때
//   refute_max  : 기본 8 (프로파일 limits.refute)
//   obligated_candidates : extract/index.json의 obligated_candidates [{id, criterion, kind}] — light 구체 후보(판정자 처리 목록).
//                 주 담당 관점이 후보마다 채택(finding ID)·기각(이유)을 candidate_dispositions에 적는다(출력 요건).
// 에이전트 유형은 항상 읽기 전용 정의 design-verify-judge(관점·집계)·design-verify-refuter(반증)다. 대체 경로는 없다(X3).
// 정의 설치 여부는 workflow-args가 미리 확인한다. 관점 결과가 하나도 없으면 멈춘다.
// 판정·반증 에이전트는 파일을 쓰지 않는다. 이 스크립트도 파일을 쓰지 못한다. 반환값을 호출한 쪽이 verdict.mjs save-workflow로 쓴다.
const A = args || {}
const REFUTE_MAX = A.refute_max || 8
const REFUTE_ORDER = '심각도(critical 먼저) → 신뢰도 낮은 것 먼저(possible → likely → confirmed) → R(c)'
// 플러그인 에이전트 이름은 '<플러그인 이름>:<파일 이름>'이다(scripts/verdict.mjs AGENT_TYPES와 같은 값).
const TYPES = { judge: 'harness-james:design-verify-judge', refuter: 'harness-james:design-verify-refuter' }
const typed = (role) => ({ agentType: TYPES[role] })
// 요청 모델 별칭(C6). 실행 모델 ID는 호출한 쪽이 트랜스크립트로 확인했을 때만 save-workflow --observed-*로 적는다.
const MODELS = { judge: 'opus', refuter: 'fable' }
const SEV = ['critical', 'high', 'medium', 'low', 'info']
const CONF = { confirmed: 1, likely: 0.7, possible: 0.4 }
const sevRank = (s) => SEV.length - SEV.indexOf(s)
const PTS = { critical: 60, high: 30, medium: 12, low: 4, info: 0 }
const pts = (f) => PTS[f.severity] * (CONF[f.confidence] || 0)

const EVIDENCE = {
  type: 'object',
  properties: {
    doc: { type: 'string' }, section: { type: 'string' }, line: { type: 'number' }, quote: { type: 'string' },
  },
  required: ['doc', 'line', 'quote'],
}
const FINDING = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    criterion: { type: 'string' },
    title: { type: 'string' },
    severity: { type: 'string', enum: SEV },
    confidence: { type: 'string', enum: ['confirmed', 'likely', 'possible'] },
    scope_state: { type: 'string', enum: ['changed', 'carried', 'resolved'] },
    method: { type: 'string' },
    evidence: { type: 'array', items: EVIDENCE },
    absence: {
      type: ['object', 'null'],
      properties: { searched: { type: 'array', items: { type: 'string' } }, queries: { type: 'array', items: { type: 'string' } }, result: { type: 'string' } },
    },
    touches: { type: 'array', items: { type: 'string' } },
    failure_scenario: { type: 'string' },
    rationale: { type: 'string' },
    recommendation: { type: 'string' },
    also_affects: { type: 'array', items: { type: 'string' } },
    open_check: { type: 'boolean' },
    perspectives: { type: 'array', items: { type: 'string' } },
    conflicts_with: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'criterion', 'title', 'severity', 'confidence', 'scope_state', 'method', 'touches', 'failure_scenario', 'recommendation'],
}
const CRIT_STATUS = {
  type: 'object',
  properties: { id: { type: 'string' }, status: { type: 'string', enum: ['evaluated', 'not-applicable', 'disabled', 'skipped-unchanged'] }, note: { type: 'string' } },
  required: ['id', 'status'],
}
const EXT_CHECK = {
  type: 'object',
  properties: { claim: { type: 'string' }, location: { type: 'string' }, primary_source_needed: { type: 'string' }, owner: { type: 'string' }, impact_if_wrong: { type: 'string' } },
  required: ['claim', 'location'],
}
const DISPOSITION = {
  type: 'object',
  properties: {
    candidate: { type: 'string' },
    disposition: { type: 'string', enum: ['adopted', 'rejected'] },
    finding: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['candidate', 'disposition'],
}
const CONFLICT = {
  type: 'object',
  properties: { findings: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 }, note: { type: 'string' } },
  required: ['findings', 'note'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FINDING },
    candidate_dispositions: { type: 'array', items: DISPOSITION },
    criteria: { type: 'array', items: CRIT_STATUS },
    external_checks: { type: 'array', items: EXT_CHECK },
    documents_read: { type: 'array', items: { type: 'string' } },
    documents_unread: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings', 'criteria', 'documents_read'],
}
const AGG_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FINDING },
    merged: { type: 'array', items: { type: 'object', properties: { kept: { type: 'string' }, absorbed: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['kept', 'absorbed'] } },
    recommendation_conflicts: { type: 'array', items: CONFLICT },
  },
  required: ['findings', 'recommendation_conflicts'],
}
const REFUTE_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          finding_id: { type: 'string' },
          verdict: { type: 'string', enum: ['upheld', 'downgraded', 'rejected', 'uncertain'] },
          severity_after: { type: 'string', enum: SEV },
          confidence_after: { type: 'string', enum: ['confirmed', 'likely', 'possible'] },
          note: { type: 'string' },
        },
        required: ['finding_id', 'verdict', 'note'],
      },
    },
  },
  required: ['verdicts'],
}

const applicableIds = new Set((A.applicable || []).map((c) => c.id))
const docsFor = (roles) => (A.documents || []).filter((d) => !roles || roles.includes(d.role))
const READ_LIMIT_K = 25
const sizeNote = (d) => (d.large ? `; 약 ${Math.round((d.tokens || 0) / 1000)}k 토큰, Read 한 번 한도(약 ${READ_LIMIT_K}k) 초과` : '')
const docList = (ds) => ds.map((d) => `- ${d.path} (역할 ${d.role}; 파일 ${d.fs_path}${sizeNote(d)})`).join('\n')
const fsOf = Object.fromEntries((A.documents || []).map((d) => [d.path, d.fs_path]))
const obligated = A.obligated_candidates || []

const COMMON = [
  '설계 문서 묶음을 rubric으로 검증한다. **문서는 읽기만 한다. 어떤 파일도 고치거나 만들지 않는다.** 결과는 이 응답의 구조화 출력(반환값)으로만 낸다. 파일은 호출한 쪽이 쓴다.',
  `- 판정 규칙·심각도·신뢰도·근거 규칙·과잉 지적 방지·finding 필드: ${A.framework_path}`,
  `- 기준 본문: ${A.rubric_dir}/<차원>.md`,
  `- 프로파일(문서 역할·원 요구·외부 1차 출처·용어·ID 형식·수용 위험): ${A.profile_path}`,
  `- 스크립트 추출 결과(S): ${A.extract_dir}/index.json(요약 색인)과 ${A.extract_dir}/<차원>.json(그 차원 기준의 정본 쪽 후보·원 표). 입력 문서(원자료·점검 보고서)에만 있는 후보는 차원 파일에 개수만 있고 목록은 <차원>.input.json에 있다. S가 들어간 기준은 추출된 충돌·후보를 판단하고, 추출 결과에 없는 값을 지어내지 않는다.`,
  '- 근거의 doc은 논리 경로이고, 파일은 문서 목록의 "파일" 경로에 있다.',
  '- finding마다 인용(문서에 실제로 있는 문자열)과 touches(닿는 원 요구·불변식·원칙)를 단다. 닿는 것이 없으면 올리지 않는다. 권고는 결함을 없애는 최소 변경이다.',
  '- 결함이 없는 기준도 criteria에 상태(evaluated 등)를 남긴다. 외부 사실에 기대는 주장은 external_checks에 올린다.',
  `- finding id 형식: F-<기준>-<관점키>-NN.`,
].join('\n')

const incrementalNote = A.incremental
  ? `\n증분 검증이다. 범위가 '절'인 기준은 아래 바뀐 절만, '문서'인 기준은 바뀐 문서만, '묶음'인 기준은 묶음 전체를 본다. 바뀌지 않은 곳의 결함은 이미 이월됐다(carried ${(A.incremental.carried_ids || []).length}건). 바뀐 절:\n${(A.incremental.sections || []).map((s) => `- ${s.doc} § ${s.section} (${s.state})`).join('\n')}\n`
  : ''

function reviewPrompt(p, primary) {
  const scopes = (A.applicable || []).filter((c) => primary.includes(c.id)).map((c) => `${c.id}(범위 ${c.scope}, 방법 ${c.method})`).join(', ')
  const mine = obligated.filter((c) => primary.includes(c.criterion))
  const mustRead = docsFor(p.must_read_roles || [])
  return [
    `너는 설계 검증의 **${p.name}** 관점 검토자다. ${p.lens}`,
    '',
    COMMON,
    '',
    `주 담당 기준(이 기준에만 finding을 올린다): ${scopes}`,
    p.secondary && p.secondary.length ? `보조로 같이 볼 기준(finding은 주 담당자 몫, 관련되면 also_affects에 적는다): ${p.secondary.filter((id) => applicableIds.has(id)).join(', ')}` : '',
    '',
    '이 관점에 필요한 문서(프로파일 역할 기준). 필요하면 다른 묶음 문서도 열어도 된다:',
    docList(docsFor(p.roles)),
    mustRead.length ? `\n원자료는 이 관점이 맡는다(다른 관점은 받지 않는다). 아래 문서가 documents_read에 없으면 documents_unread에 남는다:\n${docList(mustRead)}` : '',
    mine.length ? `\n출력 요건 — light 구체 후보 ${mine.length}건(이 관점의 주 담당 기준): candidate_dispositions에 후보마다 채택(disposition adopted, finding = finding id) 또는 기각(disposition rejected, reason)을 하나씩 적는다. 후보 본문은 ${A.extract_dir}/<차원>.json에 있다.\n${mine.map((c) => c.id).join(', ')}` : '',
    incrementalNote,
  ].filter(Boolean).join('\n')
}

phase('Review')
const persp = (A.perspectives || []).map((p) => ({ ...p, primary: (p.primary || []).filter((id) => applicableIds.has(id)) })).filter((p) => p.primary.length)
const skipped = (A.perspectives || []).filter((p) => !persp.some((q) => q.key === p.key)).map((p) => p.key)
if (skipped.length) log(`주 담당 기준이 모두 꺼져 건너뛴 관점: ${skipped.join(', ')}`)
const reviews = await parallel(persp.map((p) => () =>
  agent(reviewPrompt(p, p.primary), { label: `review:${p.key}`, phase: 'Review', model: 'opus', schema: REVIEW_SCHEMA, ...typed('judge') })
    .then((r) => (r ? { ...r, perspective: p.key, findings: (r.findings || []).map((f) => ({ ...f, perspectives: [p.key], source: 'judge', found_by_model: MODELS.judge })) } : null))))
const done = reviews.filter(Boolean)
const failedPersp = persp.filter((p, i) => !reviews[i]).map((p) => p.key)
if (failedPersp.length) log(`결과가 없는 관점: ${failedPersp.join(', ')} — 해당 기준은 상태 없음(평가 불완전)으로 남는다`)

if (!done.length) throw new Error(`관점 에이전트 결과가 하나도 없다(${persp.length}개 실패). 에이전트 정의 ${TYPES.judge}가 설치됐는지 확인하고 멈춘다.`)
const raw = done.flatMap((r) => r.findings)
log(`관점 ${done.length}/${persp.length} 완료 · finding ${raw.length}건`)

// 집계: 한 원인 = 한 finding, 가장 구체적인 기준 하나(framework 2장 중복 금지)
phase('Aggregate')
let aggregated = raw
let merged = []
let conflicts = []
if (raw.length > 1) {
  const agg = await agent([
    '여러 관점 검토자가 낸 설계 검증 finding을 합친다. **문서는 읽기만 한다.**',
    COMMON,
    '',
    '- 같은 원인이 여러 finding으로 나왔으면 하나로 합치고 근거를 모은다. 기준은 가장 구체적인 하나만 남기고 나머지는 also_affects로 옮긴다.',
    '- 합칠 때 심각도·신뢰도는 근거가 받쳐 주는 쪽으로 정한다. 합친 결과는 merged에 남긴다.',
    '- 새 결함을 찾지 않는다. 합치지 않은 finding은 그대로 돌려준다(id 유지).',
    '- 출력 요건: 권고가 서로 반대 방향인 finding(한쪽은 빼라, 다른 쪽은 그것에 기대는 장치가 없다 등)은 recommendation_conflicts에 짝(findings 2개)과 어긋나는 점(note)으로 적고, 두 finding의 conflicts_with에 상대 ID를 적는다. 어느 쪽도 지우거나 고치지 않는다. 없으면 빈 배열.',
    '',
    'finding 목록(JSON):',
    JSON.stringify(raw),
  ].join('\n'), { label: 'aggregate', phase: 'Aggregate', model: 'opus', schema: AGG_SCHEMA, ...typed('judge') })
  if (agg && Array.isArray(agg.findings)) {
    aggregated = agg.findings.map((f) => ({ ...f, source: 'judge', found_by_model: MODELS.judge }))
    merged = agg.merged || []
    conflicts = agg.recommendation_conflicts || []
  } else {
    log('집계 결과가 없어 관점별 finding을 그대로 쓴다(중복 가능)')
  }
}

// 반증 대상(사용자 결정 2026-10-16): critical·high 전부, 최대 REFUTE_MAX건.
// 순서: 심각도(critical 먼저) → 같은 심각도 안에서 신뢰도 낮은 것 먼저(possible → likely → confirmed) → 기준 위험도 R(c) 높은 순.
// 상한 밖은 반증하지 않는다(→ 판정 단계에서 uncertain, note "not-refuted: cap", REVIEW_REQUIRED)
phase('Refute')
const weight = Object.fromEntries((A.applicable || []).map((c) => [c.id, c.weight == null ? 1 : c.weight]))
const riskSum = {}
for (const f of aggregated) if (f.criterion !== 'BND-06') riskSum[f.criterion] = (riskSum[f.criterion] || 0) + pts(f)
const R = (id) => Math.min(100, (weight[id] == null ? 1 : weight[id]) * (riskSum[id] || 0))
const high = aggregated.filter((f) => sevRank(f.severity) >= sevRank('high'))
  .sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || (CONF[a.confidence] || 0) - (CONF[b.confidence] || 0) || R(b.criterion) - R(a.criterion))
const targets = high.slice(0, REFUTE_MAX)
const overCap = high.slice(REFUTE_MAX).map((f) => f.id)
if (overCap.length) log(`반증 상한 ${REFUTE_MAX}건 밖: ${overCap.join(', ')} — 반증하지 않고 사람 검토로 넘긴다`)
const chunks = []
const per = Math.max(2, Math.ceil(targets.length / 3)) // 반증 에이전트는 최대 3개
for (let i = 0; i < targets.length; i += per) chunks.push(targets.slice(i, i + per))
const refuted = await parallel(chunks.map((chunk, i) => () =>
  agent([
    '너는 설계 검증 finding의 **반증자**다. 아래 finding이 틀렸음을 보이려고 시도한다. 맞는 finding은 그대로 둔다. **문서는 읽기만 한다.** 결과는 반환값으로만 낸다.',
    `- 판정 규칙·심각도 앵커: ${A.framework_path}, ${A.rubric_dir}/<차원>.md · 프로파일: ${A.profile_path} · 추출 결과: ${A.extract_dir}/index.json, ${A.extract_dir}/<차원>.json`,
    '- verdict: upheld(반례 없음, 근거 확인) · downgraded(문제는 있으나 과함, severity_after 필수) · rejected(구체적 반증 위치가 있음) · uncertain(묶음 밖 사실·사용자 의도에 달림)',
    '- 반례의 예: 다른 문서의 정본 문장이 이미 해결함, 인용이 문맥상 이력 서술임, 프로파일 수용 위험(known_risks_accepted)에 있음, 원 요구에 닿지 않음.',
    '- note에 근거 위치(문서:줄)를 적는다.',
    '- finding 근거의 doc은 논리 경로이고, 실제 파일은 각 근거의 file이다. 묶음 문서 목록의 "파일"도 같다.',
    '',
    '묶음 문서:',
    docList(docsFor(null)),
    '',
    '대상 finding(JSON):',
    JSON.stringify(chunk.map((f) => ({ ...f, evidence: (f.evidence || []).map((e) => ({ ...e, file: fsOf[e.doc] || e.doc })) }))),
  ].join('\n'), { label: `refute:${i + 1}`, phase: 'Refute', model: 'fable', schema: REFUTE_SCHEMA, ...typed('refuter') })))
const verdicts = refuted.filter(Boolean).flatMap((r) => r.verdicts || [])
const missingRefute = targets.filter((t) => !verdicts.some((v) => v.finding_id === t.id)).map((t) => t.id)
if (missingRefute.length) log(`반증 결과 없음: ${missingRefute.join(', ')} — 판정 단계에서 평가 불완전`)

// 기준 상태: 관점별 상태를 모은다(주 담당 관점의 것만)
const criteria = []
for (const r of done) {
  const p = persp.find((q) => q.key === r.perspective)
  for (const c of r.criteria || []) if (p.primary.includes(c.id) && !criteria.some((x) => x.id === c.id)) criteria.push(c)
}

// light 구체 후보 처리: 관점별 결과를 모으고, 집계에서 합쳐진 finding id는 남은 id로 바꾼다
const absorbedTo = {}
for (const m of merged) for (const id of m.absorbed || []) absorbedTo[id] = m.kept
const dispositions = []
for (const r of done) {
  const p = persp.find((q) => q.key === r.perspective)
  for (const d of r.candidate_dispositions || []) {
    const c = obligated.find((o) => o.id === d.candidate)
    if (c && !p.primary.includes(c.criterion)) continue
    if (dispositions.some((x) => x.candidate === d.candidate)) continue
    dispositions.push(d.finding && absorbedTo[d.finding] ? { ...d, finding: absorbedTo[d.finding], finding_before_merge: d.finding } : d)
  }
}
const missingDisp = obligated.filter((c) => persp.some((p) => p.primary.includes(c.criterion)) && !dispositions.some((d) => d.candidate === c.id)).map((c) => c.id)
if (obligated.length) log(`light 구체 후보 ${obligated.length}건 중 처리 ${dispositions.length}건${missingDisp.length ? ` · 누락 ${missingDisp.length}건(verdict.mjs check가 오류로 낸다)` : ''}`)

// 미독 문서: 관점별 목록을 단순 합산하지 않는다. 어느 관점이든 읽은 문서는 뺀다(B1). 자유 문자열은 앞의 경로만 본다.
const head = (s) => String(s).normalize('NFC').trim().split(/\s+\(|\s+\d+\s*[-–~]\s*\d+|:\d/)[0].trim()
const readHeads = new Set(done.flatMap((r) => r.documents_read || []).map(head))
const unreadAll = [...new Set(done.flatMap((r) => r.documents_unread || []))]
const unreadLeft = unreadAll.filter((s) => !readHeads.has(head(s)))
if (unreadAll.length) log(`관점별 미독 ${unreadAll.length}개 중 어느 관점도 읽지 않은 것 ${unreadLeft.length}개 (묶음 문서 여부는 verdict.mjs가 정리)`)

return {
  judge: {
    schema: 'findings/0.1.0',
    level: 'deep',
    models: MODELS,
    perspectives: persp.map((p) => p.key),
    perspectives_skipped: skipped,
    perspectives_failed: failedPersp,
    findings: aggregated,
    merged,
    recommendation_conflicts: conflicts,
    candidate_dispositions: dispositions,
    criteria,
    external_checks: done.flatMap((r) => r.external_checks || []),
    documents_read: [...new Set(done.flatMap((r) => r.documents_read || []))],
    documents_unread: unreadLeft,
    documents_unread_raw: unreadAll.length,
  },
  refutation: { model: MODELS.refuter, max: REFUTE_MAX, order: REFUTE_ORDER, targets: targets.map((t) => t.id), over_cap: overCap, failed: missingRefute, verdicts },
  stats: { reviewers: done.length, raw: raw.length, aggregated: aggregated.length, refuted: verdicts.length, agents: persp.length + (raw.length > 1 ? 1 : 0) + chunks.length, types: TYPES },
}
