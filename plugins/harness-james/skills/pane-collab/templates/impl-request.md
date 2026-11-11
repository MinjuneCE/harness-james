# 구현 요청 (→ impl) · kind `impl-request`

```text
[구현 요청] <무엇을 바꿔 달라는지 한 문장> · <C-ID>
- 근거: <티켓 ID / 사용자 결정 ID·기록 위치 / 판정 기준 줄>
- 대상: <worktree·브랜치> @ <지금 HEAD>
- 끝난 모습: <확인할 동작 또는 완료 조건>
- 시험: <단위 시험 기대, 통합·수동 확인 여부>
- 크기 추정: <작음 / 큼(PR 전 검증 대상)>
```

- impl은 구현 → 시험 → 큰 작업이면 PR 전 검증(예: `/harness-james:pr-verify`)을 거쳐 `retest-request`로 돌려줘요. 검증이 오래 걸리면 그동안 `note`로 남겨요.
- 게시판 상태: 받으면 `doing`, 구현·시험이 끝나면 `doing` + "재시험 대기 <HEAD>", push가 사용자 승인을 기다리면 `blocked` "push 승인 대기", qa 재시험이 PASS면 impl이 `done`. FAIL이면 `doing`으로 두거나 새 `defect`로 받아요.
- 게시판: `collab add --from <보낸 쪽> --to impl --kind impl-request --title "<첫 줄>" --link <티켓 ID>`
