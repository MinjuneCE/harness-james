# standard 판정 요청 틀

`verdict.mjs judge-prompt <RUN_DIR>`가 `{{…}}`를 채워 `<RUN_DIR>/judge-prompt.md`를 쓴다. 메인 세션은 그 파일 내용을 그대로 Agent 도구 프롬프트로 넘긴다(`subagent_type`은 judge-prompt가 출력한 `AGENT=` 값 — 플러그인 설치면 `<플러그인>:design-verify-judge` — , `model: fable`). 손으로 채우지 않는다.
역할·규칙·답 형식·출력 요건은 에이전트 정의(`design-verify-judge`)에 있다. 여기에는 이번 실행의 입력만 적는다. 판정 순서·읽는 방법은 정하지 않는다.

---

level: standard. 아래 적용 기준 전부를 판정하고, 결과 JSON을 최종 답으로 돌려줘라.

- 프로파일: `{{profile}}`
- 판정 기준: framework `{{framework_path}}` · 기준 본문 `{{rubric_dir}}/<차원>.md` · traits `{{traits_path}}`
- 적용 기준({{n_criteria}}개, 범위·방법): {{criteria}}
- 추출 결과: `{{extract_dir}}/index.json`(요약 색인: 문서·기준 상태·기준별 후보 수·차원 파일 목록·`obligated_candidates`) · 차원 파일 `{{extract_dir}}/<차원>.json`(정본 쪽 후보) · 입력 문서에만 있는 후보 목록 `{{extract_dir}}/<차원>.input.json`
- light 구체 후보(처리 목록, {{n_obligated}}건): `{{extract_dir}}/index.json`의 `obligated_candidates`. 출력의 `candidate_dispositions`에 후보마다 채택 또는 기각을 적는다
- S 단독 finding(REQ-02, 심각도 참고값): `{{extract_dir}}/REQ.json`의 `script_findings`. 핵심 흐름인지 판단해 같은 위치로 finding을 다시 내거나, 자리표시가 아니면 올리지 않는다
- 묶음 문서(논리 경로 → 실제 파일, 역할, 큰 문서 표시):
{{documents}}
{{incremental}}
