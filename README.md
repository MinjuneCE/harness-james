# harness-james

james가 쓰는 Claude Code 하네스를 묶은 플러그인 마켓플레이스예요. 레포 자체가 마켓플레이스이고, 플러그인 3개가 들어 있어요.

## 무엇이 들어 있나

| 플러그인 | 구성요소 | 하는 일 |
|---|---|---|
| `harness-james` | 스킬 `pane-lead` | herdr 위에서 메인 Claude pane 하나와 서브 pane(계보당 최대 5개)으로 큰 작업을 나눠 해요. |
| | 스킬 `skill-check` + 에이전트 `skill-check-judge` | 스킬 폴더 하나를 규칙 검사와 rubric 판정으로 채점해 S~F 등급과 고칠 점을 알려 줘요. |
| | 스킬 `pr-verify` + 에이전트 `verify-{orchestrator,judge,refuter,explorer}` | 프로파일이 있는 레포의 브랜치·PR을 보안·성능·아키텍처·신뢰성·관측성·테스트·접근성 차원에서 채점해 BLOCK·REVIEW_REQUIRED·PASS를 판정해요(Opus 5.5 max). 0.6.0부터 이름이 `verify`에서 `pr-verify`로 바뀌었어요(아래 "pr-verify"). |
| | 스킬 `verify-design` + 에이전트 `design-verify-{judge,refuter}` | 설계 문서 묶음을 rubric 59기준으로 검증해요. light(무료) · standard · deep(Workflow). |
| | 훅 5개 | push·merge 확인, 보호 브랜치 직접 push 거부, PR 전 pr-verify 게이트, herdr pane 계정 프로필 확인, verify 에이전트 가드(아래 "훅"). |
| `work-trace` | mod | 세션 오른쪽 패널에 작업 진행, 막힌 곳, 모델이 무엇을 왜 골랐는지를 실시간으로 보여 줘요. |
| `context-band` | mod | 프롬프트 바로 위에 컨텍스트 사용량, 자동 압축까지 남은 양, 메모리 파일, 비용, 사용량 한도를 한 줄로 보여 줘요. |

## 준비

- **Node 18 이상이 PATH에 있어야 해요.** 훅과 스킬 스크립트가 모두 `node`로 돌아요.
  - 가드 훅 5개는 모두 `onFailure: block`이에요(아래 "훅이 하는 일"). node를 PATH에서 못 찾으면 **그 맥의 모든 세션에서** Bash 호출이 막히고, verify-guard가 걸린 Read·Edit·Grep 등도 막혀요.
- **Claude Code 2.1.295 이상**(`onFailure` 필요). 2.1.316에서 시험했어요. work-trace·context-band는 mod API를 써서 최신판이 필요해요.
- **이 private 레포에 접근할 수 있어야 해요:** `gh auth login` 또는 GitHub SSH 키.
- git, gh(`pr-verify`의 `pr:N` 대상, 훅이 보는 명령).
- **herdr**(pane-lead용). pane-lead는 herdr pane 안에서만 동작해요. herdr의 에이전트 상태 훅은 herdr가 관리하고 이 플러그인에는 없어요.
- gitleaks(선택). skill-check 비밀값 검사에 써요. 없으면 정규식 검사로 대신해요. skill-check는 `python3`·`bash`가 있으면 대상의 .py·.sh 문법도 봐요.
- **Workflow 기능**(verify-design deep). Claude Code `/config`에서 켜요.

## 설치

```sh
claude plugin marketplace add <GitHub 계정>/harness-james
claude plugin install harness-james@harness-james
claude plugin install work-trace@harness-james
claude plugin install context-band@harness-james
```

- 이미 다른 마켓플레이스(예: 로컬 폴더 마켓플레이스)로 work-trace·context-band를 설치했다면 하나만 켜요.
- 업데이트: `claude plugin marketplace update harness-james` → `claude plugin update harness-james@harness-james`(work-trace·context-band도 같은 방식). 새 세션부터 적용돼요.
- **pane-lead 계보가 돌고 있을 때는 플러그인을 업데이트하지 않아요.** 실행 중인 계보의 settings에 플러그인 버전 경로가 들어가 있어서, 옛 버전 캐시가 정리되면 그 계보의 훅 경로가 깨져요.

## pane-lead 실행 스크립트(한 번만)

플러그인 설치 경로는 버전마다 바뀌어요. 셸에서 쓸 `pane-lead` 명령은 설치 기록을 읽어 지금 설치된 버전을 찾는 작은 스크립트예요.

```sh
node "$(ls -d ~/.claude/plugins/cache/*/harness-james/*/ | tail -1)skills/pane-lead/bin/pane-lead-shim.mjs" --install
```

- `~/.local/bin/pane-lead`가 생겨요. `~/.local/bin`이 PATH에 있어야 해요(다른 폴더는 `--install <폴더>`).
- 실행할 때마다 `~/.claude/plugins/installed_plugins.json`(`CLAUDE_CONFIG_DIR`을 쓰면 `$CLAUDE_CONFIG_DIR/plugins/…`)에서 user scope 설치를 먼저 찾아요. 업데이트해도 다시 설치할 필요가 없어요.
- 쓰는 법: herdr의 빈 셸 pane에서 `pane-lead main --prefix <접두어>`. 메인 세션은 `/harness-james:pane-lead start <접두어>`로 시작해요.
- Claude 계정 프로필을 여럿 쓰면(`CLAUDE_CONFIG_DIR`):
  - `CLAUDE_CONFIG_DIR=<프로필 폴더> pane-lead main --prefix <접두어>`로 띄워요. pane-lead가 띄우는 서브는 메인의 프로필을 이어받아요.
  - 인계 때 `handover --config-dir <폴더>`는 다음 메인부터 다른 프로필로, `--tab <이름>`은 다음 메인을 새 탭에 띄워요. 기본 프로필로 돌아갈 때는 `--config-dir ~/.claude`예요(`CLAUDE_CONFIG_DIR`를 붙이지 않고 띄워요).
  - 새 프로필에 로그인이 없으면 handover는 새 pane의 로그인·테마 화면을 보고 `login-required`로 멈춰요. 그 프로필로 한 번 로그인한 뒤 다시 실행해요.
  - 플러그인 설치는 프로필마다 따로예요. 쓰는 프로필마다 harness-james를 설치해요.
- 기록은 프로젝트 `.research/pane-lead/`와 `~/.local/state/pane-lead`에 남아요.
- 선택: `.research/pane-lead/attach.json`에 계보별 명령을 적으면 handover가 그 출력을 인계 문서 끝 "기계 계산" 절로 붙여요. 형식은 `{ "handover": { "<접두어>": { "cmd": ["node", "x.mjs", "--doc", "{doc}"], "title": "…", "timeout": 10000 } } }`이고, `{prefix}`·`{doc}`·`{root}`가 채워져요. 실패해도 인계는 이어져요.

## 프로젝트에서 처음 쓰기

### skill-check

- `/harness-james:skill-check <스킬 폴더>`. 실행 기록은 `~/.claude/skill-check/runs/`에 남아요.

### verify-design

1. 프로젝트 루트(git)에 `docs/evaluation/design/profiles/<이름>.json`을 만들어요.
   - 틀: 플러그인의 `skills/verify-design/test/fixtures/bundle-a/profile.json`(합성 예시)
   - 필드 설명: `skills/verify-design/evaluation/profile-schema.md`
   - 묶음 문서 경로(`bundle.roots`·`documents`), 역할, 원 요구 절, 외부 1차 출처, 상한을 채워요.
2. 처음 확인: `/harness-james:verify-design <이름> light`. 비용이 없고 프로파일 경고와 후보가 나와요.
3. 설계 중간: `/harness-james:verify-design <이름>`(standard). 시작 전에 비용 줄이 나와요.
4. 구현 직전: `/harness-james:verify-design <이름> deep`(Workflow 필요, 명시 요청 때만).
5. 결과는 `docs/evaluation/design/reports/<이름>/`에 생겨요. 작업 폴더 `runs/`는 `.gitignore`에 넣기를 권해요.
6. 선택: 프로젝트 고유 금지어 검사 `DV_FORBIDDEN_TERMS_FILE=<목록 파일> node --test <플러그인>/skills/verify-design/test/`. 목록 파일은 한 줄에 정규식 하나예요.

### pr-verify

0.6.0부터 스킬 이름이 `verify`에서 `pr-verify`로 바뀌었어요. 옛 이름 `/harness-james:verify`는 더 이상 안 돼요. 실행 폴더 `.verify/`, 환경 변수 `VERIFY_*`, 평가 폴더, 에이전트 이름 `verify-*`는 그대로라 프로젝트에서 바꿀 것은 없어요. 짧게 `/verify`라고 치면 Claude Code 내장 `/verify`(앱을 빌드해 변경을 확인하는 스킬)가 떠요.

1. 프로젝트(워크스페이스) 루트에 `docs/evaluation/profiles/<이름>.json`을 둬요.
   - 틀: `skills/pr-verify/examples/profile.example.json`, 안내: `skills/pr-verify/references/profile-guide.md`
2. `/harness-james:pr-verify <별칭> [브랜치|pr:N]`. 실행 한 번에 Opus 5.5 max 에이전트가 여러 개 떠서 비용이 커요.
   - `--full`은 갈림점(PR base 또는 `default_base`와 head의 merge-base)부터 전체를 봐요. 장기 브랜치(프로파일 `long_lived_branches`)를 PR로 올리기 전에 써요. `--merge-ref <머지 커밋>`을 더하면 머지 결과와도 비교해요.
   - 한도 등으로 멈추면 `--resume <run_id>`로 같은 실행을 이어 돌려요.
3. `.verify/`는 `.gitignore`에 넣기를 권해요.
4. 선택
   - 평가 폴더를 옮기려면 프로젝트 `.claude/settings.json`에 `"env": {"VERIFY_EVAL_DIR": "<경로>"}`.
   - 프로젝트 전용 위험 CLI 차단(`commands`)과 판정 에이전트가 읽으면 안 되는 리뷰·분석 기록(`blind`)은 `<평가 폴더>/config/guard.json`에 더해요.
   - diff 밖 신호 도구(도달성·대체 장부·복제본·피처맵)는 플러그인에 없어요. 프로젝트가 준비하면 `VERIFY_SIGNAL_BIN`·`VERIFY_FM_BIN`으로 위치를 알려 줘요. 프로파일에 `ledgers`·`dependents`·`feature_map`이 있거나 Gradle 레포인데 도구가 없으면 경고만 남기고 검증은 계속돼요(안내 `references/profile-guide.md` "diff 밖 신호 도구").
   - 플랫폼 검사 도구는 프로파일 `tools[]`에 `kind: "module"`로 더해요.
   - framework·scoring·rubrics는 플러그인 기본값을 쓰고, 프로젝트 평가 폴더에 같은 파일이 있으면 그쪽이 우선이에요.

### 권한

- pr-verify·verify-design은 `node <플러그인>/skills/<스킬>/scripts/*.mjs`를 Bash로 실행해요. 자주 쓰면 `Bash(node:*)` 허용을 고려해요.

## 훅이 하는 일

플러그인 훅은 플러그인을 켠 맥의 **모든 레포·모든 세션**에 걸려요. 개인 레포도 포함이에요.

| 훅 | 범위 | 동작 |
|---|---|---|
| require-push-approval | 모든 레포 | 모든 `git push`와 `gh pr merge`에 사용자 확인을 받아요. settings의 `permissions.ask`가 따로 필요 없어요. |
| require-pr-flow | 모든 레포 | 보호 브랜치(main·master·dev·develop·development·stg·stage·staging·prd·prod·production)로 직접 push하면 거부해요. |
| require-verify-before-pr | pr-verify 프로파일이 있는 레포만 | `gh pr create` 전에 지금 HEAD의 pr-verify 리포트를 봐요. 없거나 BLOCK·REVIEW_REQUIRED면 확인을 받아요. 장기 브랜치(`long_lived_branches`) PR은 갈림점 기준 `--full` 리포트가 있어야 넘어가요. 확인 사유에 어느 검증 범위에도 안 든 커밋 수를 붙여요. worktree·다른 곳의 clone에서도 레포를 찾아요. 다른 레포에서는 조용해요. |
| require-pane-account | `CLAUDE_CONFIG_DIR`을 쓰는 세션만 | `herdr pane split`·`tab create`·`workspace create`에 `--env CLAUDE_CONFIG_DIR=…`가 없으면 거부해요. herdr는 새 pane을 herdr 서버의 환경으로 띄워서, 그대로면 서브가 기본 계정으로 떠요. 값을 직접 준 명령과 원격 대상(`--machine`·`--remote`)은 통과해요. 기본 프로필 세션에서는 바로 끝나요. |
| verify-guard | verify 에이전트만 | 훅 입력의 `agent_type`이 `harness-james:verify-*`일 때만 판정해요(쓰기 제한, 보정·정답 자료와 다른 실행 폴더, 프로젝트가 `guard.json` `blind`로 정한 기록을 경로 규칙으로 차단 — 재귀 검색·glob·git 기록 포함, 하위 에이전트 제한). /pr-verify 1단계가 실행을 세션에 등록하고, 판정 에이전트는 그 세션의 실행 폴더만 읽어요. 다른 세션은 내장 모듈과 정규식 하나만 쓰고 바로 끝나요. |

- **가드가 실패하면 막아요(`onFailure: block`, Claude Code 2.1.295 이상):** 위 다섯 훅과 pane-lead 서브의 sub-guard가 해당해요. 가드가 시작하지 못하거나(node·스크립트를 못 찾음), 0·2 밖의 코드로 끝나거나, 정한 시간(5~15초)을 넘기면 그 도구 호출을 막고 `… failed; blocking because onFailure is "block"`(시간 초과는 `timed out; blocking …`)과 원인을 보여 줘요. 이 필드가 없으면 그런 실패는 조용히 통과해서 가드가 꺼진 것과 같아요. 2.1.316에서 플러그인 훅으로 확인했어요.
- push 확인과 보호 브랜치 거부 메시지는 "프로젝트 규칙:"으로 시작해요.
- 플러그인 에이전트에서는 frontmatter `hooks`가 돌지 않아서, verify-guard는 플러그인 `hooks/hooks.json`에 걸려 있어요.

## 알려진 점

- **플러그인 경로 읽기 권한:** 플러그인 설치 경로는 작업 폴더 밖이라 하위 에이전트의 Read와 Workflow `scriptPath`가 권한을 묻거나 막혀요. 그래서 pr-verify·verify-design은 실행할 때 판정 기준(framework·rubric 등)과 deep 워크플로를 작업 폴더(RUN_DIR)에 복사해 써요. 플러그인 경로에 Read 허용을 따로 줄 필요는 없어요.
- **계보가 돌 때 업데이트하지 않기:** 위 "설치" 참고.
- **짧은 이름이 모호할 때:** 플러그인 스킬은 `/harness-james:<스킬>`이 정식 이름이에요. 같은 이름의 사용자·프로젝트 스킬이 없으면 `/<스킬>`도 돼요. 같은 이름이 있으면 접두어를 붙여요. 에이전트는 항상 `harness-james:<에이전트>`로 불러야 해요(스킬 `agent:`에 짧은 이름을 쓰면 오류 없이 다른 에이전트로 떨어져요).
- 플러그인 이름 `harness-james`는 코드(skill-check·pr-verify·verify-design의 에이전트 참조, `verdict.mjs`, `deep.mjs`)에 박혀 있어요. 이름을 바꾸면 그곳들도 같이 바꿔야 하고, 테스트가 어긋남을 잡아요.

## 개발

```sh
# harness-james
(cd plugins/harness-james/skills/pane-lead && node --test test/*.test.mjs)
(cd plugins/harness-james/skills/skill-check && SKILL_CHECK_RUNS_DIR="$(mktemp -d)" node --test test/)
(cd plugins/harness-james/skills/pr-verify && node --test test/)
(cd plugins/harness-james/skills/verify-design && node --test test/ && node scripts/check-workflow.mjs)
(cd plugins/harness-james/hooks && node --test test/)
# mod
claude plugin test plugins/work-trace
claude plugin test plugins/context-band
# 매니페스트
claude plugin validate . && for p in plugins/*; do claude plugin validate "$p"; done
```
