# Java·Spring 규칙

> 예시다. 프로젝트가 자기 스택 문서를 어떻게 쓰는지 보여 주는 본보기로, 설치해도 자동으로 읽히지 않는다. 켜는 방법은 `examples/README.md`에 있다.

Java와 Spring으로 쓴 서버 코드에 적용한다. `common.md`와 `be/common.md`가 먼저다. 괄호 안 번호는 이 규칙이 구체화하는 위 층의 규칙이다.

## 1. 구조

```
<기능>/
├── domain            엔터티, 값 객체, 상태 enum, 순수 판단 로직
├── application       유스케이스 구현, 밖으로 나가는 포트(port/out)
└── infrastructure    어댑터: 웹, 영속, 스케줄러, 외부 API 클라이언트, 설정
```

- **J1. 의존은 infrastructure → application → domain 방향으로만 간다(S1).** 웹 진입 층을 따로 두는 것(presentation)은 허용한다. 방향은 같다.
- **J2. domain은 `org.springframework..`를 import하지 않는다(S2).**
- **J3. application에는 Spring 스테레오타입(`@Service`, `@Component`)과 `@Transactional`을 허용한다.**
- **J4. 들어오는 쪽 인터페이스(`port/in`)는 만들지 않는다(S3).** Controller와 스케줄러는 application 서비스 클래스를 직접 부른다. 같은 유스케이스의 구현이 둘 이상 생길 때만 인터페이스를 뽑는다.
- **J5. 나가는 포트(`port/out`)는 진짜 경계에만 둔다(S3).** 대상은 외부 API, DB, 시계다.
- **J6. 외부 응답 DTO는 어댑터 안에 두고 도메인 타입으로 바꿔 넘긴다(S5).** 어댑터 안의 private record로 두면 밖으로 새지 않는다.
- **J7. 영속 예외와 외부 클라이언트 예외는 어댑터에서 해석한다(S5).** `DataIntegrityViolationException`이나 HTTP 클라이언트 예외를 우리 결과나 우리 예외로 바꾸는 일은 어댑터가 맡는다. application은 공급자의 예외 타입을 잡지 않는다.
- **J8. 테스트 클래스는 대상 클래스와 같은 패키지에 둔다.**

## 2. 값

- **J9. 운영·정책 값은 `application.yml`과 `@ConfigurationProperties`로 받는다(V1).** 없으면 안 되는 값은 시작할 때 검증해서, 값이 없거나 틀리면 앱이 뜨지 않게 한다.
- **J10. 기본값은 `application.yml` 한 곳에만 둔다(V2).** `@Value("${...:기본값}")`, Properties 클래스의 필드 초깃값, 예시 환경 파일에 같은 기본값을 나눠 두지 않는다.
- **J11. 상태와 사유 코드는 enum으로 둔다(V3).** domain과 application에 `static final String` 상수를 두지 않는다. 바깥에 남는 문자열(DB 값, 응답 값, 메트릭 태그 값)은 enum의 값 필드로 고정한다(V5).
- **J15. 설정 키, 환경 변수 이름, 예시 환경 파일은 같은 변경에서 함께 고친다(S6).**

## 3. 테스트

- **J12. 테스트 층은 셋이다(T4).**
  - domain: Spring 없이 도는 단위 테스트. 상태 전이와 판단 규칙을 여기서 확인한다.
  - application: 포트 자리에 메모리용 가짜 구현을 쓴다. Mockito 목은 외부 경계 포트에만 쓴다.
  - 어댑터: 외부 HTTP는 `MockRestServiceServer`, 영속은 `@DataJpaTest`와 Testcontainers, 웹은 MockMvc로 요청과 응답 계약을 확인한다.
- **J13. 실제 외부 시스템을 부르는 테스트에는 `@Tag("integration")`을 달고 별도 Gradle 태스크에서만 돌린다(T5).** 기본 `test` 태스크에서는 뺀다.
- **J14. 테스트 안의 설명은 `assertThat(...).as("...")`에 쓴다(T6).**

## 4. 자동 검사

ArchUnit 테스트로 강제한다. 기존 위반은 `FreezingArchRule` 기준선에 묶어, 새로 늘 때만 실패하게 한다.

| 규칙 | 지키는 것 |
|---|---|
| domain → application·infrastructure 의존 금지 | J1 |
| application → infrastructure 의존 금지 | J1 |
| domain → `org.springframework..` 의존 금지 | J2 |
| `..application.port.in..` 패키지 금지. 구현이 둘 이상이면 예외 목록에 올린다 | J4 |
| domain·application에 `static final String` 상수 금지 | J11 |

- 패키지 이름이 프로젝트마다 다른 규칙(웹 어댑터가 다른 어댑터에 직접 의존하지 않기 등)은 프로젝트가 패키지 이름을 넣어 쓴다.
- `static final String` 검사는 `Set<String>` 상수와 인라인 문자열 리터럴을 잡지 못한다. V4는 리뷰에서도 본다.
- 테스트 먼저(T1, T2)는 ArchUnit으로 막을 수 없다. 커밋 이력에서 테스트 커밋이 구현 커밋보다 앞서는지로 확인한다.

## 5. 직접 쓰지 않는 것 (S9)

| 직접 쓰지 않는 것 | 대신 쓸 것 | 규칙 | 검사 |
|---|---|---|---|
| `Instant.now()`, `LocalDateTime.now()` 같은 인자 없는 현재 시각 호출 | 주입한 `Clock` | B1 | 없음 |
| `Thread.sleep` | 순서를 보장하는 구조. 테스트에서는 `Clock`을 돌린다 | S10 | 없음 |
| `@Value("${...:기본값}")`의 기본값 | `application.yml`과 `@ConfigurationProperties` | J10 | 없음 |
| domain·application의 `static final String` 상태 상수 | enum | J11 | ArchUnit |
| application에서 공급자 예외 타입을 catch | 어댑터가 해석해서 넘긴 우리 결과나 우리 예외 | J7 | 없음 |

## 프로젝트가 정하는 것

- domain 엔터티에 JPA 어노테이션을 허용할지
- `@ConfigurationProperties` 등록 방식(앱의 `@ConfigurationPropertiesScan` 하나, 또는 설정 클래스마다 `@EnableConfigurationProperties`)과 검증 방식(`@Validated`, 또는 record 생성자)
- 웹 슬라이스 테스트 도구(`@WebMvcTest`, 또는 `@SpringBootTest`와 `@AutoConfigureMockMvc`)
- 로그 문구의 언어
- Lombok을 쓸지
