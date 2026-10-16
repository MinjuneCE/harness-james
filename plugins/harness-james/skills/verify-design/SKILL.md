---
name: verify-design
description: 설계 검증. 구현 전 설계 문서 묶음(명세·계획·데이터 모델·계약·작업·시나리오·결정 기록)을 프로파일과 루브릭으로 검증해 REVISE·REVIEW_REQUIRED·PROCEED를 판정하고 리포트를 남긴다. level은 비용 단계다 — light(스크립트 추출만, LLM 없음) · standard(Fable 5.1 1회 + Opus 반증, 기본) · deep(Opus 5.5 관점별 워크플로 + Fable 반증). standard·deep은 비용이 커서 모델 자동 호출을 막았다. 사용자가 /harness-james:verify-design으로 직접 실행한다.
disable-model-invocation: true
argument-hint: "<프로파일 이름|경로> [light|standard|deep] [--changed-since <색인|latest>] [--label <라벨>] [--map <논리=실제>] [--reports-dir <폴더>]"
---

# /harness-james:verify-design — 설계 문서 묶음 검증

인자: `$ARGUMENTS`

이 스킬은 **무엇을 볼지, 입력, 출력, 모드 구성, 안전 규칙**만 정한다. 판정 에이전트가 문서를 어떤 순서로 어떻게 읽을지는 정하지 않는다.

런타임: Node 18 이상. 스크립트는 Node 내장 모듈만 쓰고 외부 패키지·CLI 설치가 필요 없다.

- 무엇을 볼지·어떻게 판정할지(스킬에 함께 배포, 읽기 전용): `${CLAUDE_SKILL_DIR}/evaluation/framework.md`(범위·심각도·신뢰도·근거·과잉 지적 방지·finding 필드·쓰기 주체·판정 규칙), `evaluation/rubrics/*.md`(59기준), `evaluation/traits.md`, 프로파일 필드 `evaluation/profile-schema.md`. 다른 기준을 쓰려면 `extract.mjs --rubric-dir`로 바꾼다(형제 `../framework.md`·`../traits.md`도 같이 바뀐다).
- 프로젝트 고유 값(문서 경로·역할, 원 요구, 외부 1차 출처, ID 형식, 용어집, 표지 어휘, 수치·비교 키, 수용 위험, 상한)은 모두 프로파일(프로젝트의 `docs/evaluation/design/profiles/<이름>.json`)에서 온다. 스킬에는 프로젝트·도메인 이름이 없다. 합성 예시: `${CLAUDE_SKILL_DIR}/test/fixtures/bundle-a/profile.json`.
- 프로젝트 데이터(프로파일·보고서·작업 폴더)는 프로젝트 루트(작업 디렉터리에서 위로 찾은 `.git`) 아래 `docs/evaluation/design/`에 둔다. 스킬 폴더(플러그인 설치 경로)에는 아무것도 쓰지 않는다.

## 1. 안전 규칙

1. **설계 문서는 절대 고치지 않는다.** 판정·반증 에이전트(`harness-james:design-verify-judge`·`harness-james:design-verify-refuter`)는 Read·Grep·Glob만 가진 읽기 전용 정의다. 결과는 JSON 최종 답(반환값)으로만 돌려준다(framework 7.3).
2. 파일은 **호출한 쪽**(이 스킬을 실행하는 세션, deep은 그 세션이 워크플로 반환값으로)만 쓴다. 쓰는 도구는 `scripts/verdict.mjs`·`scripts/report.mjs`·`scripts/extract.mjs`이고, 쓰는 곳은 보고서 폴더(기본 `docs/evaluation/design/reports/<profile>/`, `--reports-dir`로 바꿈)뿐이다.
3. standard·deep을 시작하기 전에 비용 줄(3장)을 사용자에게 보인다. light는 비용이 없다.
4. deep은 사용자가 deep을 명시적으로 요청했을 때만 쓴다. 지정이 없으면 standard다. traits에 되돌릴 수 없는 부작용(`irreversible-effects`)이나 데이터 이전(`data-migration`)이 있으면 light·standard 보고서와 최종 응답에 "구현 직전·확정 때는 deep 권장" 한 줄을 보인다. 정보만 주고 level은 바꾸지 않는다.
5. 반증은 **finding을 찾은 모델과 다른 모델**이 한다. 같은 모델의 반증은 `verdict.mjs check`가 오류로 낸다.
6. 외부 사실(외부 시스템 동작)은 조회하지 않는다. 1차 출처 위치를 외부 확인 목록에 올린다(framework 1.2).

## 2. 입력

| 인자 | 뜻 | 기본 |
|---|---|---|
| 첫 인자 | 프로파일 이름(`profiles/<이름>.json`) 또는 경로 | 필수 |
| level | `light` · `standard` · `deep` | `standard` (프로파일 `level`은 참고만, deep은 명시 요청 때만) |
| `--changed-since` | 이전 절 해시 색인 경로, 또는 `latest`(보고서 폴더의 가장 최근 `*.index.json`) | 없음(전체 검증) |
| `--label` | 보고서 이름에 붙일 라벨 | `full` 또는 `incr` |
| `--map 논리=실제` | 프로파일 경로 접두어를 바꿔 읽기(고정 사본 시험용, 여러 번 가능) | 없음 |
| `--reports-dir` | 보고서 폴더(프로젝트 루트 기준) | `docs/evaluation/design/reports` |

## 3. 출력

- `<reports>/<profile>/<YYYY-MM-DD>-<라벨>.md` — 보고서(framework 7.2 형식, `templates/report.md`)
- `<reports>/<profile>/<YYYY-MM-DD>-<라벨>.findings.json` — finding(`templates/findings.schema.json`)
- `<reports>/<profile>/<YYYY-MM-DD>-<라벨>.index.json` — 절 해시 색인(다음 `--changed-since`의 기준)
- 작업 폴더 `RUN_DIR = <reports>/<profile>/runs/<YYYY-MM-DD>-<라벨>/`
  - 추출: `extract/index.json`(요약 색인) + `extract/<차원>.json`(판정자용 분할) · `extract.json`(전체, 스크립트용) · `criteria.json` · `section-index.json` · `evaluation/`(판정 기준 복사본: 기준이 프로젝트 밖일 때. 에이전트는 이 경로를 받는다)
  - 판정·반증(`verdict.mjs save-*`가 씀): `judge/findings.json` · `refutation/targets.json` · `refutation/result.json`
  - 스크립트가 채운 에이전트 입력: `judge-prompt.md`(standard 판정) · `refutation/prompt.md`(standard 반증) · `workflow-args.json`(deep args) · `deep.mjs`(deep 워크플로 복사본)
  - 최종(`verdict.mjs finalize`): `findings.json` · `verdict.json`

**비용 줄**: 추출 출력의 비용 줄을 그대로 보인다. 예(161k 토큰 묶음, 반증 상한 8): `묶음 약 161k 토큰 · standard 11–20달러 = 판정 11–19달러(1k 토큰당 0.092 ±25%) + 반증 0–1.60달러(Opus 건당 0.20 × 0–8건) · deep 13–31달러 = 판정 13–21달러(1k 토큰당 0.104 ±25%) + 반증 0–9.84달러(Fable 건당 1.23 × 0–8건) (보정 1회 기준)`. 판정 계수는 반증 몫을 뺀 값이고, 반증은 건수(0건부터 상한까지) × 모델별 단가로 따로 더한다. 계수와 식은 framework 8.4와 `scripts/lib/estimate.mjs`에 있다. 금액은 숫자 뒤 "달러"로 적는다.

## 4. 공통 단계: 스크립트 추출 (모든 level)

```bash
node "${CLAUDE_SKILL_DIR}/scripts/extract.mjs" --profile <프로파일> --out <RUN_DIR> --level <level> --label <라벨> \
  [--changed-since <색인|latest> --reports-dir <reports>] [--map <논리=실제>]
```

- 종료 2: 인자·프로파일 오류 → 출력 그대로 보고하고 끝낸다. 종료 3: 묶음 문서 없음.
- 출력의 `경고: …`(프로파일 검사 규칙 위반: 정본 중복, 맞는 절 없는 원 요구 출처, relation 없는 compare_keys 등)는 보고서 머리에 남는다.
- 판정자는 `extract/index.json`과 필요한 차원 파일 `extract/<차원>.json`만 읽는다. 차원 파일은 그 차원 기준의 정본 쪽 후보(구체 종류는 인용까지, 나머지는 위치만)와 원 표를 담는다. 입력 문서(원자료·점검 보고서)에만 있는 후보는 개수만 두고 목록은 `extract/<차원>.input.json`으로 뺀다. 필드는 `SCHEMA.md`.
- `extract/index.json`의 `obligated_candidates`는 light 표의 정본 쪽 구체 후보다. standard 판정자·deep 관점은 출력의 `candidate_dispositions`에 후보마다 채택(finding ID) 또는 기각(이유)을 적는다(출력 요건, framework 7.4). `verdict.mjs check`가 빠진 후보를 오류로 낸다(standard는 3단계 재요청 대상). 끝까지 빠진 후보는 판정을 바꾸지 않고 보고서 머리에 "평가 불완전 경고"로 남는다(framework 8.1).
- 증분(`--changed-since`)이면 이전 finding을 나눈다: `node "${CLAUDE_SKILL_DIR}/scripts/verdict.mjs" carry --prev <이전 .findings.json> --extract <RUN_DIR>/extract.json --out <RUN_DIR>/carried.json` → 근거 절이 안 바뀐 것은 `carried`, 바뀐 것은 `recheck`(판정 에이전트에 넘김).

## 5. 모드 구성

| level | 쓰는 때 | 찾는 쪽 | 반증 | 판정 |
|---|---|---|---|---|
| `light` | 문서를 고칠 때마다 | 스크립트만. LLM 없음 | 없음 | 없음. `S` 단독 기준(REQ-02)만 finding(심각도 참고값), 나머지는 후보 |
| `standard` | 설계 중간 확인(기본) | `harness-james:design-verify-judge` × `model: fable` 1회 (Agent 도구) | `harness-james:design-verify-refuter` × `model: opus` (Agent 도구) | framework 8장 |
| `deep` | 구현 시작 직전, 설계를 확정할 때(명시 요청 때만) | Workflow `workflow/deep.mjs`: 관점 5개(`harness-james:design-verify-judge` × opus) → 집계 1 | 같은 워크플로 안에서 `harness-james:design-verify-refuter` × fable, 최대 3 에이전트 | framework 8장 |

반증 대상은 **critical·high 전부, 최대 8건**(프로파일 `limits.refute`가 덮어씀). 순서는 심각도(critical 먼저), 같은 심각도 안에서는 신뢰도가 낮은 것 먼저(possible → likely → confirmed), 그다음 기준 위험도 R(c) 높은 순이다. 상한 밖은 반증하지 않고 `uncertain`(`not-refuted: cap`) → REVIEW_REQUIRED(framework 8.3).

### 5.1 light

```bash
node "${CLAUDE_SKILL_DIR}/scripts/report.mjs" light <RUN_DIR> --out <reports>/<profile>/<날짜>-<라벨>.md --with-artifacts
```

문서를 고칠 때마다 쓰는 값싼 점검이다. 보고서는 **구체 종류**(은퇴 이름·ID, 번호 체계 혼재, 설정 충돌·프로파일 값 대조, 깨진 참조, 범위·머리말)만 표로 보이고 나머지 종류는 개수만 적는다. 후보는 결함이 아니다. 표의 정본 쪽 구체 후보는 standard·deep 판정자의 처리 목록이 된다.

### 5.2 standard

비용 줄을 보인 뒤:

1. 판정 프롬프트: `verdict.mjs judge-prompt <RUN_DIR> [--carried <RUN_DIR>/carried.json]`가 `reference/judge-prompt.md` 틀에 적용 기준·문서 목록·처리 목록 수·증분 정보를 채워 `<RUN_DIR>/judge-prompt.md`를 쓴다. 읽기 전용 에이전트 정의가 없으면 종료 4로 멈춘다(아래 "멈추는 경우").
2. 판정: Agent 도구로 `subagent_type: harness-james:design-verify-judge`(judge-prompt 출력 `AGENT=`), `model: fable`. 프롬프트는 `judge-prompt.md` 내용을 그대로 넘긴다. 손으로 고치거나 채우지 않는다.
3. 답 저장: 에이전트의 최종 답(JSON)을 그대로 `verdict.mjs save-judge <RUN_DIR> -`의 표준 입력으로 넘긴다. 답이 커서 harness가 파일로 따로 저장했으면(예: `tool-results/…txt`) 그 경로를 그대로 넘긴다. 실제 실행 모델 ID를 트랜스크립트 등으로 확인했을 때만 `--observed <모델 ID>`를 준다. 요청 모델은 별칭(`fable`·`opus`)으로 남고, 확인이 없으면 보고서에 "요청 별칭, 실행 모델 미확인"으로 적힌다(에이전트가 스스로 적은 모델 값은 확인으로 치지 않는다).
4. 점검: `verdict.mjs check <RUN_DIR>`. 빠진 기준 상태, 처리 기록 누락, 형식·인용 오류를 낸다. 오류가 있으면 같은 에이전트에 오류 목록을 보내(SendMessage) 고친 JSON을 다시 받아 저장한다. 한 번만.
5. 반증 대상: `verdict.mjs targets <RUN_DIR>` → `refutation/targets.json`과 반증 프롬프트 `refutation/prompt.md`(대상이 있을 때).
6. 반증: 대상이 있으면 Agent 도구로 `subagent_type: harness-james:design-verify-refuter`(targets 출력 `AGENT=`), `model: opus`. 프롬프트는 `refutation/prompt.md` 내용을 그대로 넘긴다(대상 근거마다 실제 파일 경로 `file`이 붙어 있다). 답을 `verdict.mjs save-refutation <RUN_DIR> - [--observed <모델 ID>]`로 저장한다.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/verdict.mjs" judge-prompt <RUN_DIR>        # → judge-prompt.md (그대로 넘긴다)
node "${CLAUDE_SKILL_DIR}/scripts/verdict.mjs" save-judge <RUN_DIR> -        # 표준 입력 = 판정 에이전트 최종 답
node "${CLAUDE_SKILL_DIR}/scripts/verdict.mjs" check <RUN_DIR>
node "${CLAUDE_SKILL_DIR}/scripts/verdict.mjs" targets <RUN_DIR>             # → refutation/targets.json, refutation/prompt.md
node "${CLAUDE_SKILL_DIR}/scripts/verdict.mjs" save-refutation <RUN_DIR> -   # 표준 입력 = 반증 에이전트 최종 답
```

### 5.3 deep

비용 줄을 보인 뒤:

1. args: `verdict.mjs workflow-args <RUN_DIR> [--carried <RUN_DIR>/carried.json]`가 `criteria.json`·`extract/index.json`·`reference/perspectives.json`·프로파일 `limits.refute`(없으면 8)로 `<RUN_DIR>/workflow-args.json`을 만든다. 읽기 전용 에이전트 정의가 없으면 종료 4로 멈춘다.
2. Workflow 도구로 workflow-args가 출력한 `SCRIPT=` 경로(`<RUN_DIR>/deep.mjs`, `workflow/deep.mjs`의 복사본)를 실행한다(`scriptPath`). 플러그인 설치 경로는 작업 디렉터리 밖이라 scriptPath로 바로 받지 않는다. `args`는 `workflow-args.json` 내용을 그대로 넘긴다. 손으로 모으거나 고치지 않는다.
3. 저장: 반환값을 `verdict.mjs save-workflow <RUN_DIR> <파일|->`로 저장한다(→ `judge/findings.json`, `refutation/targets.json`, `refutation/result.json`). 워크플로 출력 파일(`tasks/<id>.output`)은 `{summary, logs, result}` 래퍼인데 그대로 넘겨도 된다(`result`를 꺼낸다). save-workflow는 `refutation.max`를 프로파일 `limits.refute`(없으면 8)와 대조해 다르면 오류(종료 1)를 낸다. 트랜스크립트로 실행 모델 ID를 확인했으면 `--observed-judge`·`--observed-refuter`를 준다.
4. 점검: `verdict.mjs check <RUN_DIR>`. **오류가 나면 findings JSON을 손으로 고치지 않는다.** 멈추고 오류 목록을 사용자에게 보고한다. 오류가 특정 관점의 결과에서 왔으면 그 관점만 다시 돌리자고 제안할 수 있다(사용자 승인 뒤). 경고만 있으면 계속한다.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/verdict.mjs" workflow-args <RUN_DIR>      # → workflow-args.json (Workflow args로 그대로)
node "${CLAUDE_SKILL_DIR}/scripts/verdict.mjs" save-workflow <RUN_DIR> <워크플로 출력 파일>
node "${CLAUDE_SKILL_DIR}/scripts/verdict.mjs" check <RUN_DIR>
```

- 워크플로의 `agent()`는 항상 읽기 전용 정의 `harness-james:design-verify-judge`(관점·집계)와 `harness-james:design-verify-refuter`(반증)를 쓴다. 대체 경로는 없다. 관점 결과가 하나도 없으면 워크플로가 멈춘다.
- 관점·기준 매핑은 루브릭 README 4장을 옮긴 `reference/perspectives.json`이다. 기준마다 주 담당 관점이 하나다. 관점 에이전트는 자기 관점의 문서 역할만 받는다(필요하면 더 연다). 원자료(`source-material`)는 `must_read_roles`를 가진 관점 하나(결정 검토자)만 받는다. light 구체 후보는 주 담당 관점에 나눠 준다. 주 담당 기준이 모두 꺼진 관점은 띄우지 않는다. 에이전트는 많아야 9개다(관점 5 + 집계 1 + 반증 3).
- 집계는 같은 원인을 합치고, 권고가 서로 반대 방향인 finding 짝을 `recommendation_conflicts`와 각 finding의 `conflicts_with`로 드러낸다(출력 요건, framework 7.5). 한쪽을 지우지 않는다. 미독 문서는 관점별 목록을 단순 합산하지 않고, 어느 관점이든 읽은 문서는 뺀다.

### 멈추는 경우 (standard·deep)

- `judge-prompt`·`workflow-args`가 종료 4: 읽기 전용 에이전트 정의(`design-verify-judge.md`·`design-verify-refuter.md`)가 같은 플러그인의 `agents/`, `<워크스페이스>/.claude/agents/`, `~/.claude/agents/` 어디에도 없다. 다른 에이전트로 대체하지 않는다. 사용자에게 설치가 필요하다고 보고하고 끝낸다.
- deep에서 `check` 오류: 위 5.3의 4.
- `save-workflow` 종료 1(반증 상한 불일치): args를 그대로 넘기지 않은 것이다. 보고하고 끝낸다.

### 5.4 판정과 보고서 (standard·deep)

```bash
node "${CLAUDE_SKILL_DIR}/scripts/verdict.mjs" finalize <RUN_DIR> [--carried <RUN_DIR>/carried.json]
node "${CLAUDE_SKILL_DIR}/scripts/report.mjs" final <RUN_DIR> --out <reports>/<profile>/<날짜>-<라벨>.md --with-artifacts
```

`finalize`가 하는 일: S 단독 finding 병합, 반증 반영(downgraded면 심각도 교체, rejected는 제외, 상한 밖은 `uncertain`·`not-refuted: cap`), 상한(전체 50·기준당 5·low/info 10, 프로파일 `limits`), 기준 위험도 `R(c)`, 판정, 평가 완전성(fail-closed), 구체 후보 처리표·평가 불완전 경고, 권고 충돌 짝(`recommendation_conflicts` + `conflicts_with`).

판정자의 `documents_unread`는 자유 문자열이라 finalize가 묶음 문서로 정리한다(줄 범위·괄호 메모·glob을 풀고, 묶음 밖 경로는 버린다). 그 뒤:

| 경우 | 처리 |
|---|---|
| 프로파일이 일부러 뺀 문서(`readable: false`, `exclude`) | 의도적 제외. 보고서 "제외 문서"에만 적고 평가 불완전이 아니다 |
| 추출 단계 읽기 실패(그 밖 이유) | 평가 불완전 → REVISE |
| 정본 쪽 묶음 문서를 어느 판정자도 읽지 않음 | 평가 불완전 → REVISE(재실행 필요) |
| 입력 문서(원자료·점검 보고서)만 어느 판정자도 읽지 않음 | "원자료 미독" → REVIEW_REQUIRED(사람이 확인) |

## 6. finding·판정 규칙 (요약, 정본은 framework)

- **finding 필드**: `id, criterion, title, severity, confidence, scope_state, method, evidence[{doc,section,line,quote}] | absence{searched,queries,result}, touches, failure_scenario, rationale, recommendation, also_affects, source, refutation`. high 이상은 `refutation` 필수(상한 밖은 `uncertain`).
- **판정**: REVISE = critical(confirmed·likely) 또는 평가 불완전 · REVIEW_REQUIRED = 어떤 기준이든 `R(c) ≥ 임계값`, 반증 `uncertain`인 high 이상(상한 밖 포함), X·H 확인이 열린 high 이상, 원자료 미독 · PROCEED = 그 밖. `R(c) = min(100, w × Σ 심각도점수 × 신뢰도계수)`. BND-06은 판정에서 뺀다(기준 평가는 한다).
- **평가 불완전(실제 미평가만)**: 적용 기준 상태 누락, 관점·판정 에이전트 실패, 어느 판정자도 읽지 않은 정본 쪽 묶음 문서(의도적 제외·원자료는 아님), 추출 결과 없음, 반증을 시도한 high 이상의 결과 없음(반증 에이전트 실패). 상한 밖은 불완전이 아니다. 구체 후보 처리 누락은 판정을 바꾸지 않는 경고다.
- **증분**: 범위 `절`·`문서` 기준은 바뀐 부분만, `묶음` 기준은 스크립트로 다시 본다. 이전 finding은 `carried`(참고, 판정 제외)로 넘긴다.

## 7. 최종 응답 (메인 대화로)

```
<⛔ REVISE | ⚠️ REVIEW_REQUIRED | ✅ PROCEED | 🔎 light> <profile> <label>   finding n (critical a · high b) · 후보 m
판정 사유: …
직접 검토: [F-…] 한 줄 요지 …  (반증 상한 밖 k건 포함)
반대 방향 권고: [F-a ↔ F-b] …  (있을 때만)
구체 후보 처리: 채택 a · 기각 r · 처리 기록 없음 k(있으면 평가 불완전 경고)
외부 확인 대기: k건
<구현 직전·확정 때는 deep 권장>  (traits에 되돌릴 수 없는 부작용·데이터 이전이 있고 light·standard일 때만)
리포트: <경로>
실행 메모: 비용 줄, 모델(요청/실행 확인 여부), 재시도·누락·경고(있을 때만)
```

## 8. 파일

| 파일 | 내용 |
|---|---|
| `scripts/extract.mjs` | S 추출(Node 내장 모듈만), 판정자용 분할. `SCHEMA.md`에 출력 스키마와 기준 → 추출기 표 |
| `scripts/report.mjs` | light 보고서·최종 보고서 렌더러 |
| `scripts/verdict.mjs` | 판정 프롬프트·워크플로 args 생성(judge-prompt·workflow-args, 에이전트 정의 확인), 에이전트 답 저장(save-judge·save-refutation·save-workflow), 점검, 반증 대상·반증 프롬프트, 판정, 증분 이월 |
| `scripts/check-workflow.mjs` | deep 워크플로 토큰 없는 점검(문법·meta·모의 실행·에이전트 유형) |
| `workflow/deep.mjs` | deep 워크플로 |
| `${CLAUDE_PLUGIN_ROOT}/agents/design-verify-judge.md` · `…/design-verify-refuter.md` | 읽기 전용 판정·반증 에이전트 정의(같은 플러그인, 이름 `harness-james:<파일 이름>`) |
| `evaluation/` | 판정 기준: `framework.md`, `traits.md`, `rubrics/*.md`, `profile-schema.md`, `README.md`(관점 매핑·커버리지·변경 기록) |
| `reference/judge-prompt.md` · `reference/refuter-prompt.md` | standard 판정·반증 요청 틀(입력만, `{{…}}`는 스크립트가 채운다) |
| `reference/perspectives.json` | 관점 → 기준·문서 역할 매핑, 원자료 담당(`must_read_roles`) |
| `templates/report.md` · `templates/findings.schema.json` | 보고서 구조, findings JSON 스키마 |
