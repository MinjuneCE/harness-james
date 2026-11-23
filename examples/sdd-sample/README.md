# SDD 예시 한 벌: 내보낸 파일 보관과 삭제

**합성 예시예요. 실제 프로젝트의 문서가 아니에요.** 기능, 결정, 날짜는 이 레포의 `spec-kit`·`decision-log` 스킬이 어떻게 맞물리는지 보이려고 지어낸 것이에요.

두 스킬의 스크립트를 실제로 돌려 만들었어요. `runs/`의 출력은 고치지 않고 그대로 담았어요.

## 들어 있는 것

| 경로 | 무엇 |
|---|---|
| `.specify/` | `spec-kit init`이 놓은 것. spec-kit 템플릿 5개와 `LICENSE`·`SOURCE.txt`(MIT, Copyright GitHub, Inc.), constitution 자리(템플릿 그대로) |
| `specs/001-export-retention/spec.md`·`plan.md` | `spec-kit feature`가 만든 파일에서 이 예시에 필요한 절만 남기고 채운 것. 제목 아래에 "반영한 결정" 머리 줄이 있어요 |
| `specs/001-export-retention/decisions.md` | 결정 기록. 결정 3개(D1~D3)와 제안 1개(P1)가 있고 D3가 D1을 대체해요. "지금 유효한 결정" 표는 `--sync-table`이 만들었어요 |
| `runs/` | 아래 순서로 돌린 명령과 출력 |

## 돌린 순서

| 파일 | 한 일 | 결과 |
|---|---|---|
| `runs/01-init.txt` | `spec-kit init` | 템플릿과 constitution 자리를 놓음 |
| `runs/02-feature.txt` | `spec-kit feature` | 기능 폴더 `001-export-retention`을 엶 |
| `runs/03-sync-table.txt` | 첫 세션의 결정 D1·D2를 적고 `--sync-table` | 표를 만듦 |
| `runs/04-check-first.txt` | spec·plan에 D1·D2를 반영하고 검사 | 전부 PASS |
| `runs/05-check-behind.txt` | 둘째 세션의 D3(D1 대체)와 제안 P1을 적고 spec만 맞춘 뒤 검사 | plan.md가 1건 뒤처졌다는 WARN |
| `runs/06-check-header-only.txt` | plan.md의 머리 줄 번호만 올리고 본문은 그대로 둔 채 검사 | 대체된 D1을 가리키는 줄(`plan.md:33`)과 D3 인용이 없다는 WARN 2건 |
| `runs/07-plan-fix.diff` | plan.md를 맞춘 차이(05 상태에서 지금 상태로) | |
| `runs/08-check-synced.txt` | 다시 검사 | WARN 0. 답을 기다리는 제안 P1은 INFO로 남음 |
| `runs/09-current.txt` | `--current` | 유효한 결정 2건과 다음 번호 |

## 다시 돌려 보기

레포 루트에서 돌려요. Node 18 이상이면 되고 설치할 것은 없어요.

```sh
# 지금 상태 검사: runs/08-check-synced.txt와 같은 줄이 나와요
node plugins/harness-james/skills/decision-log/bin/decision-check.mjs examples/sdd-sample/specs/001-export-retention

# 뒤처진 상태로 되돌려 검사: runs/05-check-behind.txt와 같은 줄이 나와요
(cd examples/sdd-sample/specs/001-export-retention && patch -R plan.md ../../runs/07-plan-fix.diff)
node plugins/harness-james/skills/decision-log/bin/decision-check.mjs examples/sdd-sample/specs/001-export-retention
git checkout examples/sdd-sample/specs/001-export-retention/plan.md

# 처음부터 새로 만들어 보기(다른 스펙 루트에)
node plugins/harness-james/skills/spec-kit/bin/spec-kit.mjs init examples/my-sample
node plugins/harness-james/skills/spec-kit/bin/spec-kit.mjs feature examples/my-sample export-retention
```

- `runs/`에 찍힌 경로 `/private/tmp/harness-james/`는 이 예시를 만들 때 레포를 풀어 둔 자리예요.
- 출력 끝의 걸린 시간은 돌릴 때마다 다를 수 있어요.

## 이 예시의 한계

- 검사기는 결정 번호가 인용됐는지만 봐요. `runs/06`처럼 번호가 어긋난 것은 잡지만, 번호만 고치고 내용을 그대로 둔 것은 잡지 못해요. 내용은 사람과 에이전트가 읽어야 알아요.
- spec-kit CLI(`specify`)와 `/speckit.*` 명령은 쓰지 않았어요. 템플릿과 폴더 구조만 써요.
- tasks.md, research.md 같은 나머지 문서와 구현 코드는 만들지 않았어요.
