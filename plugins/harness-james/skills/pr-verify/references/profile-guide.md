# 레포 프로파일 작성 안내

`/pr-verify`는 프로파일이 등록된 레포만 검증한다. PR 생성 게이트 훅(`require-verify-before-pr`)도 프로파일이 있는 레포에서만 동작한다. 프로파일이 없는 레포에서는 두 훅 모두 아무것도 하지 않는다.

## 어디에 두나

워크스페이스(검증할 레포들을 품은 프로젝트 루트, Claude Code를 여는 곳) 아래 평가 폴더에 둔다.

```
<워크스페이스>/
  docs/evaluation/            ← 평가 폴더 (VERIFY_EVAL_DIR로 바꿀 수 있음, 워크스페이스 기준 상대 경로)
    profiles/<이름>.json      ← 레포마다 하나 (필수)
    reports/                  ← /pr-verify가 쓰는 리포트와 PR 게이트 색인 (자동 생성)
    calibration/              ← 보정 자료 (선택. 검증 에이전트는 읽지 못함)
    config/guard.json         ← 프로젝트 전용 차단 명령 (선택)
    tools/*.mjs               ← 프로젝트 도구 모듈 (선택)
    framework.md, config/scoring.json, rubrics/<차원>.md
                              ← (선택) 두면 플러그인 기본값 대신 쓴다
  <레포>/                     ← 프로파일 repo.path
  .verify/runs/               ← 실행 산출물 (자동 생성, .gitignore 권장)
```

평가 폴더를 옮기려면 프로젝트 `.claude/settings.json`에 `"env": { "VERIFY_EVAL_DIR": "qa/eval" }`처럼 둔다. 스크립트와 두 훅이 같은 값을 읽는다.

## 시작하기

1. `${CLAUDE_SKILL_DIR}/examples/profile.example.json`을 `docs/evaluation/profiles/<이름>.json`으로 복사한다.
2. 아래 필드를 레포에 맞게 고친다.
3. `/pr-verify <별칭>`을 실행한다. 1단계(`prepare.mjs`)가 프로파일 오류를 먼저 알려 준다.

## 필드

| 필드 | 뜻 |
|---|---|
| `repo.key` | 실행 ID·규칙 `repo`에 쓰는 짧은 키 |
| `repo.name` | 리포트 폴더 이름(`reports/<name>/`) |
| `repo.path` | 워크스페이스 기준 레포 경로 |
| `repo.github` | `owner/repo`. `pr:N` 대상과 PR 게이트의 `-R` 판별에 쓴다 |
| `repo.default_base` | base를 안 주면 쓰는 ref |
| `repo.aliases` | `/pr-verify <별칭>`으로 부를 이름들 (첫 번째가 안내 메시지에 쓰인다) |
| `repo.traits` | `server`·`client` 중 하나 이상. rubric 기준의 "적용"(공통·서버·클라이언트)을 고른다 |
| `dimensions.<차원>.weight` | 적용할 차원과 종합 점수 가중치. 빠진 차원은 평가하지 않는다 (SEC·PERF·ARCH·REL·OPS·TEST·A11Y) |
| `floors` | 차원·종합 차단선 |
| `comment_syntax` | glob → 주석 접두어. 주석만 바뀐 줄은 동작 변경으로 세지 않는다 |
| `ignore_line_patterns` | glob → 정규식. 동작 변경에서 뺄 줄(import 등) |
| `structures[]` | 핵심 구조: `id`, `name`, `criticality`(0–100), `review_threshold`, `paths`, `exclude`, `specs`(판정 에이전트가 참고할 문서 경로) |
| `coverage_ignore` | (선택) glob 목록. 시험·문서처럼 구조에 넣지 않는 경로를 "어느 구조에도 안 걸린 동작 변경 파일" 경고에서 뺀다 |
| `long_lived_branches` | (선택) 장기 브랜치 이름 목록. 이 브랜치에서 여는 PR은 PR 게이트가 갈림점 기준 전체 모드(`--full`) 리포트를 요구한다 |
| `ledgers[]` | (선택) 대체 장부: `branches`, `plan`(지운다·남긴다·이름 바꾼다 행이 있는 문서), `tasks`, `docs`(줄 참조를 볼 문서 glob). diff 밖 신호 도구 `ledger-check`의 입력(아래 "diff 밖 신호") |
| `dependents[]` | (선택) 다른 레포 복제본: `source`(이 레포 glob), `replicas[]`(`repo` = 다른 프로파일의 `repo.key`, `path`, `ref`), `note`. diff가 `source`를 건드리면 복제본 사본을 `RUN_DIR/replicas/`에 두고 `co-change` 도구를 부른다 |
| `feature_map` | (선택) 기능 문서 폴더(워크스페이스 기준). `fm-check` 도구가 기능 문서가 코드보다 낡았는지 본다 |
| `criteria.<기준 ID>` | 기준별 `weight`·`review_threshold`·`season_review_threshold` 덮어쓰기, `disabled: true` |
| `rules[]` | 결정적 자동 신호 규칙. `kind`는 `path-modified`·`path-added`·`path-deleted`·`added-line-regex`·`removed-line-regex`·`co-change-required`·`added-file-missing-regex` |
| `tools[]` | 프로젝트 도구 (아래) |
| `secret_scan` | 비밀값 패턴(`config/scoring.json`의 `secret_patterns`)을 감점할 기준과 제외 경로 |
| `parameters` | 판정 에이전트가 참고할 예산·트래픽 가정값. 모르면 `null` |

rubric과 framework는 레포와 무관한 원칙만 담는다. 파일 경로·벤더 사실·수치 같은 레포 지식은 프로파일에만 둔다.

## 프로젝트 도구 (`tools[]`, kind `module`)

린터·플랫폼 검사처럼 특정 생태계에 묶인 자동 신호는 플러그인에 넣지 않고 프로젝트가 모듈로 더한다.

```json
{ "id": "lint", "kind": "module", "module": "tools/lint.mjs", "criterion": "TEST-03" }
```

`module`은 평가 폴더 기준 경로다. 모듈은 함수 하나를 default export 한다.

```js
export default async function ({ profile, tool, files, trees, criteria, season, warnings, groupFinding, helpers }) {
  // files: diff 파일 목록(path, old_path, status, added[{line,text}], removed[...], structures)
  // trees: { head, base } — 추출한 PR 이후·이전 트리 경로
  // groupFinding(profile, finding, hits): 파일별 hit({ file, count, evidence[] })를 finding 하나로 묶는다
  // helpers: { SEVERITIES, sevRank, matchPaths }
  return { run: { tool: tool.id, kind: tool.kind, status: "ok", note: null }, findings: [] };
}
```

모듈이 없거나, 불러오지 못하거나, 오류를 내면 그 도구만 건너뛰고 경고를 남긴다(그 도구의 자동 신호 없이 채점). 외부 CLI를 부르는 도구는 CLI가 없을 때 스스로 `status: "skipped"`와 `warnings.push(...)`로 알린다.

## diff 밖 신호 도구 (선택)

`prepare.mjs`는 갈림점 기준으로 diff 밖 사실(부르는 곳이 사라진 정의, 장부가 지운다고 한 기호, 원천이 바뀌었는데 그대로인 복제본, 낡은 기능 문서)을 찾는 결정적 도구를 돌려 `RUN_DIR/signals/summary.md`로 판정 에이전트에게 넘긴다(framework 3.7). 점수에는 들어가지 않는다.

- 이 도구들은 플러그인에 없다. 프로젝트가 준비하고 위치를 환경 변수로 준다.
  - `VERIFY_SIGNAL_BIN`: `reach.mjs`(도달성, Gradle 레포만)·`ledger-check.mjs`(`ledgers`)·`co-change.mjs`(`dependents`)가 있는 폴더
  - `VERIFY_FM_BIN`: `fm-check.mjs`(`feature_map`)가 있는 폴더. PR 게이트도 이 위치로 낡은 기능 수를 승인 사유에 붙인다
- 도구는 `--json <파일>`에 신호 JSON v1(`{ "version": 1, "tool", "status": "ok|skipped|error", "note", "items": [{ "severity": "FAIL|WARN|INFO", "kind", "symbol", "message", "head": [{file,line}], "base": [...], "docs": [...] }] }`)을 쓴다.
- 돌아야 하는 도구(Gradle 레포의 도달성, 프로파일에 필드가 있는 장부·복제본·피처맵)의 위치가 설정되지 않았거나 파일이 없거나 실패하면, 그 도구는 `status: error`로 남고 1단계 출력·리포트에 경고가 붙는다. 검증은 그 신호 없이 계속된다.

## 프로젝트 전용 차단 명령 (`config/guard.json`)

검증 에이전트는 플러그인 훅 `verify-guard`로 읽기 전용이 강제된다(빌드·테스트·외부 전송·git 쓰기·평가 폴더 밖 쓰기 금지). 프로젝트에만 있는 위험한 CLI(배포·스토어·클라우드 CLI 등)는 여기에 더한다.

```json
{
  "build_note": "테스트가 스테이징 결제 API를 부름",
  "commands": [
    { "name": "deployctl", "why": "배포·원격 환경 변경", "allow": [["version"], ["--help"], ["status"]] }
  ]
}
```

- `name`: 실행 파일 이름(경로 없이). 경로 접두사·`bash -c`·`xargs`·인터프리터 문자열 안의 호출도 잡는다.
- `allow`: 허용할 앞부분 인자 목록. 인자 없이 부르는 것은 허용한다. 그 밖의 호출은 `why`와 함께 거부한다.
- `build_note`: 빌드·테스트 거부 사유에 붙는 말.
- `blind`: 검증 에이전트가 못 읽게 할 프로젝트 경로(선택). 검증 대상의 알려진 결함을 적어 둔 리뷰 결과·분석 메모·작업 지시서처럼, 읽으면 판정이 블라인드가 아니게 되는 기록이다. `{ "path": "notes/review.md", "why": "리뷰 결과" }`는 그 파일이나 폴더 전체, `{ "path": "notes", "prefix": "gap-" }`는 그 폴더 안에서 이름이 `gap-`로 시작하는 것만 막는다(대소문자 무시). `path`는 프로젝트 기준 상대 경로다. Read·Grep·Glob·Bash 모두 같은 경로 규칙으로 판정한다.
- 파일이 있는데 JSON이 깨졌으면 검증 에이전트의 모든 도구 호출을 막는다(fail closed). 다른 세션에는 영향이 없다.
