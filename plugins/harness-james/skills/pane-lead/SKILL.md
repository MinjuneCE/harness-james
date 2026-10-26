---
name: pane-lead
description: herdr 위에서 메인 Claude pane 하나와 서브 pane(계보당 최대 5개)으로 작업을 나눠 하는 메인 세션 운영 규칙. pane-lead 실행 스크립트가 `start <접두어>`로, 인계 때 `takeover <인계 문서>`로 직접 부른다(플러그인에서는 `/harness-james:pane-lead`, 사용자 스킬이면 `/pane-lead`).
argument-hint: start <접두어> | takeover <인계 문서 경로>
arguments: [mode, target]
disable-model-invocation: true
allowed-tools: Read(/${CLAUDE_SKILL_DIR}/**)
---

# pane-lead: 메인 세션 운영

이번 호출: `$mode $target`
- `start`면 계보 `$target`의 메인으로 시작해요(아래 "시작").
- `takeover`면 `$target` 인계 문서를 읽고 이어받아요(아래 "인계 받기").

CLI는 `node "${CLAUDE_SKILL_DIR}/bin/pane-lead.mjs" <명령>`이에요. 아래에서는 `pane-lead`로 줄여 써요. 출력은 JSON 한 줄이고, 실패하면 `{"ok":false,"error","next"}`에 다음 할 일이 있어요. 옵션 상세는 `pane-lead <명령> --help`로 봐요. 계보(`PANE_LEAD_PREFIX`, `PANE_LEAD_ROOT`)와 역할(`PANE_LEAD_ROLE=main`)은 실행 settings의 env로 이미 들어와 있어요.

## 역할

- **사용자는 메인하고만 이야기해요.** 핵심 판단, 권한, 승인은 메인에서 다뤄요. 큰 작업과 넓은 조사는 서브에 맡기고, 메인은 요약을 받아 사용자와 정리해요.
- **메인:** Opus 5.5, effort max(실행 인자 `--effort max`). 권한 모드는 사용자 기본값(auto).
- **서브:** Opus 5.5, effort 지정 없음(모델 기본값). 사용자에게 직접 묻지 않고, 결과 파일의 "메인에게" 칸에 적어요.
- **push, PR 생성, merge는 메인만 해요.** 서브는 커밋까지만 해요. 서브 실행 settings가 deny 규칙, guard 훅, git env 세 층으로 막아 두었어요. 푸시가 사용자 승인 경로(메인의 확인 창) 밖에서 일어나지 않게 하려는 거예요.

## 시작 (`start <p>`)

1. `pane-lead status`로 계보 상태를 봐요. 이전 세대의 서브가 남아 있으면 목록을 확인해요.
2. 사용자에게 한 줄로 시작을 알리고 요청을 받아요.

## 작업 나누기

1. **성격 판단:** 요청을 성격(조사, 설계, 구현, 검증 등)별로 나눠요. 메인이 바로 답할 수 있는 핵심 질문은 메인이 직접 해요.
2. **지시서:** `${CLAUDE_SKILL_DIR}/templates/brief.md` 양식으로 `.research/tasks/<name>.md`를 써요. 이미 정해진 사용자 결정과 원문은 지시서에 옮겨 서브가 다시 묻지 않게 해요.
3. **spawn:** `pane-lead spawn <name> --brief .research/tasks/<name>.md --kind <성격>`
   - 결과 파일 기본값은 `<root>/.research/out/<name>.md`예요. 다르게 하려면 `--result`, 작업 폴더는 `--cwd`로 줘요.
   - spawn은 "지시서를 읽고, 결과 파일에 요약을 남기고, 사용자에게 묻지 말라"는 시작 프롬프트를 자동으로 보내요.
4. **wait:** `pane-lead wait <name>`을 Bash 백그라운드로 걸어요. 끝나면 알림이 와요.
   - `done`/`idle`: 결과 파일 맨 위 요약(15줄 이하)이 나와요. 요약이 없으면 화면 끝 줄이 나와요.
   - `blocked`: 확인 창(`dialog`)이 나와요 → "승인 중계"
5. **회수:** 요약을 사용자에게 전해요. 결과 파일 상세는 필요한 부분만 읽어요. "메인에게" 칸의 결정 요청은 사용자에게 물어서 답을 지시서나 `send`로 전해요.

### 동시 실행, 재사용, 닫기

- 열린 서브는 계보당 5개까지예요. spawn이 `error:"cap"`이면 대기열에 두고, 서브 하나를 닫은 뒤 띄워요.
- 성격이 다른 일은 새 서브에 맡겨요.
- 같은 결과물을 고치는 일만 그 서브를 재사용해요: `pane-lead send <name> "<지시>"`. 서브의 컨텍스트가 50% 이상이면 `send`가 거부해요. 그때는 새 서브를 띄우고, 이전 결과 파일을 입력으로 줘요.
- 끝난 서브는 결과를 회수한 뒤 `pane-lead close <name>`으로 닫아요. working이면 거부하고, 일을 멈추게 할 때만 `--force`를 써요.

## 승인 중계

서브가 확인 창에서 멈추면 `wait`가 `blocked`와 `dialog{kind, question, context, options}`를 내요.

- **일반 확인 창(`kind:"permission"`)**
  - 사용자에게 어느 서브가 무엇을 왜 하려는지 보여 줘요(`context`의 명령과 지시서 목적).
  - OK면 `pane-lead approve <name>`: "이번만 허용(Yes)"을 골라요. "다시 묻지 않기"(`--always`)는 사용자가 그렇게 말할 때만 써요.
  - 거부면 `pane-lead deny <name>`이에요. 이러면 서브의 턴이 멈춰요. 다른 방법으로 계속하게 하려면 `--message "<대신 할 일>"`을 붙여요.
  - 승인한 뒤에는 `wait`를 다시 걸어요.
- **auto 분류기 에스컬레이션 창(`kind:"classifier"`)**
  - 분류기가 연속으로 막은 동작이라 뜬 창이에요. 약 2분 뒤 자동으로 거부돼요.
  - `approve`는 기본으로 거부해요. 사용자에게 "분류기를 무시하고 허용할지"를 따로 묻고, 명시적으로 OK할 때만 `pane-lead approve <name> --over-classifier`를 써요. 아니면 `deny`예요.
- **분류기가 막아서 창 없이 끝난 경우:** 서브가 결과 파일 "메인에게"에 요청을 적어요. 메인이 사용자에게 묻고, 승인 원문을 `send`(또는 `deny --message`)로 서브에게 전해요.
- **push·PR·merge:** 서브의 "메인에게" 요청을 보고 메인이 직접 실행해요. 사용자가 메인의 확인 창에서 승인해요.

## 같은 코드를 여러 서브가 고칠 때

- 서브마다 사본(`.research/build/<name>/`)이나 `git worktree`에서 작업하게 지시서에 적어요. 원본은 "통합하세요" 지시 전에는 건드리지 않게 해요.
- 통합은 메인이 한 번에 하나씩 해요.
  - 세 갈래를 비교해요: 서브가 시작한 기준본, 서브 사본, 지금의 원본. 예: `git merge-file` 또는 `diff3`.
  - 통합할 때마다 테스트나 확인 절차를 다시 돌려요. 그다음 서브를 통합해요.
- 통합을 서브에 맡길 때도 한 번에 한 서브만 원본을 고쳐요.

## 컨텍스트와 인계

- 50%를 넘으면 훅이 `컨텍스트 N%` 한 줄을 보여 줘요. 직접 볼 때는 `pane-lead ctx --self`예요. 값은 context-band의 %와 같아요.
- 알림을 끄거나 켜는 명령은 `node "${CLAUDE_SKILL_DIR}/hooks/ctx-note.mjs" off|on|status`예요. 사용자가 원할 때만 바꿔요.
- **50~75%:** 자연스러운 경계에서 인계해요. 경계는 사용자 요청 하나가 끝나고 그 결과를 보고한 때예요. 조건은 셋이에요.
  - 사용자 요청 하나가 끝났고 사용자에게 보고했어요. 요청 중간 단계(서브 결과를 받고 다음 단계 서브를 띄운 때 등)는 경계가 아니에요.
  - 사용자에게 걸린 질문이나 승인이 없어요.
  - 진행 중인 통합이 없어요.
- **75% 이상:** 요청이 끝나지 않았어도 이번 턴을 끝낼 때 인계해요. 진행 상태는 인계 문서에 적어요. 상한은 80%예요.
- 도구가 실행 중인 턴 한가운데서는 인계하지 않아요. 결과를 받기 전에 넘기면 그 결과가 어느 메인에도 남지 않아요.
- 서브가 작업 중이어도 기다리지 않아요. 서브 목록과 상태를 인계 문서로 넘기면 새 메인이 대기를 다시 걸어요.

### 인계 하기

1. `pane-lead status`를 실행해요.
2. `${CLAUDE_SKILL_DIR}/templates/handover.md` 양식으로 `<root>/.research/pane-lead/<p>/handover/main-<n>.md`를 써요(n = 지금 세대).
3. `pane-lead handover --doc <그 파일>`: 메인 pane 아래에 다음 메인을 띄우고 `takeover <doc>`로 이 스킬을 불러요.
   - 작업 공간에 `.research/pane-lead/attach.json`이 있으면 handover가 그 계보의 명령 출력을 문서 끝에 "기계 계산" 절로 붙여요(결과는 출력의 `attach`).
   - 사용자가 다른 Claude 계정으로 옮기자고 하면 `--config-dir <프로필 폴더>`(예: `~/.claude-alt`)를 붙여요. 기본 프로필로는 `--config-dir ~/.claude`예요(새 메인에 `CLAUDE_CONFIG_DIR`를 붙이지 않아요). 새 탭에 띄우라고 하면 `--tab "<탭 이름>"`을 붙여요.
   - 새 pane이 로그인·테마 고르기 화면이면(로그인이 없는 프로필) handover가 프롬프트를 보내지 않고 `login-required`로 멈춰요. 새 pane은 닫히고 이 메인이 계보를 계속 맡아요.
   - 새 메인과 그 메인이 띄우는 서브는 그 계정으로 떠요. 이전 메인이 띄운 서브는 닫을 때까지 이전 계정으로 돌아요. 대기, 승인, `send`는 herdr로 하므로 계정이 달라도 그대로 돼요.
   - 플러그인 설치는 프로필마다 따로예요. 옮길 프로필에도 이 플러그인이 있어야 새 메인이 `takeover`를 불러요.
4. 사용자에게 한 줄로 알리고("컨텍스트 N%라 <p>-main-<n+1>로 인계해요") 턴을 끝내요. 새 메인은 이 턴이 끝나야 인수를 마칠 수 있어요.

보고는 사용자 화면에 보이는 응답이에요. 인계 알림만 남기고 턴을 끝내면 그 턴의 결과는 사용자에게 전해지지 않아요.

### 인계 받기 (`takeover <doc>`)

1. 인계 문서를 읽어요. 거기 적힌 핵심 파일은 필요한 것만 읽어요.
2. `pane-lead takeover-done`: 이전 메인이 멈출 때까지 기다린 뒤 그 pane을 닫고, 이 pane이 그 자리를 채워요. 사용자가 메인 탭을 보고 있을 때만 포커스를 옮겨요(`focus`에 결과가 나와요). 이전 세션은 `/resume`으로 다시 열 수 있어요.
3. `pane-lead status`로 서브 상태를 확인하고, working인 서브마다 `pane-lead wait <name>`을 백그라운드로 다시 걸어요. blocked인 서브는 "승인 중계"대로 처리해요.
4. 사용자에게 한 줄 인사와 현황(진행 중인 일, 걸린 질문)을 알리고, 인계 문서의 "새 메인이 다시 전할 보고 원문"을 함께 전해요. 이전 메인 pane은 `takeover-done`이 닫아서, 사용자가 인계하는 턴의 보고를 못 봤을 수 있어요.

## 명령

| 명령 | 쓰임 |
|---|---|
| `spawn <name> --brief f [--kind k] [--result f] [--cwd d] [--prompt t]` | 서브를 띄우고 지시서를 줘요 |
| `wait <name> [--timeout ms]` | idle·done·blocked까지 기다려요. 백그라운드로 써요 |
| `approve <name> [--always] [--over-classifier]` | 확인 창에서 "Yes"를 골라요 |
| `deny <name> [--message t] [--esc]` | "No"를 골라요. `--message`로 후속 지시 |
| `send <name> <text> [--force]` | idle·done 서브 재사용(ctx 50% 미만) |
| `ctx [<name>\|--self]` | 컨텍스트 % |
| `status [--no-ctx]` | 메인·서브 목록, 상태, ctx, 지시서, 결과 파일, `cap` |
| `close <name> [--force]` | 이 계보 서브 pane을 닫아요 |
| `handover --doc f [--prompt t] [--tab 이름] [--config-dir d]` | 다음 메인을 띄워요(현재 메인 pane에서만). `--tab`은 새 탭에, `--config-dir`은 다른 계정 프로필로 |
| `takeover-done [--no-focus] [--timeout ms]` | 새 메인이 이전 메인을 닫고 자리를 이어받아요 |

`main [--prefix p]`는 사용자가 빈 셸 pane에서 메인을 띄울 때 쓰는 명령이에요. 메인 세션에서는 쓰지 않아요. 다른 계정 프로필로 띄우려면 `CLAUDE_CONFIG_DIR=<프로필 폴더> pane-lead main --prefix <p>`예요. pane-lead가 띄우는 pane은 부른 쪽의 `CLAUDE_CONFIG_DIR`을 이어받아서, 서브도 메인과 같은 계정으로 떠요.
사용자 셸의 `pane-lead` 명령은 `bin/pane-lead-shim.mjs`예요. 설치 기록에서 지금 설치된 플러그인 버전을 찾아 이 CLI를 실행해요(`--install`로 `~/.local/bin`에 복사). 메인 세션에서는 쓰지 않아요.

## 실패할 때

| 증상 | 대처 |
|---|---|
| spawn `cap` | `status`로 끝난 서브를 찾아 `close`한 뒤 다시 spawn |
| spawn `blocked-start` | 처음 보는 폴더의 trust 창 등이에요. 사용자에게 물은 뒤 `herdr agent send-keys <name> down enter`로 "Yes, I trust"를 고르고, `send <name> "<시작 프롬프트>"` |
| wait `dialog:null` | 번호 없는 창이에요. `herdr agent read <name> --source visible`로 보고 사용자에게 물어요 |
| approve "no Yes option" | 질문형 창(AskUserQuestion 등)이에요. 사용자 답을 `herdr agent send-keys`로 넣어요 |
| 서브 입력칸에 흐린 글자가 있어요 | 제출되지 않은 글자예요. 서브는 Claude Code의 다음 입력 예측을 꺼 두었지만(`promptSuggestionEnabled:false`), 사람이 친 글인지는 `herdr agent read <name> --format ansi`의 흐림 표시(`ESC[2m`)로 구분해요 |
| 승인 직후에도 `blocked` | herdr가 1~2초 늦게 바뀌어요. 상태를 직접 읽지 말고 `wait`를 다시 걸어요 |
| takeover-done "still working" | 이전 메인의 턴이 안 끝났어요. 잠시 뒤 다시 실행해요 |
| handover `login-required` | 새 pane의 프로필에 로그인이 없어요(`data.config_dir`). 새 pane은 닫혔고 이전 메인이 그대로 맡아요. 사용자에게 알리고, 사용자가 빈 셸 pane에서 그 프로필로 로그인한 뒤 다시 실행해요 |
| spawn·handover "not an available shell"(`shell-busy`) | 새 pane의 셸이 약 8초 동안 준비되지 않았어요. CLI가 그 pane을 닫았으니 같은 명령을 다시 실행해요 |
| takeover-done `filled` ≠ true | `herdr pane layout`을 보고 `herdr pane resize`로 맞춰요 |
| `/hooks`에 ctx 훅이 안 보여요 | `--settings`로 넣은 훅이라 목록에 안 나와요. 동작은 해요. 확인은 트랜스크립트의 `hook_additional_context`로 해요 |
| 레지스트리 잠금 오류 | 30초 지난 잠금은 자동으로 풀려요. 다른 pane-lead 명령이 돌고 있지 않은데 계속되면 `<root>/.research/pane-lead/<p>/registry.json.lock` 폴더를 지워요 |

herdr로 다른 계보나 사용자가 만든 pane·에이전트에 키를 보내거나 닫지 않아요. CLI는 이 계보 레지스트리에 있는 이름과 pane이 모두 맞을 때만 동작해요.
