---
name: install
description: 코드 컨벤션 문서와 요약을 이 맥의 Claude 설정 폴더(conventions/, rules/)에 깔거나, 깔린 것이 플러그인 버전과 같은지 보거나, 걷어 낸다. 사용자가 직접 부른다.
argument-hint: "[check|uninstall] [--force]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/install.mjs:*)
---

# code-conventions 설치

이번 호출: `$ARGUMENTS`

아래 명령을 한 번 실행하고, 출력을 그대로 사용자에게 보여 준다.

```sh
node ${CLAUDE_PLUGIN_ROOT}/scripts/install.mjs $ARGUMENTS
```

- 인자가 없으면 설치(또는 갱신), `check`는 비교만, `uninstall`은 이 스크립트가 깐 파일만 지운다.
- 설치 위치는 `CLAUDE_CONFIG_DIR`이 있으면 그 폴더, 없으면 `~/.claude`다.
- 이 스크립트가 깔지 않은 파일이나 깐 뒤 손으로 고친 파일이 같은 자리에 있으면 덮어쓰지 않고 멈춘다. 출력에 그 파일 목록이 나온다. 덮어쓸지는 사용자가 정한다(`--force`).
- 요약은 다음 세션부터 읽힌다.
