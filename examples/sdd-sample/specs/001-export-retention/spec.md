# Feature Specification: 내보낸 파일 보관과 삭제

**반영한 결정**: ~D3 ([decisions.md](decisions.md))

**Feature Branch**: `001-export-retention`

**Created**: 2026-11-20

**Status**: Draft

**Input**: User description: "내보낸 파일을 얼마 동안 두고 언제 지울지 정한다"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 내보낸 파일 다시 받기 (Priority: P1)

사용자가 전에 만든 내보내기 파일을 보관 기간 안에 다시 받는다.

**Why this priority**: 같은 파일을 다시 만들지 않게 하는 것이 이 기능의 목적이다.

**Independent Test**: 파일을 만든 뒤 보관 기간 안과 밖에서 각각 받아 본다.

**Acceptance Scenarios**:

1. **Given** 만든 지 30일이 안 된 파일, **When** 다시 받기를 누르면, **Then** 같은 파일을 받는다. (D3)
2. **Given** 만든 지 30일이 지난 파일, **When** 다시 받기를 누르면, **Then** 보관 기간이 지났다는 안내와 새로 만들기 버튼을 본다. (D3)

### Edge Cases

- 삭제 작업이 도는 동안 받고 있던 파일은 끝까지 받는다. (D2)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 시스템은 내보낸 파일을 만든 날부터 30일 동안 보관해야 한다. (D3)
- **FR-002**: 시스템은 보관 기간이 지난 파일을 하루 한 번 묶어서 지워야 한다. (D2)
- **FR-003**: 시스템은 지운 파일의 목록 줄을 남기고 "기간 지남"으로 표시해야 한다.

### Key Entities

- **내보내기 파일**: 만든 사람, 만든 시각, 상태(보관 중, 기간 지남).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 보관 기간 안의 파일은 다시 만들지 않고 받을 수 있다.
- **SC-002**: 보관 기간이 지난 파일은 다음 삭제 작업 뒤 저장소에 남아 있지 않다.

## Assumptions

- 파일 저장소와 내보내기 기능은 이미 있다.
- 지울 때 누구에게 알릴지는 아직 정하지 않았다(decisions.md의 제안 P1). [NEEDS CLARIFICATION: 알릴 곳]
