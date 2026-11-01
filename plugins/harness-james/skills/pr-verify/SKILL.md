---
name: pr-verify
description: PR 전 코드 검증. 레포 프로파일(docs/evaluation/profiles/*.json)이 있는 레포의 브랜치나 PR을 보안·성능(BF)·아키텍처·신뢰성·관측성·테스트·접근성 차원에서 Opus 5.5 max로 정량 채점하고 BLOCK·REVIEW_REQUIRED·PASS를 판정해 리포트를 남긴다. 실행 비용이 크므로 사용자가 PR 전 검증이나 /harness-james:pr-verify(옛 이름 /harness-james:verify)를 명시적으로 요청할 때만 쓴다.
argument-hint: "<레포 별칭> [브랜치|SHA|pr:N] [--base <ref>] [--full [--merge-ref <ref>]] [--resume <run_id>] [--season bf|off]"
context: fork
agent: harness-james:verify-orchestrator
background: true
model: claude-opus-5-5
effort: max
---

# /pr-verify — PR 검증 실행

인자: `$ARGUMENTS`

워크스페이스 루트(평가 폴더 `docs/evaluation/profiles/`가 있는 곳. 평가 폴더는 환경 변수 `VERIFY_EVAL_DIR`로 바꿀 수 있다)에서 아래 단계를 순서대로 실행한다. 프로파일이 없거나 레포를 찾지 못했다는 오류면 사용자에게 작성 안내 `${CLAUDE_SKILL_DIR}/references/profile-guide.md`의 경로를 알려 주고 끝낸다(플러그인 경로는 작업 폴더 밖이라 하위 에이전트가 직접 읽지 않는다).

**하위 에이전트 결과 기다리기**: 판정·반증·탐색 에이전트는 백그라운드로 실행된다. 한 단계의 에이전트들을 한 메시지에서 띄운 뒤 턴을 끝내면, 각 결과가 완료 알림으로 돌아온다. 그 단계의 결과 파일이 모두 생길 때까지 다음 단계로 넘어가지 않는다. 기다리느라 턴을 끝낼 때는 "판정 n/m 완료"처럼 한 줄만 남긴다. 이 스킬의 결과는 모든 하위 에이전트가 끝난 뒤의 마지막 응답(8단계 형식)이다.

점수 체계와 판정 규칙은 framework.md에 있다(플러그인 기본값은 이 스킬의 `evaluation/`. 프로젝트 평가 폴더에 `framework.md`·`config/scoring.json`·`rubrics/<차원>.md`를 두면 그쪽이 우선한다. 1단계가 이번 실행에 쓰는 기준을 `RUN_DIR/evaluation/`에 복사하고, 에이전트는 그 사본(`context.json`의 `versions.*.path`)만 읽는다. 원래 위치는 `versions.*.source_path`). 각 단계의 명령은 그대로 쓴다.

실행 전제: Node 18 이상(내장 모듈만 써서 npm 설치 없음), git, `pr:N` 대상이면 로그인된 gh CLI(`gh auth status`). 프로파일의 프로젝트 도구(`tools[]`, kind `module`)가 외부 CLI를 쓰면 그 CLI도 필요하다. 도구를 못 돌리면 그 도구를 건너뛰고 1단계 출력과 리포트에 경고를 남긴다(그 도구의 자동 신호 없이 채점됨).

## 1. 준비

인자는 셸을 거치지 않게 따옴표 붙인 heredoc으로 넘긴다. 스크립트가 셸식 따옴표로만 나누고 `$`·백틱·글롭은 확장하지 않는다. `--session`은 이 실행을 세션에 등록한다. `verify-guard`는 이 세션의 판정·반증·탐색 에이전트에게 등록된 실행 폴더만 열어 준다.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/prepare.mjs" --session "${CLAUDE_SESSION_ID}" --args-stdin <<'VERIFY_ARGS'
$ARGUMENTS
VERIFY_ARGS
```

- 종료 코드 2: 세션 id를 받지 못했거나, 사전 점검(모델 정책)·대상 해석에 실패한 것이다. 출력된 오류를 그대로 보고하고 끝낸다.
- 종료 코드 3: base 대비 변경이 없다. "검증할 변경 없음"과 대상·base를 보고하고 끝낸다.
- 성공하면 첫 줄 `RUN_DIR=...`에서 실행 디렉터리를 얻는다(이하 `RUN_DIR`). 출력 요약(변경 규모, 핵심 구조, 자동 신호, 모드·갈림점, diff 밖 신호, 경고)을 기억해 둔다.
- `RUN_DIR/context.json`을 읽고 적용 차원(`dimensions[].id`), 건드린 핵심 구조(`structures[]` 중 `touched`), 자동 신호 수를 확인한다.
- `--full`은 전체 모드다. base는 갈림점(PR base 또는 프로파일 `default_base`와 head의 merge-base)이다. `--merge-ref`를 주면 머지 결과와 비교하는 신호도 돈다. `--merge-ref`에는 충돌을 푼 머지 커밋(이 레포에 있는 커밋)을 준다. `merge-tree` 결과를 그대로 주면 충돌 덩어리 밖의 상대 쪽 줄이 안 보여 신호가 빠진다. 머지 결과가 컴파일되지 않으면 그 신호는 이름 수준으로 낮춰지고 `note`에 남는다.
- 모드와 상관없이 prepare가 갈림점 기준 결정적 신호(도달성·대체 장부·복제본·피처맵)를 돌려 `RUN_DIR/signals/`에 둔다. 이 도구들은 프로젝트가 준비하고 `VERIFY_SIGNAL_BIN`·`VERIFY_FM_BIN`으로 위치를 알려 준다(framework 3.7). 도구가 없거나 실패해도 실행은 이어지고 경고로 남는다. 신호는 판정 범위를 줄이지 않는다.
- `--resume <run_id>`는 멈춘 실행을 이어 돌린다. prepare는 새 실행 폴더를 만들지 않고, 그 실행을 이 세션에 다시 등록한 뒤 "끝난 단계"(형식 점검을 통과한 차원, 결과가 있는 반증 묶음, 채점·패킷 여부)를 출력한다. 재개면 아래 단계에서 끝난 것은 건너뛴다.

## 2. 영향 지도 (조건부)

diff가 커서 판정 에이전트 6–7개가 같은 탐색을 반복할 것 같을 때만, 판정 전에 `harness-james:verify-explorer`를 하나 띄워 영향 지도를 만든다. 다음 중 하나라도 해당하면 띄운다. 작은 diff는 판정 에이전트가 각자 필요한 만큼 탐색한다.

- 동작 변경이 300줄 이상이다
- 변경 파일이 30개 이상이다

질문 예: "RUN_DIR=<…>. **영향 지도만** 만들어라: head와 base 트리를 비교해 이 diff가 바꾼 진입점·호출 흐름·데이터 모델·설정을 정리하라. 변경된 public 메서드·섹션·스니펫마다 호출처를 file:line으로, 관련 스펙(`context.structures[].specs`)을 목록으로. 위반 여부 판단과 외부 문서 확인은 하지 마라. 도구 호출 20회 안에 끝내라."

답을 `RUN_DIR/explore/impact.md`에 그대로 저장한다. 판정 에이전트들이 참고한다.

## 3. 판정 (병렬)

적용 차원마다 `harness-james:verify-judge`를 **한 메시지에서 동시에** 띄운다. 재개면 형식 점검을 통과한 차원은 띄우지 않는다. 프롬프트:

> RUN_DIR=<RUN_DIR> DIMENSION=<차원>. 네 시스템 프롬프트의 절차대로 판정하고 `RUN_DIR/judgments/<차원>.json`을 작성한 뒤 형식 점검까지 마쳐라. `RUN_DIR/explore/impact.md`가 있으면 참고하라.

모두 끝나면 아래 명령으로 점검한다.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/score.mjs" <RUN_DIR> --check --stage judgments
```

오류가 있으면 해당 차원의 판정 에이전트를 다시 띄워 오류 목록을 주고 기존 파일을 고치게 한다. 차원당 한 번만 다시 띄운다. 그래도 남는 오류는 고치지 않고 다음 단계로 넘어간다. `score.mjs`가 "평가 불완전"으로 기록한다.

## 4. 반증

```bash
node "${CLAUDE_SKILL_DIR}/scripts/score.mjs" <RUN_DIR> --refute-chunks
```

스크립트가 반증 대상을 6개씩 `RUN_DIR/refutation-targets/<CHUNK>.json`에 쓰고 `CHUNK=<이름> n건`을 한 줄씩 출력한다. 묶음 파일은 직접 쓰거나 고치지 않는다.

- 재개인데 반증 묶음이 이미 나뉘어 있으면 `--refute-chunks`를 다시 돌리지 않고, 결과가 없는 묶음만 아래처럼 띄운다.
- "반증 대상 없음"이면 이 단계를 건너뛴다.
- 아니면 출력된 CHUNK마다 `harness-james:verify-refuter`를 한 메시지에서 동시에 띄운다. 프롬프트:

> RUN_DIR=<RUN_DIR> CHUNK=<CHUNK>. 대상 목록은 `RUN_DIR/refutation-targets/<CHUNK>.json`이다. 네 시스템 프롬프트의 절차대로 반증하고 `RUN_DIR/refutation/<CHUNK>.json`을 작성하라.

모두 끝나면 아래 명령으로 점검한다.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/score.mjs" <RUN_DIR> --check
```

반증 결과가 빠진 finding이 있으면 재시도 묶음을 만든다. 출력된 CHUNK(`r<n>-retry`)마다 반증 에이전트를 한 번 더 띄운다. 스크립트는 묶음마다 한 번만 재시도 묶음을 만든다.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/score.mjs" <RUN_DIR> --refute-chunks --retry
```

## 5. 채점

```bash
node "${CLAUDE_SKILL_DIR}/scripts/score.mjs" <RUN_DIR>
```

출력과 `RUN_DIR/scores.json`에서 판정(`gate`), 차단 사유, 트리거(`triggers[]`)를 확인한다.

## 6. 검토 패킷

`scores.json`의 트리거마다 `RUN_DIR/<trigger.packet>` 파일(Markdown)을 직접 작성한다. 사람이 그 구조만 집중해서 보도록 돕는 자료다. 코드를 직접 열어 확인하고 쓴다. 넓은 추적이 필요하면 `harness-james:verify-explorer`를 쓴다. 패킷은 점수를 바꾸지 않는다.

```markdown
### 구조 요약
이 구조가 하는 일, 이 PR이 바꾼 것 (3–5줄)

### 왜 트리거됐나
점수 구성: 어떤 finding이 몇 점, 또는 중요도 × 변경 규모

### 읽는 순서
1. `file:line` — 진입점
2. `file:line` — 바뀐 핵심
3. `file:line` — 영향받는 호출처

### 흐름도
(mermaid sequenceDiagram 또는 flowchart. 바뀐 흐름만)

### 확인 질문
- 사람이 판단해야 할 질문 3–5개 (업무 정책, 트래픽 가정, 운영값 등)

### 승인하면 남는 위험
- 이대로 머지할 때 감수하는 것
```

## 7. 리포트

```bash
node "${CLAUDE_SKILL_DIR}/scripts/report.mjs" <RUN_DIR>
```

출력의 `REPORT=` 경로를 얻는다. 리포트와 `<평가 폴더>/reports/<레포>/index.json`(PR 생성 훅 `require-verify-before-pr`이 읽음)이 갱신된다.

## 8. 최종 응답

메인 대화로 돌아가는 응답이다. 한국어, 30줄 이내로 쓴다.

```
<⛔ BLOCK | ⚠️ REVIEW_REQUIRED | ✅ PASS> <레포> <브랜치>@<sha7> → <base>   종합 <점수> (차단선 <n>)

| 차원 | 품질 |
|---|---:|
| SEC 보안·프라이버시 | 72 |
…

차단 사유: …(없으면 생략)
직접 검토:
- [C-REL-02] … 위험도 75 ≥ 50 — 한 줄 요지
- [S-svc.payment] … 영향도 76 ≥ 50 — 한 줄 요지

리포트: docs/evaluation/reports/…
diff 밖 신호: <전체 모드면 "결정적 신호", 증분이면 "누적 신호"> FAIL a · WARN b (도구 실패가 있으면 그 이름)
실행 메모: 재시도·재개·누락·경고(있을 때만)
```

## 스크립트 테스트

스킬 디렉터리에서 `node --test test/`로 돌린다. 임시 워크스페이스와 임시 git 레포 픽스처만 쓰고(`VERIFY_WORKSPACE`), 실제 레포·리포트는 건드리지 않는다.
