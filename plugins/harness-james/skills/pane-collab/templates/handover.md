# 인계 알림 · kind `handover`

```text
[인계] <역할> 메인이 <옛 이름> → <새 이름>으로 바뀌어요 — 보낼 곳은 새 이름이에요 · <C-ID>
- 인계 문서: <경로>
- 넘긴 열린 항목: <C-ID …> (collab list --open --to <역할>)
- 진행 중: <worktree·자원·실행 중인 것>
```

- 새 이름은 ListAgents에서도 보여요. 접두어는 계보 이름이에요(기본 `impl-main-*`, `qa-main-*`, `scn-main-*`, `infra-main-*`, `pm-main-*`. 프로젝트가 바꾸거나 더한 계보는 `collab roles`의 `lineages`).
- 게시판: `collab add --from <역할> --to all --kind handover --title "<첫 줄>" --status done --link <인계 문서>`
