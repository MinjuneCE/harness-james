---
paths:
  - "**/extensions/**/*.js"
  - "**/extensions/**/*.jsx"
  - "**/extensions/**/*.mjs"
  - "**/extensions/**/*.ts"
  - "**/extensions/**/*.tsx"
---

# 코드 컨벤션: Shopify UI 확장

Shopify UI 확장(Preact, JS) 코드에 적용한다. 공통 규칙(`conventions-common.md`)과 화면 코드 규칙(`conventions-frontend.md`)이 먼저다. 전체 내용은 `{{CONVENTIONS_DIR}}/examples/fe/shopify-ui-extension.md`에 있다.

## 확장

- E1. 의존은 진입점 jsx·components·hooks → services → utils → config 방향으로만 간다.
- E2. 분기 로직은 jsx와 hook 밖의 utils에 둔다.
- E3. 닫힌 값 목록은 상수 객체 한곳에 두고 JSDoc union으로 타입을 단다. 빠뜨린 값은 목록 전체를 도는 테스트로 잡는다.
- E4. 빌드 때 치환되는 환경 값은 config 한곳에서 읽고, 없으면 기능을 끈다.
- E5. 운영자 설정(toml settings)과 코드의 키, 번역 파일의 언어별 키와 자리표시자는 테스트로 묶는다.
- E7. 편집기(운영자 미리보기)에서는 서버를 부르지 않고 고른 상태만 그린다. 편집기인지 판단하는 함수는 하나만 둔다.
- E8. 테스트는 `node:test`로 utils와 services를 대상으로 쓴다.
- E9. 템플릿이 만든 앱 서버 코드는 고치지 않는다.

## 직접 쓰지 않는 것

- `useEffect`는 `hooks/` 안에서만 쓴다. jsx와 components에서는 이름 붙은 hook을 쓴다.
- `fetch`는 `services/` 안에서만 쓴다.
- `process.env`는 `config/` 안에서만 읽는다.
- `setTimeout`, `setInterval`은 제한 시간(services의 클라이언트 한곳)과 폴링·대기 표시(이름 붙은 hook)에만 쓴다.
