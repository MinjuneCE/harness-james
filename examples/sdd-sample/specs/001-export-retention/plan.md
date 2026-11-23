# Implementation Plan: 내보낸 파일 보관과 삭제

**반영한 결정**: ~D3 ([decisions.md](decisions.md))

**Branch**: `001-export-retention` | **Date**: 2026-11-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-export-retention/spec.md`

## Summary

내보낸 파일에 만든 시각을 남기고, 하루 한 번 도는 삭제 작업이 보관 기간이 지난 파일을 지운다.

## Technical Context

**Language/Version**: Node.js 20

**Primary Dependencies**: 없음(표준 라이브러리)

**Storage**: 파일 저장소와 목록 테이블

**Testing**: node:test

**Project Type**: web-service

**Constraints**: 삭제 작업은 받고 있는 파일을 건드리지 않는다

## Constitution Check

이 예시는 constitution을 채우지 않았다(`.specify/memory/constitution.md`는 템플릿 그대로). 점검할 원칙이 없다.

## 판정

1. 보관 기간은 설정값 `EXPORT_RETENTION_DAYS`로 두고 기본값은 30이다. (D3)
2. 삭제 작업은 하루 한 번 돌고, 기간이 지난 파일을 묶어서 지운다. (D2)
3. 지운 뒤 알림은 보내지 않는다. 알릴 곳이 정해지면 더한다(decisions.md의 제안 P1).

## Project Structure

```text
specs/001-export-retention/
├── spec.md
├── plan.md
└── decisions.md
```

## Complexity Tracking

없음.
