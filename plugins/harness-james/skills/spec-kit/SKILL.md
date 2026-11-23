---
name: spec-kit
description: GitHub spec-kit 형식의 스펙 문서(SDD) 폴더를 프로젝트에 놓고 쓰는 법. 고정 커밋의 원본 템플릿(spec·plan·tasks·checklist·constitution)을 프로젝트의 .specify/templates/에 복사하고, 기능 폴더 specs/NNN-이름/을 spec.md·plan.md와 결정 기록 decisions.md("반영한 결정" 머리 줄 포함)로 시작한다. 새 프로젝트나 레포에 스펙 문서 구조를 처음 만들 때, 새 기능 스펙 폴더를 열 때, 사용자가 spec-kit·SDD·스펙 템플릿·기능 스펙 폴더를 요청할 때 쓴다. spec-kit CLI(specify)와 /speckit.* 명령은 들어 있지 않고, 템플릿 판 올리기나 스펙 본문 작성은 하지 않는다. 결정 기록의 쓰기와 검사는 같은 플러그인의 decision-log 스킬 몫이다.
argument-hint: "init <스펙 루트> | feature <스펙 루트> <짧은 이름> [--no-decisions]"
allowed-tools: Read(/${CLAUDE_SKILL_DIR}/**) Bash(node ${CLAUDE_SKILL_DIR}/bin/spec-kit.mjs *)
---

# spec-kit

```bash
node ${CLAUDE_SKILL_DIR}/bin/spec-kit.mjs init <스펙 루트>                       # 템플릿과 constitution 자리를 놓는다
node ${CLAUDE_SKILL_DIR}/bin/spec-kit.mjs feature <스펙 루트> <짧은 이름>         # 다음 번호의 기능 폴더를 연다
node ${CLAUDE_SKILL_DIR}/bin/spec-kit.mjs feature <스펙 루트> <짧은 이름> --no-decisions   # 결정 기록 없이
```

- 프로젝트 폴더(`CLAUDE_PROJECT_DIR`, 없으면 명령을 부른 현재 폴더) 안에만 쓴다. 밖이면 아무것도 쓰지 않고 종료 코드 2로 끝낸다.
- 있는 파일은 덮어쓰지 않는다. 출력의 `그대로 둠` 줄이 건너뛴 파일이다. 그래서 `init`을 다시 불러도 고친 템플릿과 constitution은 그대로다.
- Node 18 이상, 의존성 없음.

## 폴더 구조

스펙 루트 하나가 spec-kit 저장소 루트와 같은 모양이다.

```text
<스펙 루트>/
  .specify/
    templates/        # init이 놓는 원본 템플릿 5개 + LICENSE + SOURCE.txt
    memory/
      constitution.md # 프로젝트 원칙. constitution-template.md를 채워 쓴다
  specs/
    001-<짧은 이름>/
      spec.md         # 무엇을, 왜(사용자 시나리오, 요구사항, 성공 기준)
      plan.md         # 어떻게(기술 맥락, constitution 점검, 구조)
      decisions.md    # 결정 기록(decision-log 스킬)
      research.md     # 기술 조사(plan.md의 Phase 0)
      data-model.md   # 엔티티와 상태(Phase 1)
      quickstart.md   # 써 보는 순서(Phase 1)
      contracts/      # API 계약(Phase 1, openapi.yaml·.graphql 등)
      tasks.md        # 작업 목록(tasks-template.md)
```

- `feature`는 spec.md, plan.md, decisions.md만 만든다. research.md·data-model.md·quickstart.md·contracts/는 원본 템플릿이 없어서 plan.md의 Phase 0·1 설명대로 필요할 때 직접 만든다. tasks.md는 `.specify/templates/tasks-template.md`를 복사해 쓴다.
- 번호는 `specs/` 안에서 가장 큰 `NNN-` 다음이다. 짧은 이름은 소문자·숫자·하이픈이다.
- 스펙 루트를 어디에 둘지는 프로젝트가 정한다. 레포 하나면 레포 루트(`.`)에 두면 원본 spec-kit과 같은 자리다. 작업 공간 하나에서 레포 여럿을 다루면 `docs/sdd/<레포>`처럼 레포마다 스펙 루트를 둔다. 이렇게 둔 폴더는 내용을 그 레포 루트로 옮기면 원본 spec-kit 구조와 같다.
- `feature`는 스펙 루트의 `.specify/templates/`에 템플릿이 있으면 그것을, 없으면 이 스킬에 든 원본을 쓴다. 프로젝트에 맞게 템플릿을 고치려면 `.specify/templates/` 쪽을 고친다.

## 템플릿

| 파일 | 쓰임 |
|---|---|
| `spec-template.md` | 기능 명세. `[NEEDS CLARIFICATION: …]`로 모르는 것을 표시한다 |
| `plan-template.md` | 구현 계획. Constitution Check 표, Complexity Tracking(원칙 위반 정당화) |
| `tasks-template.md` | 작업 목록. `[P]` = 함께 할 수 있는 일, 사용자 스토리별 묶음 |
| `checklist-template.md` | 요구사항 품질 점검표 |
| `constitution-template.md` | 프로젝트 원칙과 판 관리 |

- 원본 템플릿은 고치지 않고 그대로 담았다(`SOURCE.txt`의 커밋과 바이트가 같다). 판을 올릴 때 비교가 쉽고 출처가 분명하다.
- 템플릿 안의 `$ARGUMENTS`, `__SPECKIT_COMMAND_PLAN__` 같은 자리는 원본 `/speckit.*` 명령이 채우는 자리다. 명령 없이 쓸 때는 사람과 에이전트가 직접 채운다. 섹션 제목은 원본대로 두고 본문은 프로젝트 말로 써도 된다.
- 출처: github/spec-kit `0443760542e7`(2026-10-12에 받음), MIT License, Copyright GitHub, Inc. 전문은 `templates/LICENSE`에 있고 `init`이 프로젝트에도 함께 놓는다.

## 결정 기록과의 연결

- `feature`로 연 폴더의 spec.md·plan.md 제목 바로 아래에는 `**반영한 결정**: 없음 ([decisions.md](decisions.md))` 줄이 들어간다. 원본 템플릿에는 없는 줄이라 폴더를 만들 때만 더한다.
- decisions.md는 decision-log 스킬의 양식을 그 기능 이름으로 채운 것이다. 결정을 적고 머리 줄을 올리고 검사하는 법은 decision-log 스킬에 있다.
- 결정 기록 없이 원본 그대로 쓰려면 `--no-decisions`다.
