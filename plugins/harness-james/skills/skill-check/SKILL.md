---
name: skill-check
description: 스킬 검증·점검 도구(skill check). 스킬 디렉터리 하나의 SKILL.md, frontmatter, 스크립트, 참조 문서를 규칙 검사와 루브릭 판정으로 품질 채점해 S~F 등급과 항목별 고칠 점을 보고한다. 스킬을 새로 만들거나 SKILL.md·description을 고친 뒤 제대로 로드되고 불리는지 확인할 때, 또는 사용자가 스킬 검증, 스킬 점검, 스킬 품질 채점, skill lint를 요청할 때 쓴다. 스킬을 직접 쓰거나 고치거나 description을 최적화하지 않고, eval 실행이나 트리거 정확도 측정도 하지 않는다(그건 skill-creator 몫).
argument-hint: "<스킬 디렉터리> [--as user|project]"
context: fork
agent: harness-james:skill-check-judge
background: false
model: claude-opus-5-5
effort: max
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/bin/skill-check.mjs rules --args-stdin) Read(/${CLAUDE_SKILL_DIR}/**) Read(~/.claude/skills/**) Read(~/.claude/agents/**) Read(~/.claude/plugins/**)
---

# skill-check

스킬 하나를 1단계 규칙 검사와 2단계 루브릭 판정으로 채점해, 등급과 고칠 점을 돌려준다.

## 1단계 규칙 검사 결과

```!
node ${CLAUDE_SKILL_DIR}/bin/skill-check.mjs rules --args-stdin <<'SKILL_CHECK_ARGS'
${CLAUDE_PROJECT_DIR}
$ARGUMENTS
SKILL_CHECK_ARGS
```

## 판정 과제

- 대상은 위 JSON의 `target.dir`에 있는 스킬이다.
- 판정 기준은 `${CLAUDE_SKILL_DIR}/references/rubric.md`다. 판정을 시작하기 전에 읽는다. 1단계에 BLOCKER가 있으면 7장(등급)과 8장(출력 형식)만 보면 된다.
- 출력은 rubric.md 8장 형식을 따른다. 첫 줄에 이름, 유형, 등급, 결함 수, 사용량을 쓰고, 그 아래에 심각도 순으로 '왜'와 '고칠 점'을 쓴다.
- 인자는 프로젝트 경로와 함께 위 명령에 stdin으로만 전달된다. 셸이 해석하지 않으므로 `;`, `$(…)`, 백틱이 있어도 실행되지 않는다.
- 인자는 셸식 따옴표로만 나눈다. 공백이 든 경로는 따옴표로 감싼다(예: `~/"my skills"/a`, `'/abs/my skills/a'`). `~`는 따옴표 밖에 있어야 홈으로 바뀐다. 따옴표 없는 공백은 인자를 둘로 나눠 오류가 나고, 짝이 없는 따옴표도 오류다.

## 유지보수 메모

- 런타임: Node 18 이상. 외부 패키지 의존성은 없다(`package.json`).
- 외부 CLI는 모두 선택이다. 없어도 1단계는 끝까지 돈다.
  - `claude`: S1(`claude plugin validate`)과 버전 확인에 쓴다. 없으면 S1이 error가 된다.
  - `gitleaks`: X1에 쓴다(8.30.1에서 확인). 없거나 실패하면 정규식 검사로 대신하고 notes에 남긴다.
  - `python3`·`bash`: 대상에 .py·.sh 파일이 있을 때 R6 문법 검사에 쓴다.
- 남은 위험: 인자 안에 종료어 `SKILL_CHECK_ARGS`만 있는 줄이 들어오면 heredoc이 일찍 끝나 다음 줄이 명령으로 실행될 수 있다. default·dontAsk 모드에서는 allowed-tools 밖이라 막히고, auto 모드에서는 모델이 실행하지 않는다. bypassPermissions 모드에서만 실행된다(설계 문서 4장).
- allowed-tools의 `Read(/${CLAUDE_SKILL_DIR}/**)`는 판정 에이전트가 이 스킬의 `references/rubric.md`를 확인 창 없이 읽게 한다. 설치 경로는 작업 폴더 밖이고 버전마다 바뀐다. 앞의 `/`는 빼지 않는다. 치환된 절대 경로가 `//…` 형태가 되어야 절대 경로 규칙이 되고, 없으면 프로젝트 기준 상대 경로로 읽혀 막힌다(2.1.301, -p 탐침으로 확인).
- 판정 에이전트는 같은 플러그인의 `agents/skill-check-judge.md`이고, 플러그인 이름을 붙여 `harness-james:skill-check-judge`로 부른다. 짧은 이름 `skill-check-judge`는 플러그인 에이전트를 찾지 못하고 경고 없이 다른 에이전트로 fork된다(2.1.301에서 확인).
- 1단계만 따로 실행: `node ${CLAUDE_SKILL_DIR}/bin/skill-check.mjs rules <스킬 디렉터리>`. 결과 JSON은 `~/.claude/skill-check/runs/`에도 남는다.
- 테스트: 스킬 디렉터리에서 `node --test test/`. 실행 기록이 홈에 남지 않게 `SKILL_CHECK_RUNS_DIR`를 임시 디렉터리로 준다.
- `--eval`(3단계 동작 테스트)은 1단계 JSON에 `evalRequested: true`로만 남는다. 3단계 판정은 이 스킬에 들어 있지 않다.
