# Plan (v0.2)

## 설정

```yaml
retry.max-wait: PT5M
poll.interval: PT10M
```

- 대기 상한은 최대 15분이다. 상세는 [데이터 모델](data-model.md#없는-절)과 [규칙](notes/rules.md#규칙-요약).
- 규칙 4를 따른다. 규칙 2도 본다.
- 아직 OLD_WAIT 경로가 남아 있다.
- legacyFlush는 v0.1에서 삭제했다.
- PENDING_WAIT 상태로 둔다.
- 기준 코드 def5678 기준이다.
- REQ-001, REQ-002를 구현한다. TK01 참고. SC-A-02 시나리오.
- VendorAPI가 서명을 붙여 보낸다.
- Vendor 응답 형식은 미확인이다(담당: 개발).

## 상태

- WAITING → COMPLETED
- WAITING → CANCELED

| 위협 | 대응 |
|---|---|
| 위조 요청 | 서명 검증 |

## 요약 인용

- 요약 2를 따른다. 요약 9도 본다.
