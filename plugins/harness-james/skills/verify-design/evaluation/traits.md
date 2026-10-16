# 설계 traits

- 버전: 0.1.0 (2026-10-16)
- 쓰임: 프로파일 `design.traits`가 켠다. rubric 기준의 "적용"이 trait를 적으면 그 trait가 켜졌을 때만 기준을 적용한다. `공통` 기준은 항상 적용한다.
- 원칙: trait는 도메인이 아니라 **설계의 모양**이다. 예약·결제·배치·정적 사이트 모두 같은 trait 목록으로 표현한다.

## 1. 정의

| trait | 뜻 | 주로 켜는 기준 |
|---|---|---|
| `multi-doc` | 설계가 여러 문서로 나뉨(명세·계획·데이터 모델·계약·작업·시나리오·결정 기록 등) | CON 전부, TRC-02·05, DEC-04, BND-01~04 |
| `state-machine` | 엔터티가 이름 붙은 상태와 전이를 가짐 | CON-04, BEH-01~03·08, FLR-05 |
| `external-integration` | 우리가 통제하지 않는 시스템을 호출하거나 그 이벤트를 받음 | EVD-02, FLR-01~03, BEH-05, QAS-02 |
| `async-events` | 큐·웹훅·스케줄러 등 비동기 트리거가 있음 | BEH-03~05, FLR-03, RUN-04 |
| `concurrent-actors` | 같은 데이터를 둘 이상의 작업자·요청·프로세스가 바꿀 수 있음 | BEH-04 |
| `irreversible-effects` | 되돌릴 수 없는 외부 부작용(돈 이동·발송·삭제·통지)이 있음 | DEC-03, FLR-02, BEH-07 |
| `persistent-data` | 상태를 저장함 | CON-03, BEH-02·06·07·08 |
| `data-migration` | 기존 데이터·스키마·계약을 바꿈 | DEC-03, RUN-02 |
| `user-facing` | 최종 사용자 화면·문구가 있음 | REQ-04·05 체크포인트 |
| `trust-boundary` | 신뢰하지 않는 입력·주체가 경계를 넘음 | THR 전부 |
| `automation` | 사람 개입 없이 대량으로 도는 작업·도구가 있음 | BEH-06, FLR-05, RUN-03 |
| `agent-authored` | 문서를 AI 에이전트가 여러 세션에 걸쳐 쓰고 고쳤음 | DEC-04, EVD-02, BND-01·02·05·06 |

## 2. 문서에서 trait를 알아보는 범용 단서

프로파일 작성자가 trait를 켤 때 쓰는 단서다. 단서가 하나라도 뚜렷하면 켜는 쪽이 기본이다. 잘못 켜면 기준 몇 개가 "해당 없음"으로 끝나지만, 잘못 끄면 결함 범주 하나가 통째로 빠진다.

| trait | 단서 |
|---|---|
| `multi-doc` | 묶음에 문서가 둘 이상이고 서로 링크·ID로 참조한다. 같은 표(상태표·설정값)가 여러 문서에 나온다 |
| `state-machine` | 대문자 상태 이름 목록, 상태 전이 표·다이어그램, "~ 상태에서 ~ 상태로", 종결 상태(완료·실패·거절) 언급 |
| `external-integration` | 외부 API 호출 목록, 웹훅·이벤트 구독, 외부 문서 링크, "상대 시스템이 ~한다"는 문장, 외부 담당자 확인 항목 |
| `async-events` | 큐, 웹훅, 이벤트, 스케줄러·주기 작업, 재시도, "나중에·주기적으로", 지연 도착 |
| `concurrent-actors` | 같은 레코드를 사용자 요청·스케줄러·웹훅·운영자가 모두 건드림, 잠금·유일성 제약·조건부 갱신 언급 |
| `irreversible-effects` | 돈 이동(결제·환불·취소), 메일·메시지 발송, 외부 삭제, 출고·배송 지시, 되돌림 불가 표현 |
| `persistent-data` | 테이블·열·스키마·마이그레이션, 저장 필드 목록, 보존 기간 |
| `data-migration` | 스키마 변경, 기존 레코드 변환, 계약 버전 변경, "기존 데이터는", 옛/새 공존 |
| `user-facing` | 화면 문구, 다국어 문자열, 사용자 안내·오류 메시지, 화면 상태 |
| `trust-boundary` | 외부 사용자·브라우저·제3자가 보내는 입력, 인증·인가, 서명 검증, 공개 엔드포인트 |
| `automation` | 일괄 처리, 정리·만료 작업, 자동 재처리, 사람 확인 없이 도는 스크립트·도구 |
| `agent-authored` | 문서 머리의 "요약(메인 세션용)", pane·세션 이름, 지시서 참조, 여러 버전의 변경 기록, "(해석)·(추정)" 표지 |

## 3. 켜는 예 (범용성 시험)

| 설계 모양 | 켜질 traits |
|---|---|
| 이벤트 기반 상태 처리 + 외부 부작용 + 여러 문서 | multi-doc, state-machine, external-integration, async-events, concurrent-actors, irreversible-effects, persistent-data, agent-authored |
| 예약 시스템 | state-machine, concurrent-actors, irreversible-effects, persistent-data, user-facing |
| 배치 ETL | automation, data-migration, async-events, persistent-data |
| 정적 사이트 개편 | user-facing (multi-doc는 문서가 여럿일 때만) |
| 단일 문서 요구 명세 | 공통 기준만 |
