# 프로젝트 쪽 pane-collab 안내

## 목차

- [config.json](#configjson) — 역할·계보·옛 이름·어긋남 규칙, 켜고 끄기, 이름 바꾸기, 옛 게시판 줄 나누기
- [project.md](#projectmd) — 혼자 고치는 것, worktree, 공유 자원, 지킬 선(틀 포함)
- [티켓 장부 (선택)](#티켓-장부-선택) — 어긋남 계산이 읽는 꼴
- [세션과 계보](#세션과-계보)

pane-collab 스킬에는 역할 이름과 어느 프로젝트에나 맞는 규칙만 있어요. 프로젝트마다 다른 것은 작업 공간의 게시판 옆에 둬요. 플러그인 폴더는 설치 캐시(읽기 전용, 버전마다 경로가 바뀜)라 거기에는 두지 않아요.

```
<작업 공간>/
  .loop/collab/
    board.jsonl      ← 공용 게시판 (collab add 때 생김, 덧붙이기만)
    projects.json    ← 목표 프로젝트와 역할마다 보고 있는 프로젝트 (collab switch가 만듦, 손으로 고치지 않음)
    config.json      ← 기계가 읽는 설정 (선택): 역할·계보·옛 이름·어긋남 규칙·옛 줄 프로젝트 규칙
    project.md       ← 모델이 읽는 프로젝트 몫 (선택): 혼자 고치는 것, worktree, 자원, 지킬 선
  .research/pane-lead/<계보>/registry.json   ← pane-lead 등록부 (어긋남 계산이 읽기만 함)
  .loop/tickets/     ← 티켓 장부 (선택, 아래 "티켓 장부")
```

두 파일 모두 없어도 돌아요. 그때는 기본 역할 다섯이 모두 켜져 있고, 프로젝트 안내 없이 스킬의 일반 규칙만 써요.

## config.json

collab CLI, 어긋남 계산, 훅 `role-switch-guard`가 같은 모듈(`lib/config.mjs`)로 읽어요. 기본값 위에 덧씌우고, `_`로 시작하는 키는 설명으로 보고 건너뛰어요. 틀은 `${CLAUDE_SKILL_DIR}/examples/config.example.json`이에요.

| 칸 | 모양 | 기본값 | 뜻 |
|---|---|---|---|
| `roles` | `{ "<역할>": true\|false }` | impl·qa·scenarios·infra·pm 모두 `true` | 역할 더하기·켜고 끄기. 이름은 영어 소문자·숫자·`-`(`user`·`all`은 못 씀). `false`인 역할은 `add --to`에 못 넣고, 그 메인에게 가는 SendMessage는 훅이 막아요 |
| `lineages` | `{ "<계보>": "<역할>" }` | `impl`·`qa`·`scn`→`scenarios`·`infra`·`pm` | pane-lead 계보 → 역할. 세션 이름 `<계보>-main-N`, 등록부 `.research/pane-lead/<계보>/`. 계보 이름 규칙은 pane-lead 접두어와 같아요(영어 소문자로 시작, 12자까지) |
| `oldLineages` | `{ "<옛 계보>": "<역할>" }` | 없음 | 이름을 바꾼 계보. 훅만 같이 봐요(옛 이름 메인이 다음 인계로 바뀔 때까지). 등록부는 읽지 않아요 |
| `roleAliases` | `{ "<옛 역할>": "<역할>" }` | 없음 | 이름을 바꾼 역할. 게시판이 들어오는 이름과 옛 줄을 지금 이름으로 읽어요. 줄은 고치지 않아요 |
| `ownerAliases` | `{ "<글 속 이름>": "<주인>" }` | 역할·계보·옛 이름과 그 대문자 꼴 | 티켓 `route`와 "`<이름>` 몫" 글을 주인으로 바꾸는 표. 주인은 역할이 아니어도 돼요(그 주인은 `gaps --to all`에만 나와요) |
| `gaps.staleHours` | 숫자 | 24 | G2·G6·G7이 "오래됨"으로 보는 시간 |
| `gaps.rules` | `{ "G1"…"G9": true\|false }` | G1~G6 켜짐, G7~G9 꺼짐 | 어긋남 규칙 켜고 끄기(`lib/gaps.mjs` 머리에 규칙 설명) |
| `gaps.listMax`, `gaps.mdMaxLines` | 숫자 | 8, 40 | `list`의 gaps 칸 줄 수, `gaps --format md` 줄 수 |
| `gaps.tickets` | 경로 또는 `false` | `.loop/tickets` | 티켓 장부 폴더(작업 공간 기준). 폴더가 없으면 티켓 규칙을 조용히 건너뛰고, 쌓임 줄에서도 티켓 부분이 빠져요 |
| `gaps.g8Owners` | 역할 목록 | `["impl", "scenarios"]` | G8(열린 티켓을 가리키는 게시판 항목이 없음)을 볼 티켓 주인 |
| `legacyProjects` | `{ ids, commonKinds, ranges }` | 없음(모두 `common`) | `project` 칸이 없는 옛 게시판 줄을 프로젝트로 나누는 규칙. 아래 "옛 게시판 줄 나누기" |

- 파일이 깨졌으면(JSON 오류, 객체가 아님) 기본값으로 돌고, CLI 출력에 `config.error`가 붙어요. 훅은 그동안 아무것도 막지 않아요.
- 타입이 맞지 않는 항목(예: `"pm": "off"`)은 건너뛰고 `config.ignored`에 적어요. 꺼진 것으로 읽지 않아요.
- 지금 읽힌 값은 `collab roles`(역할, 꺼진 역할, 계보, 설정 파일)로 봐요.
- 다른 자리의 설정 파일을 쓰려면 `COLLAB_CONFIG=<파일>`을 세션 env에 둬요. CLI와 훅이 같이 따라가요.

### 역할 켜고 끄기

사용자가 정해요. 끈 역할의 메인을 메시지로 깨우지 않으려는 것이라, 끄면 그 역할 앞 게시판 항목도 새로 만들지 않아요. 다시 켜면 그대로 이어져요.

```json
{ "roles": { "pm": false } }
```

### 역할·계보 이름 바꾸기

새 이름으로 바꾸고 옛 이름을 별칭으로 남겨요. 옛 게시판 줄은 그대로 두고 새 이름으로 읽혀요.

```json
{
  "roles": { "qa": true },
  "roleAliases": { "tester": "qa" },
  "oldLineages": { "tst": "qa" }
}
```

- pane-lead 등록부 폴더도 옮겨요(`.research/pane-lead/tst/` → `qa/`). 옛 이름 메인은 다음 인계를 `pane-lead handover --prefix <새 계보> --doc <문서>`로 해서 새 이름으로 넘어가요.

### 옛 게시판 줄 나누기

프로젝트 게시판(`collab switch`)을 쓰기 전에 남긴 줄에는 `project` 칸이 없어요. 기본으로 그런 줄은 모두 공통(`common`)으로 읽어서 어느 프로젝트에서나 보여요. 옛 줄을 프로젝트별로 나누고 싶으면 규칙을 적어요. 게시판 줄은 고치지 않고, 읽을 때만 적용돼요.

```json
{
  "legacyProjects": {
    "ids": { "C-261113-03": "billing-v2" },
    "commonKinds": ["handover", "resource", "worktree"],
    "ranges": [
      { "through": "C-261110-99", "project": "billing-v2" },
      { "through": "C-261119-99", "project": "signup-flow" }
    ]
  }
}
```

- 차례: `ids`(번호 하나씩) → `commonKinds`(이 종류는 공통, 기본은 인계·자원·worktree) → `ranges`(번호가 `through` 이하인 첫 구간) → 공통.
- 프로젝트 이름은 `collab switch --new`로 등록한 이름이어야 그 프로젝트 목록에 나와요.
- 옛 줄을 하나만 옮길 때는 규칙 대신 `collab update <번호> --project <이름>`이 간단해요.

## project.md

스킬이 "먼저 읽을 것"으로 가리키는 파일이에요. 모델이 읽는 글이라 짧은 표와 목록으로 써요. 이 파일과 스킬이 다르면 이 파일이 우선이에요. 넣을 것:

1. **역할별로 혼자 고치는 것:** 역할마다 그 역할만 고치는 문서·도구·폴더·결과 파일 자리. 다른 역할은 읽기만 하고, 고칠 일은 그 역할에 요청해요.
2. **worktree 표:** worktree 폴더, 브랜치, 누가 고치나(한 역할만 / 알리고 한 번에 한쪽 / 아무도 안 고침).
3. **공유 자원 표:** `resource` 양식으로 붙잡는 자원과 단위·주의(DB, 포트, 터널, 미리보기, env 파일, 시험 데이터, 공유 서버).
4. **지킬 선:** 운영 환경에서 하지 않을 것, 공유 서버를 바꾸는 절차, 커밋·PR 규칙(예: 커밋 메시지에 넣지 않을 것), 원격에 올리는 역할.
5. **요청·결함 규칙:** 실행 요청서의 자리와 형식, 실행 순서 파일, 결함을 남기는 티켓·이슈 자리, 불일치 분류와 보내는 곳, 사용자 결정을 적는 곳.

틀(이름은 예시예요):

```markdown
# pane-collab: 이 작업 공간

## 혼자 고치는 것
| 역할 | 혼자 고치는 것 |
|---|---|
| impl | `services/api/`, `apps/web/`, 설계 문서 `docs/design/`, `.research/pane-lead/impl/` |
| qa | 시험 도구 `tools/e2e/`, 실행 기록 `.loop/runs/`, `.research/pane-lead/qa/` |
| scenarios | 판정 기준 `docs/scenarios/`, 요청서 `.loop/requests/`(`<R-ID>.json`, 순서 `queue.md`) |
| infra | 배포 메모 `docs/ops/deploy.md`, `.research/out/infra-*` |
| pm | `.research/pm/` |

## worktree
| worktree | 브랜치 | 누가 고치나 |
|---|---|---|
| `api` | main | 공유 체크아웃. 아무도 브랜치를 바꾸거나 고치지 않아요 |
| `api-next` | feat/next | impl만 |
| `api-auth` | feat/auth | 알리고 한 번에 한쪽(impl 또는 qa) |

## 공유 자원
| 자원 | 붙잡는 단위와 주의 |
|---|---|
| 로컬 DB 컨테이너(5432) | DB 단위. 컨테이너를 멈추면 모두에 영향 |
| 개발 서버 | infra 몫. 바꾸는 일은 infra가 사용자 승인을 받아서 |

## 지킬 선
- 운영 환경에는 쓰지 않아요. 개발 환경의 시험 데이터만 만들어요.
- 결함은 `.loop/tickets/T-YYMMDD-NN/`에 남기고 메시지는 그 ID를 가리켜요.
- 판정 기준과 설계가 다르면 사용자 결정 기록을 달아 "기준 오래됨"(결정이 기준보다 뒤) 또는 "설계 빈틈 후보"로 나눠요. 기준과 설계가 같은데 구현만 다르면 "구현 결함"이고 티켓으로 impl에 가요.
- 사용자 결정은 `docs/decisions.md`에 결정 ID와 원문으로 적어요.
```

## 티켓 장부 (선택)

어긋남 규칙 G1·G3·G5·G6·G8·G9는 티켓 장부를 게시판과 대어 봐요. 장부가 없으면 이 규칙들은 아무것도 내지 않아요. 쓰려면 아래 꼴로 둬요(자리는 `gaps.tickets`).

- 폴더: `<장부>/T-YYMMDD-NN/`에 `ticket.md`, 선택으로 `decisions.tsv`
- `ticket.md`: 줄 머리 키를 읽어요.
  - `status:` 첫 낱말이 상태예요. 닫힘으로 보는 것: `closed`·`verified`·`gated`·`handed-off`·`stopped`. `fixed`는 고쳤고 재시험을 기다리는 상태예요.
  - `route:` 맨 앞 이름이 주인이에요(예: `route: "impl: 고친다"`). `ownerAliases`로 주인을 찾고, 못 찾으면 `?`예요.
  - `source:` 안의 `received: <ISO 시각>`이 받은 시각이에요(쌓임의 "2일 넘음").
  - 첫 `# ` 줄이 제목이에요.
- `decisions.tsv`: 한 줄에 한 결정, 탭으로 나눠요. 첫 칸은 오프셋까지 적은 시각(`2026-10-21T14:30+09:00`)이에요. 둘째·셋째 칸에 "재시험"이나 "retest"가 있고 그 줄 어딘가에 `PASS`(또는 "통과")가 있으면 재시험 통과로 봐요.
- 남은 일을 다른 역할에 넘길 때는 상태나 마지막 결정 줄에 "`<역할>` 몫"이라고 적어요(G3이 그 역할 앞 게시판 항목이 있는지 봐요).

## 세션과 계보

- 역할 메인은 pane-lead로 띄워요: herdr 빈 셸 pane에서 `pane-lead main --prefix <계보>`, 메인 안에서 `/harness-james:pane-lead start <계보>`.
- 계보 이름이 설정 `lineages`에 있어야 훅과 어긋남 계산(G4: 새 메인인데 게시판 `handover` 알림이 없음)이 그 메인을 역할에 이어요.
