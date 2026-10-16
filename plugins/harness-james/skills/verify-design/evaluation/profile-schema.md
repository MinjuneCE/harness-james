# 설계 검증 프로파일 — 필드 정의

- 버전: 0.2.0 (2026-10-16)
- 파일: 프로젝트의 `docs/evaluation/design/profiles/<key>.json` 하나가 설계 묶음 하나(또는 같은 규칙을 쓰는 묶음 무리)를 맡는다
- 원칙: rubric은 고정 핵심이다. 프로파일은 **선택**(어떤 기준), **조정**(가중치·임계값·상한), **추가**(자체 질문·사실)만 한다. 핵심에서 벗어나면(끄기·임계값 완화) 이유를 적는다
- 도메인·벤더·제품 이름, 문서 경로, 수치 값은 프로파일에만 둔다

## 1. 필드 요약

| 필드 | 필수 | 내용 | 쓰는 기준 |
|---|:-:|---|---|
| `version` | ● | 프로파일 버전 (semver) | — |
| `rubric_version` | ● | 맞춘 rubric 버전 | — |
| `profile` | ● | `key`, `name`, `description`, `owner` | — |
| `level` | | `light` / `standard` / `deep` (생략 시 `standard`) | framework 8.2 |
| `design.traits` | ● | 켤 trait 목록 ([traits.md](../traits.md)) | 모든 trait 기준 |
| `bundle` | ● | 검증 대상 문서와 역할 | 전부 |
| `requirement_sources` | ● | 원 요구 문서 | TRC-01·03·04 |
| `external_sources` | external-integration이면 ● | 외부 시스템별 1차 출처 | EVD-01·02·05, FLR, QAS-02 |
| `id_patterns` | multi-doc이면 ● | ID 형식(정규식) | BND-04, TRC, CON-05 |
| `glossary` | | 정본 용어·금지 동의어 | CON-01 |
| `principles` | | 프로젝트 원칙 문서 | DEC-05 |
| `baseline` | | 근거로 쓰는 코드·문서의 기준 시점 | BND-02, BEH-08 |
| `markers` | | 출처·확인 상태 표지 어휘 | EVD-02·04, REQ-02 |
| `dimensions` | | 차원 가중치·끄기 | 판정 |
| `criteria` | | 기준 가중치·임계값·끄기 | 판정 |
| `limits` | | finding 상한 | 과잉 지적 방지 6장 |
| `parameters` | | 수치 예산·외부 한도 | QAS-02, EVD-05, FLR-03 |
| `known_risks_accepted` | | 이미 수용한 위험 | 과잉 지적 방지 6장 |
| `extra_questions` | | 프로젝트 자체 판정 질문 | 해당 기준 |
| `script_hints` | | 스크립트 추출 보조 정보 | S 검사 |

## 2. 필드 상세

### `level`

| 값 | 뜻 | 쓰는 때 |
|---|---|---|
| `light` | 스크립트(S) 검사만, LLM 판단 없음. `S+L` 기준은 추출된 충돌 후보만 보고하고 판정하지 않는다. 판정·반증 없음 | 문서를 고칠 때마다 |
| `standard` | 적용 기준 전부를 Fable 5.1 한 세션이 1회 검증. high 이상은 다른 모델이 반증 | 설계 중간 확인(기본) |
| `deep` | 적용 기준 전부를 Opus 5.5 워크플로가 관점별로 나눠 검증. high 이상은 다른 모델이 반증 | 구현 시작 직전·설계 확정 때 |

- `level`은 비용 단계다(framework 8.2). 단계에 따라 임계값은 바뀌지 않는다.
- 생략하면 `standard`다. 사용자는 실행할 때 시점에 맞춰 언제든 바꿀 수 있다. level은 자동으로 바뀌지 않는다.
- `design.traits`에 `irreversible-effects` 또는 `data-migration`이 있으면 `deep`이 아닌 실행의 리포트에 "deep 권장" 한 줄이 보인다(정보만).
- 프로파일의 `level`은 이 묶음의 평소 기본값이다. 구현 직전에 `deep`으로 돌리는 것은 실행 인자로 한다.

```json
"level": "standard",
"level_reason": "설계 중간 확인용 기본값. 구현 시작 직전·설계 확정 때는 deep으로 실행"
```

### `design.traits`

```json
"design": { "traits": ["multi-doc", "state-machine"], "traits_note": "켠 이유 한두 줄" }
```

### `bundle`

검증 대상 문서와 역할. 역할 이름은 범용 목록에서 고른다. 파일 경로는 여기에만 둔다.

| 역할 | 뜻 |
|---|---|
| `overview` | 묶음 입구·요약·변경 기록 |
| `requirement` | 원 요구(사용자 결정·요청). `requirement_sources`와 같이 쓴다 |
| `spec` | 기능 명세(요구·수용 기준) |
| `plan` | 설계·구현 계획 |
| `data-model` | 저장 구조 |
| `contract` | 외부·내부 인터페이스 계약 |
| `tasks` | 작업 목록 |
| `verification` | 검증 계획·불변식·테스트 환경 |
| `scenarios` | 시나리오·예시 |
| `decision-log` | 결정 기록 |
| `research` | 근거 조사·결정 근거 |
| `review-input` | 점검 보고서·외부 입력 분석(정본 아님, 결함 근거로만 씀) |
| `source-material` | 원자료(메일·회의록·데이터). 1차·2차 판단 대상 |

```json
"bundle": {
  "roots": ["<경로>"],
  "documents": [
    {"path": "<경로>", "role": "plan", "canonical_for": ["상태 전이", "알림"]},
    {"path": "<경로>", "role": "scenarios", "reads_from": ["<정본 경로>"]}
  ],
  "exclude": ["<경로 glob>"]
}
```

- `canonical_for`: 이 문서가 정본인 주제(BND-01). 같은 주제의 정본이 둘이면 프로파일 오류다.
- `reads_from`: 이 문서가 따라야 하는 정본(CON-05의 전파 방향).
- `exclude`: 읽지 않을 파일(바이너리 등). 원자료지만 못 읽는 파일은 `source-material`로 두고 `readable: false`를 붙인다.
- `exclude`·`readable: false`는 **의도적 제외**다. 미평가로 세지 않고 리포트의 "제외 문서"에만 적는다(framework 8.1).

### `requirement_sources`

원 요구가 있는 곳. 제거 시험(TRC-03)은 여기 있는 문장만 원 요구로 본다. 설계 문서 안의 요구·해석·가정은 파생 요구다.

```json
"requirement_sources": [
  {"path": "<경로>", "section": "<실제 절 제목>", "kind": "user-decision", "date": "YYYY-MM-DD", "note": "…"},
  {"path": "<경로>", "section": ["<절 제목 1>", "<절 제목 2>"], "kind": "user-decision"},
  {"path": "<경로>", "section": "<절 제목>", "lines": "11-20", "kind": "user-decision", "note": "절 안의 일부 블록"}
]
```

- `section`: 문서의 **실제 절 제목**을 그대로(마크다운 `#` 기호만 빼고, 백틱·괄호 포함) 적는다. 여러 절이면 배열로 적는다. 설명 문구("머리말 Input", "확정인 행만")는 `section`에 넣지 않고 `note`에 둔다. 제목 하나는 그 아래 하위 절까지 포함한다.
- `section`을 생략하면 문서 전체가 원 요구다.
- `lines`: 절 안의 일부 블록만 원 요구일 때 줄 범위(`"시작-끝"`). 절 제목이 없는 머리말 블록·인용 블록에 쓴다. 문서가 바뀌면 다시 맞춘다(BND-02 대상).
- 맞는 절이 없으면 프로파일 오류다(3장).

- `kind`: `user-decision`(요구 당사자의 결정) · `user-request`(요청 원문) · `principle`(원칙 문서) · `external-contract`(외부와 합의한 문서) · `meeting`(회의 결정 기록. 2차로 취급하되 당사자가 확정했으면 `user-decision`)
- `supersedes`: 이 출처가 대체한 이전 출처(있으면).

### `external_sources`

외부 시스템마다 무엇이 1차인지. 원칙(1차 > 2차, 충돌은 드러냄)은 rubric EVD-01에 있다. 여기에는 시스템별 출처 목록만 둔다.

```json
"external_sources": [
  {
    "system": "<외부 시스템 이름>",
    "aliases": ["<문서에 나오는 다른 이름>"],
    "primary": [
      {"kind": "official-docs", "where": "<URL 또는 위치>", "verified": true},
      {"kind": "party-answer", "where": "<당사자 서면 답 위치>"},
      {"kind": "measured-data", "where": "<실측·조회 결과 위치>"}
    ],
    "secondary_examples": ["회의 발언", "내부 팀의 추측"],
    "pending_confirmations": "<외부 확인 목록 위치>"
  }
]
```

- `verified: false`면 그 출처를 프로파일 작성자가 열어 보지 못했다는 뜻이다. 판정은 그 출처에 기댄 finding을 `likely` 이하로 둔다.
- `aliases`는 EVD-02 스크립트가 "외부 주체가 주어인 문장"을 뽑는 데 쓴다.

### `id_patterns`

```json
"id_patterns": {
  "requirement": "FR-\\d{3}",
  "decision": "D\\d{1,2}",
  "assumption": "A\\d{1,2}",
  "scenario": "S-[A-Z]-\\d{2}",
  "task": "T\\d{3}",
  "verification": "V\\d{1,2}[a-z]?"
}
```

- 키는 범용 종류(`requirement`·`user-story`·`success-criterion`·`decision`·`assumption`·`scenario`·`task`·`verification`·`open-question`·`risk`)를 쓴다. 필요하면 더한다.
- 같은 종류에 체계가 둘이면 `"decision": ["D\\d+", "결정 \\d+"]`처럼 배열로 두고 `id_notes`에 구분을 적는다. 둘이라는 사실 자체가 BND-04 후보다.
- 패턴은 **정의가 묶음 안에 있는 ID**만 둔다. 번호 목록 항목(요약 1~8 등)처럼 ID 정의 형태가 아닌 번호를 인용하는 표기는 `ref_only`로 따로 둔다. 일반 패턴에 넣으면 "정의 없는 참조" 후보가 된다.

```json
"id_patterns": {
  "decision-summary-ref": {"pattern": "\\[wait\\] 요약 \\d", "ref_only": true,
    "defined_in": {"path": "<경로>", "lines": "3-13", "form": "numbered-list"}}
}
```

- `ref_only: true`: 정의 없는 참조로 세지 않는다. 대신 `defined_in` 목록에 그 번호가 있는지를 본다(BND-03·04).
- 값이 문자열·배열이면 일반 패턴, 객체면 `pattern`과 선택 필드(`ref_only`, `defined_in`)를 갖는다.

### `glossary`

```json
"glossary": {
  "path": "<용어집 위치 또는 null>",
  "terms": [{"term": "<정본 용어>", "forbidden": ["<동의어>"], "retired": ["<폐기된 옛 이름>"]}]
}
```

- `retired`: 개명·병합으로 사라진 이름. CON-05 잔존 검사에 쓴다.

### `principles`

```json
"principles": [{"path": "<원칙 문서>", "must_marker": "MUST|NON-NEGOTIABLE", "should_marker": "SHOULD"}]
```

### `baseline`

```json
"baseline": [{"target": "<레포·문서>", "ref": "<브랜치>", "commit": "<sha>", "as_of": "YYYY-MM-DD"}]
```

### `markers`

출처 등급·확인 상태 표지의 어휘. 언어·팀마다 달라서 프로파일에 둔다.

```json
"markers": {
  "unverified": ["미확인", "(미확인)"],
  "inferred": ["추정", "(해석)"],
  "statement": ["사용자 진술"],
  "placeholder": ["TBD", "TODO", "미정"],
  "history_context": ["삭제", "폐기", "대체됨"]
}
```

- `history_context`: 이 표지가 붙은 줄의 옛 이름·값은 잔존으로 세지 않는다(CON-02·05).

### `dimensions`·`criteria`

```json
"dimensions": { "THR": {"enabled": false, "reason": "…"}, "BEH": {"weight": 1.5} },
"criteria": {
  "CON-05": {"weight": 1.5, "review_threshold": 30},
  "BND-06": {"enabled": false, "reason": "…"}
}
```

- `enabled: false`에는 `reason`이 필수다. 이유 없는 끄기는 프로파일 오류다.
- trait 때문에 이미 꺼진 기준은 적지 않는다.
- 임계값을 rubric 권장값보다 높이면(완화) `reason`을 적는다.

### `limits`

```json
"limits": {"total": 50, "per_criterion": 5, "low_info": 10, "refute": 8}
```

- `refute`: 한 번의 검증에서 반증하는 critical·high finding 수. 기본 8. 넘치면 심각도 → 확신 낮은 것(possible → likely → confirmed) → R(c) 순으로 고르고, 상한 밖은 `uncertain` → REVIEW_REQUIRED(framework 8.3).

### `parameters`

수치 예산과 외부 한도. 값마다 출처를 단다(EVD-05와 같은 규칙).

```json
"parameters": {
  "<이름>": {"value": 0, "unit": "<단위>", "source": "<출처 또는 '가정'>",
             "compare_keys": ["<설정 키>"], "relation": "gte"}
}
```

- `compare_keys`: 이 값과 비교할 설계 문서의 설정 키 목록(선택). 스크립트가 묶음에서 그 키의 값을 뽑아 이 값과 대조한다(EVD-05·FLR-03·QAS-02 후보). 키 이름은 설계 문서에 나오는 그대로 쓴다.
- `relation`: 설정 값과 이 값의 관계. `gte`(설정 ≥ 값) · `lte`(설정 ≤ 값) · `eq`. `compare_keys`가 있으면 필수다. 관계가 깨지면 후보다.
- 단위가 다르면(기간 표기 `PT5S`와 "10초" 등) 비교 전에 같은 단위로 바꾼다. 바꿀 수 없으면 후보로만 낸다.

### `known_risks_accepted`

이미 수용한 위험. 같은 내용은 `info`로만 남긴다.

```json
"known_risks_accepted": [
  {"id": "KR-01", "criteria": ["QAS-04"], "summary": "…", "accepted_by": "<역할>", "date": "YYYY-MM-DD", "where": "<기록 위치>", "recheck_when": "<다시 볼 조건>"}
]
```

- `recheck_when` 조건이 충족됐으면 다시 올린다.

### `extra_questions`

프로젝트 자체 판정 질문. 도메인 이름을 써도 되는 유일한 질문 구역이다. 기준 하나에 붙인다.

```json
"extra_questions": [{"criterion": "EVD-02", "question": "…"}]
```

### `script_hints`

스크립트 추출을 돕는 보조 정보. 판정 기준이 아니다.

```json
"script_hints": {
  "number_units": ["분", "시간", "초", "PT\\d+[HMS]"],
  "state_name_pattern": "\\b[A-Z][A-Z_]{2,}\\b",
  "vague_words": ["즉시", "적절히", "빠르게"]
}
```

## 3. 검사 규칙 (프로파일 오류)

- `bundle.documents`의 경로가 없다
- 같은 주제에 `canonical_for`가 둘 이상
- `enabled: false`·임계값 완화에 `reason` 없음
- external-integration trait인데 `external_sources` 없음
- multi-doc trait인데 `id_patterns` 없음
- `requirement_sources`가 비었다
- `requirement_sources.section`의 제목과 맞는 절이 문서에 없다
- `parameters`에 `compare_keys`가 있는데 `relation`이 없다
