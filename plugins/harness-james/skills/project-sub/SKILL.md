---
name: project-sub
description: >-
  지금 게시판 프로젝트가 아닌 다른 프로젝트의 간단한 일을, 게시판을 전환하지 않고 그 프로젝트에 고정된 서브 pane 하나에 맡긴다.
  pane-collab 역할 메인(기본 impl·qa·scenarios·infra·pm)이 사용자에게서 다른 프로젝트의 작은 일(문구 하나 고치기, 보류 항목 확인, 로그 한 번 읽기)을 받았을 때,
  또는 사용자가 /harness-james:project-sub <프로젝트> <할 일>로 부를 때 쓴다. 지시서를 쓰고 pane-lead spawn --env COLLAB_PROJECT=<프로젝트>로 서브를 띄우고,
  결과 요약만 받아 보고한 뒤 pane을 닫는다. 큰 일은 맡지 않는다(사용자에게 게시판 전환을 묻는다). 같은 프로젝트의 서브는 pane-lead로 띄운다.
argument-hint: <프로젝트 이름> <할 일>
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/pane-lead/templates/**) Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/pane-collab/bin/collab.mjs *)
---

# project-sub: 다른 프로젝트의 간단한 일

pane-collab의 역할들은 한 번에 한 프로젝트만 해요. 메인은 다른 프로젝트 게시판을 읽거나 쓰지 않아요. 다른 프로젝트의 간단한 일은 그 프로젝트에 고정된 서브가 하고, 끝나면 pane을 닫아요. 게시판은 전환하지 않아요.

이 스킬은 같은 플러그인의 pane-collab과 pane-lead를 써요. 아래에서 `collab`은 `node ${CLAUDE_PLUGIN_ROOT}/skills/pane-collab/bin/collab.mjs`, `pane-lead`는 `node ${CLAUDE_PLUGIN_ROOT}/skills/pane-lead/bin/pane-lead.mjs`예요. 둘 다 작업 공간 루트에서 실행해요.

## 언제 쓰나

| 상황 | 할 일 |
|---|---|
| 사용자가 지금 프로젝트가 아닌 프로젝트의 간단한 일을 시킴 | 이 스킬 |
| 그 일이 큼(여러 역할이 움직임, 며칠 걸림, 재시험이 오감) | 이 스킬을 쓰지 않아요. 사용자에게 게시판 전환을 물어요(pane-collab "프로젝트와 게시판 전환") |
| 지금 프로젝트의 일을 서브에 나눔 | 이 스킬을 쓰지 않아요. pane-lead로 띄워요 |
| 어느 프로젝트 일인지 모름 | `collab project`의 `projects`를 보여 주고 사용자에게 물어요 |

크기가 애매하면 사용자에게 "서브로 할까요, 전환할까요"를 한 번 물어요. 크기는 사용자가 정해요.

## 절차

1. **프로젝트 확인:** `collab project`를 실행해요.
   - 맡을 프로젝트 이름이 `projects`에 있어야 해요. 없으면 사용자에게 이름을 확인해요.
   - 그 이름이 내 역할이 보고 있는 프로젝트(`roles.<내 역할>`)와 같으면 이 스킬이 아니에요. 그냥 하거나 pane-lead로 나눠요.
2. **지시서:** `.research/tasks/<서브 이름>.md`를 pane-lead의 지시서 양식(`${CLAUDE_PLUGIN_ROOT}/skills/pane-lead/templates/brief.md`)으로 쓰고, 아래 "지시서에 넣을 줄"을 넣어요. 서브 이름은 `<프로젝트 줄임>-<일>` 꼴이에요(예: `bill-copy`).
3. **띄우기:** 프로젝트를 고정해서 띄워요.

   ```sh
   pane-lead spawn bill-copy --brief .research/tasks/bill-copy.md --kind <성격> --env COLLAB_PROJECT=billing-v2
   ```

   - `--env COLLAB_PROJECT=<프로젝트>`가 이 서브의 게시판 범위를 그 프로젝트 + 공통으로 고정해요. 빠뜨리면 서브가 메인의 프로젝트 게시판에 써요.
   - 모델, 서브 수 제한(계보당 5개), 승인 중계는 pane-lead 규칙 그대로예요.
4. **기다리기:** `pane-lead wait <서브 이름>`을 Bash 백그라운드로 걸어요.
5. **보고:** 결과 파일 맨 위 요약만 사용자에게 전해요. 상세가 필요할 때만 결과 파일의 해당 부분을 읽어요. 그 프로젝트의 게시판이나 문서를 메인이 따로 읽지 않아요.
6. **닫기:** `pane-lead close <서브 이름>`으로 pane을 닫아요. 같은 결과물을 고쳐 달라는 일만 닫기 전에 `pane-lead send <서브 이름> "<일>"`로 같은 서브에 보내요. 같은 프로젝트라도 새 일이면 새 서브를 띄워요(pane-lead "동시 실행, 재사용, 닫기"와 같아요. 결과 파일이 서브당 하나예요).

## 지시서에 넣을 줄

```text
## 게시판
- 이 서브는 <프로젝트> 프로젝트에 고정돼 있어요(env COLLAB_PROJECT). collab 명령은 평소처럼 쓰고, 범위는 도구가 정해요.
- 읽기: node <collab 경로> list --open --to <메인의 역할>
- 쓰기(고친 항목): node <collab 경로> update <번호> --status <상태> --note "<한 줄>" --by <메인의 역할>
- 쓰기(새 항목): node <collab 경로> add --from <메인의 역할> --to <받는 역할> --kind <종류> --title "<한 문장>"
- 하지 않는 것: 게시판 전환(collab switch, 도구가 거절해요), SendMessage, 다른 프로젝트 게시판 보기
- 출력의 project가 <프로젝트>가 아니면 멈추고 결과 파일 "메인에게"에 적어요.
```

- `<collab 경로>`에는 위에 보이는 `${CLAUDE_PLUGIN_ROOT}/skills/pane-collab/bin/collab.mjs`를 그대로(절대 경로) 옮겨요. 서브는 이 스킬을 부르지 않으니 지시서에 경로가 다 적혀 있어야 해요.
- 게시판을 볼 필요가 없는 일(코드 한 줄, 문서 한 줄)이면 읽기·쓰기 줄은 빼도 돼요. 고정과 "하지 않는 것"은 남겨요.
- 서브가 남긴 게시판 항목은 그 프로젝트 게시판에 들어가요. 메인의 목록에는 나오지 않아요.

## 도구가 막는 것

| 상황 | 도구 동작 |
|---|---|
| 서브가 `collab switch` 실행 | 거절돼요. 전환은 사용자가 메인에게 시켜요 |
| 고정된 서브의 `add`·`list`·`gaps` | 그 프로젝트 + 공통으로 고정돼요. 출력에 `pinned: true`가 붙어요 |
| `COLLAB_PROJECT`가 등록 안 된 이름 | 거절돼요. `collab project`로 이름을 다시 봐요 |
| 메인이 `COLLAB_PROJECT=<이름> collab …`으로 직접 실행 | 거절돼요. 이 스킬로 서브에 맡겨요 |

도구가 막지 못하는 것은 게시판을 거치지 않는 일이에요. 메인이 다른 프로젝트의 코드나 문서를 직접 고치지 않아요. 그 일도 서브에 맡겨요.

## 실패할 때

| 증상 | 할 일 |
|---|---|
| spawn `cap` | 끝난 서브를 닫은 뒤 다시 띄워요(pane-lead "동시 실행, 재사용, 닫기") |
| 서브 결과의 "메인에게"에 "project가 다름" | `pane-lead status`의 그 서브 `env`를 보고, `COLLAB_PROJECT`가 없으면 닫고 3번부터 다시 해요 |
| 서브가 일이 크다고 보고 | 사용자에게 전하고 전환할지 물어요 |
