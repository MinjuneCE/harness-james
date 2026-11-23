---
paths:
  - "**/*.java"
---

# 코드 컨벤션: Java·Spring

Java·Spring 서버 코드에 적용한다. 공통 규칙(`conventions-common.md`)과 서버 규칙(`conventions-backend.md`)이 먼저다. 전체 내용은 `{{CONVENTIONS_DIR}}/examples/be/java-spring.md`에 있다. 개인 도구 코드는 대상이 아니다.

## 구조

- J1. 의존은 infrastructure → application → domain 방향으로만 간다.
- J2. domain은 `org.springframework..`를 import하지 않는다.
- J3. application에는 `@Service`, `@Component`, `@Transactional`을 허용한다.
- J4. `port/in` 인터페이스는 만들지 않는다. Controller와 스케줄러는 application 서비스를 직접 부른다. 구현이 둘 이상일 때만 인터페이스를 둔다.
- J5. `port/out`은 외부 API, DB, 시계 같은 진짜 경계에만 둔다.
- J6. 외부 응답 DTO는 어댑터 안(private record)에 두고 도메인 타입으로 바꿔 넘긴다.
- J7. 영속 예외와 외부 클라이언트 예외는 어댑터에서 해석한다. application은 공급자의 예외 타입을 잡지 않는다.
- J8. 테스트 클래스는 대상 클래스와 같은 패키지에 둔다.

## 값

- J9. 운영·정책 값은 `application.yml`과 `@ConfigurationProperties`로 받는다.
- J10. 기본값은 `application.yml` 한 곳에만 둔다. `@Value` 기본값, Properties 필드 초깃값, 예시 환경 파일에 나눠 두지 않는다.
- J11. 상태와 사유 코드는 enum으로 둔다. domain과 application에 `static final String` 상수를 두지 않는다. 바깥에 남는 문자열은 enum의 값 필드로 고정한다.
- J15. 설정 키, 환경 변수 이름, 예시 환경 파일은 같은 변경에서 함께 고친다.

## 테스트

- J12. domain은 Spring 없는 단위 테스트, application은 포트 자리에 메모리용 가짜, 어댑터는 `MockRestServiceServer`·`@DataJpaTest`·MockMvc로 시험한다.
- J13. 실제 외부 시스템을 부르는 테스트는 `@Tag("integration")`을 달고 기본 `test`에서 뺀다.
- J14. 테스트 안의 설명은 `assertThat(...).as("...")`에 쓴다.

## 직접 쓰지 않는 것

- B1. `Instant.now()` 같은 인자 없는 현재 시각 호출 대신 주입한 `Clock`을 쓴다. 판단 코드는 시각을 인자로 받는다.
- `Thread.sleep`으로 기다리지 않는다. 테스트에서는 `Clock`을 돌린다.
- `@Value("${...:기본값}")`의 기본값을 쓰지 않는다(J10).
