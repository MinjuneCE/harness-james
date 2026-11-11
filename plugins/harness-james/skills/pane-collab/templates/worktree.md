# worktree 수정 예고·끝남 · kind `worktree`

시작:

```text
[worktree 시작] <worktree 폴더> (<브랜치> @ <HEAD>)를 지금부터 <쪽>이 고쳐요 — <무엇을> · <C-ID>
- 범위: <파일·모듈>
- 끝 예상: <시각 또는 조건>
- 그동안 상대 쪽: 이 worktree를 읽기만 해 주세요
```

끝:

```text
[worktree 끝] <worktree 폴더> 수정 끝 — 새 HEAD <해시>, 이제 고쳐도 돼요 · <같은 C-ID>
- 커밋: <해시 제목> …
- 시험: <결과>
```

- 같은 worktree는 한 번에 한 쪽만 고쳐요. 시작 알림이 열려 있으면 그쪽이 고치는 중이에요. 누가 어느 worktree를 고치는지는 프로젝트 안내의 worktree 표에 있어요.
- 게시판: 시작 때 `collab add … --kind worktree --status doing --link <worktree 폴더>`, 끝날 때 `collab update <C-ID> --status done --note "HEAD <해시>"`
