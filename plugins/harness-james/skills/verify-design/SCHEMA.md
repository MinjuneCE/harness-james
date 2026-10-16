# 추출 결과 스키마 (`extract/0.1.0`)

`scripts/extract.mjs`의 출력이다. 판정하지 않는다. 모든 어휘·패턴은 프로파일에서 온다(`id_patterns`, `glossary`, `markers`, `script_hints`, `external_sources`, `baseline`, `bundle`). 프로파일이 주지 않는 언어 공통 기본 어휘(자리표시 `TODO·TBD·FIXME·???`, 시간 표현, 상태 낱말 등)는 `scripts/lib/util.mjs`의 `DEFAULT_VOCAB`이고 `script_hints`로 더할 수 있다.

## 목차

1. [파일](#1-파일) — 출력 파일 목록(extract.json, index, 차원 파일, `.input.json`, 절 색인, criteria)
2. [`extract.json`](#2-extractjson) — 최상위 필드
3. [후보 (`candidates[]`)](#3-후보-candidates) — 후보 형식, `doc_class`, `scope_state`
4. [기준 → 추출기](#4-기준--추출기) — 기준별 추출기·후보 종류 표, [구체 종류](#구체-종류-light-보고서의-표)
5. [원 추출 표 (`extract.*`) 요약](#5-원-추출-표-extract-요약)
6. [이력 맥락](#6-이력-맥락)
7. [알려진 한계](#7-알려진-한계)

## 1. 파일

| 파일 | 내용 |
|---|---|
| `extract.json` | 아래 2장. 전체(고정 사본 약 2MB). 스크립트(`verdict.mjs`·`report.mjs`)용 |
| `extract/index.json` | 판정자용 요약 색인: 실행 정보·프로파일 값(limits·외부 출처·수용 위험)·문서 목록·기준 상태·변경 집합·비용 추정·후보 수(기준별·종류별)·차원 파일 목록(`files[]`: 차원·기준·정본 쪽 후보 수·처리 목록 수·입력 문서만 후보 수와 파일·바이트·추정 토큰)·`obligated_candidates`(판정자 처리 목록 `[{id, criterion, kind}]`)·`deep_advice`(deep 권장 줄 또는 null) |
| `extract/<차원>.json` | 판정자용 차원 파일(11개, 정본 쪽). `criteria`(그 차원 기준 상태), `extractors`, `obligated`(이 차원의 처리 목록 후보 ID), `candidates`(구체 종류: 인용 120자·근거 3개까지 + `evidence_total`), `candidate_groups`(나머지 종류: (기준, 종류)별 `"후보ID 요지 @ 문서:줄"` 한 줄씩), `input_only`(`{count, by_criterion{기준: {종류: 수}}, file}` — 입력 문서에만 있는 후보는 개수만), `script_findings`, `raw`(후보로 옮기지 않은 작은 표는 그대로, 나머지는 개수만). 배열 원소는 한 줄씩 |
| `extract/<차원>.input.json` | 입력 문서(`source-material`·`review-input`)에만 근거가 있는 후보 목록(`candidates`·`candidate_groups`, 형식은 차원 파일과 같음). 그런 후보가 있는 차원만 |
| `section-index.json` | 절 해시 색인 `{schema, profile, profile_version, generated_at, docs: {<논리 경로>: {hash, lines, sections: {<절 키>: {hash, line_start, line_end}}}}}`. 절 키 = 제목 경로(`H1 > H2 > H3`, 같은 경로가 또 나오면 ` #2`). 마크다운이 아니면 파일 하나가 절 하나 |
| `criteria.json` | 루브릭 기준 표 + 적용 상태 `{id, dimension, name, traits, scope(section/document/bundle), method, uses_script, weight, review_threshold, status(to-evaluate/not-applicable/disabled/skipped-unchanged), status_reason, incremental_targets}` |

## 2. `extract.json`

| 필드 | 내용 |
|---|---|
| `schema`, `generated_at`, `label`, `level` | 실행 정보 |
| `profile` | `{key, version, rubric_version, path, traits}` |
| `rubric` | `{dir, version, criteria}` |
| `root`, `path_maps` | 워크스페이스 루트, `--map` 덮어쓰기 |
| `limits`, `external_sources`, `known_risks_accepted` | 프로파일에서 옮긴 판정·보고용 값 |
| `profile_errors[]` | 프로파일 검사 규칙(_schema 3장) 위반 |
| `documents[]` | `{path(논리), fs_path(실제, 루트 기준), role, canonical_for, reads_from, hash, lines, chars, tokens(추정), large(tokens > 25k = Read 한 번 한도 초과), sections}` |
| `unreadable[]` | `{path, reason: readable:false/exclude/binary-or-unknown-type}` |
| `outside_bundle_sources[]` | 묶음 밖 원 요구·원칙 문서 `{path, fs_path, missing}` |
| `estimate` | `{bundle_tokens, standard_usd, deep_usd(범위 = 판정 ×0.75 + 반증 0건 ~ 판정 ×1.25 + 반증 상한 건수), judge_usd{standard, deep}, refute_usd{standard, deep: {model, per, max, max_usd}}, basis, cost_line}` (framework 8.4, 보정 1회 기준) |
| `deep_advice` | traits에 `irreversible-effects`·`data-migration`이 있으면 "구현 직전·확정 때는 deep 권장 (traits: …)", 아니면 null. 정보만 |
| `changed` | 증분일 때 `{any, documents[], removed_documents[], sections[{doc, section, state: added/changed/removed}], previous_index}`, 아니면 `null` |
| `criteria_status[]` | `{id, status, reason, scope, method}` |
| `counts` | 기준별 후보 수 |
| `candidates[]` | 기준별 후보. 아래 3장 |
| `script_findings[]` | S 단독 기준(REQ-02) finding. framework 7.1 필드, `source: "script"`, 심각도는 참고값(`severity_note`) |
| `extract` | 원 추출 표. 아래 4장 |

## 3. 후보 (`candidates[]`)

```json
{
  "id": "C-CON-05-0123",
  "criterion": "CON-05",
  "kind": "retired-term-live",
  "summary": "은퇴 용어 \"X\" (→ Y)가 이력 맥락 없이 남음 [scenarios]",
  "evidence": [{"doc": "<논리 경로>", "section": "<절 키>", "line": 68, "quote": "<원문, 200자까지>"}],
  "applicable": true,
  "doc_class": "design | input | bundle",
  "scope_state": "changed | carried"
}
```

- `doc_class`: 근거가 모두 `source-material`·`review-input` 문서에만 있으면 `input`(정본 아님), 위치 없는 묶음 단위 후보는 `bundle`.
- `scope_state`는 증분일 때만. 범위 `절` 기준은 근거 절이, `문서` 기준은 근거 문서가 바뀌었으면 `changed`. `묶음` 기준은 바뀐 문서가 있으면 모두 `changed`.
- 후보 묶음 단위(같은 원인 하나): 요구 커버리지 빈칸은 출처·종류별 한 건, 모호한 번호 인용은 `(라벨, 번호)`별 한 건(`docs`, 근거 최대 6).

## 4. 기준 → 추출기

rubric에서 검사 방법에 `S`가 들어간 기준(22개)과 보조 S를 쓰는 EVD-01을 모두 덮는다. `test/coverage.test.mjs`가 rubric 표와 이 표(`scripts/lib/candidates.mjs`의 `CRITERION_EXTRACTORS`)를 대조한다.

| 기준 | 추출기(`extract.*`) | 후보 종류(`kind`) | 무엇을 뽑나 |
|---|---|---|---|
| CON-01 | `terms.forbidden_live`, `terms.identifier_variants` | forbidden-term, identifier-variant | 용어집 금지 동의어(이력 맥락 밖), 대문자 식별자 철자 변형·접미어 쌍(편집 거리 ≤2) |
| CON-02 | `numbers.config_conflicts`, `numbers.value_groups` | config-conflict, value-group | 설정 `키: 값`(코드 블록·코드 스팬)의 문서 간 다른 값; 같은 앞 낱말 뒤 시간 값이 문서마다 다른 묶음(초 단위로 정규화, ISO 8601 기간 포함) |
| CON-03 | `terms.fields` | field-not-in-data-model, field-unused | `data-model` 역할 문서의 snake_case 필드 대 계약·작업·계획·검증 문서 필드 양방향 차집합 |
| CON-04 | `terms.transitions` | transition-not-in-canonical | `A → B` 전이. 정본 = `script_hints.transitions_canonical` 또는 역할 순위(data-model > plan > spec > contract) 중 전이가 가장 많은 문서 |
| CON-05 | `terms.retired_live`, `ids.retired_references` | retired-term-live, retired-id-reference | 용어집 `retired*` 이름의 잔존(이력 맥락 줄 제외), 정의 줄에 이력 표지(합침·삭제 등)가 붙은 ID를 이력 맥락 없이 참조 |
| CON-07 | `ranges`, `baselines.header_mismatch` | range-mismatch, header-version, header-date | `X1~X38` 범위 표기 대 실제 정의(범위 밖·빠진 번호); 머리말 버전·날짜보다 늦은 값(같은 주 버전) |
| TRC-01 | `trace.uncited_source_ids`, `trace.no_design`, `trace.source_ids` | source-id-uncited, requirement-no-design, source-section-unmatched | 원 요구 출처(`section` 실제 절 제목·배열, 하위 절 포함, `lines` 범위로 좁힘, 생략 시 문서 전체)의 ID 중 다른 문서 인용 0건; 요구 종류 ID 중 설계 역할 문서 인용 0건 |
| TRC-02 | `trace.no_tasks`, `trace.no_verification`, `trace.coverage` | requirement-no-task, requirement-no-verification | 요구 ID별 작업·검증 문서 인용 수 |
| TRC-03 | `trace.uncited_elements` | element-uncited | 설계 문서의 설정 키·대문자 식별자 중 정의 절에 요구·결정 ID 인용이 없는 것 |
| REQ-01 | `requirements.vague_unmeasured` | vague-word | `script_hints.vague_words`가 나온 요구 문장 중 같은 줄에 수치가 없는 것 |
| REQ-02 | `placeholders` → `script_findings` | (finding) | 자리표시 토큰과 같은 줄의 담당·기한·결정 ID 유무. 원자료·점검 보고서 제외. 낱말을 언급만 하는 경우(따옴표·백틱 안, 뒤에 "라는·이라는·란·표시" 등)는 자리표시가 아니다 |
| REQ-05 | `requirements.flows`, `flows_without_acceptance` | flow-no-acceptance | 사용자 흐름 ID(`user-story` 또는 `script_hints.flow_kinds`) 정의 절의 수용 기준 표지 유무 |
| DEC-04 | `decisions.without_status`, `decisions.supersede_mentions` | decision-no-status | 결정 ID 정의 줄(+3줄)의 상태 낱말 유무, 대체 관계 언급 |
| EVD-01 (보조) | `evidence.secondary_source_lines` | secondary-source | 외부 주체 문장 중 2차 표지(회의·발언 등) |
| EVD-02 | `evidence.external_claims_unmarked` | external-claim-unmarked | `external_sources` 이름·별칭이 나온 문장 중 링크·출처·표지(미확인·추정·진술)가 없는 것. 원자료·점검 보고서 제외 |
| EVD-04 | `evidence.unverified_items` | unverified-missing-fields | 미확인 표지 줄의 담당·방법·영향 필드 유무 |
| EVD-05 | `numbers.unsourced_numbers`, `numbers.parameter_checks` | number-unsourced, parameter-mismatch(시간 아닌 키), parameter-key-not-found, parameter-cannot-compare | 설계 역할 문서의 수치+단위 중 앞뒤 1줄에 근거 표지(링크·출처 낱말·결정 ID·표지)가 없는 것; 프로파일 `parameters.compare_keys` 대조 |
| THR-03 | `threats.rows_without_id` | threat-row-no-id | 머리에 위협 낱말이 있는 표의 행 중 ID 인용이 없는 것 |
| FLR-03 | `numbers.timing_settings`, `numbers.parameter_checks` | timing-setting, parameter-mismatch(시간 키) | 키에 timeout·retry·interval·wait 등이 든 설정과 값; 프로파일 `parameters.<이름>.compare_keys`의 설정 값을 `relation`(gte: 설정 ≥ 값 · lte · eq)으로 대조. 기간 표기(`PT5S`)와 "10 초"는 초로 바꿔 비교, 못 바꾸면 cannot-compare |
| BND-01 | `duplicates.*`, `ids.duplicate_definitions` | duplicate-table-header, duplicate-line, similar-paragraph, id-defined-in-multiple-docs | 같은 표 머리(열 3개 이상), 같은 줄(40자 이상), 비슷한 문단(단어 2-gram Jaccard ≥ 0.5), 정의가 여러 문서에 있는 ID |
| BND-02 | `baselines.off_baseline`, `baselines.commit_values` | commit-off-baseline | `commit_pattern` 값 중 프로파일 `baseline` 커밋과 다른 것과 위치 |
| BND-03 | `references.*`, `ids.undefined_references`, `ids.ref_only_missing` | broken-link, broken-anchor, line-ref-out-of-range, id-undefined, ref-only-undefined, time-statement | 링크 대상·앵커 존재, `파일:줄` 참조의 줄 범위, 정의 없는 ID 참조(그 종류의 정의가 묶음에 있을 때, `ref_only` 종류 제외), `ref_only` 인용 번호가 `defined_in`의 번호 목록에 없음, 시간 표현 문장(아직·현재 등) |
| BND-04 | `ids.mixed_schemes`, `numbering.*` | mixed-scheme, dual-numbering, label-ref-ambiguous, label-ref-list-only, label-ref-undefined | 한 문서가 같은 종류의 ID 체계를 여럿 씀; 한 문서에 `<라벨> N` 제목 번호와 번호 목록이 함께 있음; 그 라벨 인용이 둘 다에 있음(모호)·목록에만 있음·어디에도 없음 |

### 구체 종류 (light 보고서의 표)

`scripts/lib/candidates.mjs`의 `CONCRETE_KINDS`. 이 중 정본 쪽(`doc_class` ≠ `input`) 후보가 판정자 처리 목록(`obligatedCandidates`)이다. 은퇴 이름·ID(retired-term-live, retired-id-reference) · 번호 체계 혼재(mixed-scheme, dual-numbering, label-ref-*) · 설정 충돌(config-conflict, parameter-mismatch) · 깨진 참조(broken-link, broken-anchor, line-ref-out-of-range, id-undefined, ref-only-undefined) · 범위·머리말(range-mismatch, header-version, header-date). light 보고서는 이 종류만 표로 보이고 나머지는 (기준, 종류)별 개수만 적는다. 차원 파일에는 모든 종류가 들어간다.

## 5. 원 추출 표 (`extract.*`) 요약

- `ids`: `definitions{id: [loc+kind+history]}`, `kinds_summary`, `duplicate_definitions`, `undefined_references`, `ref_only_checked`, `ref_only_missing`, `retired_ids`, `retired_references`, `mixed_schemes`, `mention_count`
  - `id_patterns` 값이 객체 `{pattern, ref_only, defined_in{path, lines, form}}`이면 `ref_only` 종류다. 정의로 세지 않고, 인용 번호를 `defined_in` 문서의 `lines` 범위 번호 목록과 대조한다.
  - 정의 판정: 제목 줄이 ID로 시작, 표 첫 칸이 ID, 목록 항목이 `**ID**`·`ID:`로 시작.
  - 선택 접두어가 붙은 매치(`<문서 이름> 결정 5`)는 패턴에 맞는 가장 짧은 꼬리를 ID로 쓴다(`qualifier`에 접두어).
- `numbering`: `dual_numbering[]`, `label_references[{label, number, class, target_doc, loc}]`
- `ranges[]`, `references{broken_links, broken_anchors, line_refs_out_of_range, unresolved_paths, time_statements}`
- `numbers{mention_count, config_conflicts, timing_settings, parameter_checks[{parameter, key, relation, status: ok/violated/key-not-found/cannot-compare/no-relation, value, value_seconds, expected, expected_seconds, timing, loc}], value_groups, unsourced_numbers, profile_parameters}`
- `terms{retired_live, retired_history_count, forbidden_live, identifier_variants, transitions{canonical, count, not_in_canonical}, fields}`
- `duplicates{table_headers, lines, similar_paragraphs}`, `placeholders[]`, `baselines{baseline, commit_values, off_baseline, doc_versions, header_mismatch}`
- `decisions{definitions, without_status, supersede_mentions}`, `trace{requirement_kinds, coverage, no_design, no_tasks, no_verification, source_ids, uncited_source_ids, uncited_elements}`
- `requirements{vague_unmeasured, flows, flows_without_acceptance}`, `evidence{unverified_items, unverified_missing_fields, external_claims_unmarked, external_claims_by_doc, secondary_source_lines}`, `threats{rows, rows_without_id}`
- 긴 목록은 `{total, items, truncated}`(기본 200, 일부 60–150)로 자른다.

## 6. 이력 맥락

줄에 프로파일 `markers.history_context` 낱말(또는 `~~`)이 있으면 그 줄은 이력 맥락이다. 이력 맥락 줄의 옛 이름·값·ID는 잔존·충돌로 세지 않는다(CON-02·05). 이 판정은 줄 단위 키워드라서 "정당한 언급인가"는 판단(L)이 마저 본다.

## 7. 알려진 한계

- 수치 묶음(`value_groups`)은 숫자 바로 앞 낱말로 묶는다. 같은 파라미터를 다른 낱말로 부르면 못 묶고, 다른 파라미터가 같은 낱말 뒤에 오면 섞인다. 후보일 뿐이다.
- 은퇴 ID는 "정의 줄에 이력 표지가 있다"로 정한다. 결정 내용에 '합침'이 들어간 결정 ID도 은퇴로 잡힐 수 있다.
- 커버리지는 ID 인용만 센다. ID 없이 내용으로 대응하는 문서는 0으로 나온다.
- 외부 주체 문장 추출은 별칭 일치라서 별칭이 일반 낱말이면 후보가 많다.
- **옛 버전과 비교한 낡은 진술은 잡지 않는다(L 몫).** 예: "설계 v0.2와 어긋나는 12곳"처럼 다른 문서의 옛 버전을 기준으로 말하는 문장. 프로파일 `history_context`에 버전 표기(`v0.2` 등)가 있으면 그 줄은 이력 맥락으로 빠지고, 버전 → 대상 문서 연결도 스크립트로는 확실하지 않다. 판정자가 BND-03·CON-05로 본다.
- 자리표시 언급 판단은 따옴표·인용 조사 규칙이라 "미정 항목은 없다"처럼 따옴표 없이 말하는 메타 문장은 여전히 잡힌다(standard 판정자가 거른다).
- 비용 추정(`lib/estimate.mjs`)은 한글 1자 ≈ 0.9토큰, ASCII 4자 ≈ 1토큰으로 센다. 계수는 판정 1k 토큰당 standard 0.092달러·deep 0.104달러 ±25%(반증 몫을 뺀 값), 반증 1건당 Opus 0.20달러·Fable 1.23달러 × 0건~상한이다. 다른 묶음으로 더 재서 고친다.
