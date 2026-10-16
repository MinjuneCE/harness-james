# standard 반증 요청 틀

`verdict.mjs targets <RUN_DIR>`가 `{{…}}`를 채워 `<RUN_DIR>/refutation/prompt.md`를 쓴다. 메인 세션은 그 파일 내용을 그대로 Agent 도구 프롬프트로 넘긴다(`subagent_type`은 targets가 출력한 `AGENT=` 값 — 플러그인 설치면 `<플러그인>:design-verify-refuter` — , `model: opus` — standard는 Fable이 찾았으므로 Opus가 반증한다). 손으로 채우지 않는다.
역할·판정 값·답 형식은 에이전트 정의(`design-verify-refuter`)에 있다. 대상 finding은 붙여 넣지 않고 파일 경로로 넘긴다.

---

아래 파일의 `targets` finding을 반증해 결과 JSON을 최종 답으로 돌려줘라.

- 대상: `{{targets_path}}`의 `targets`({{n_targets}}건, 순서: {{order}}). 근거마다 `doc`(논리 경로)과 `file`(실제 파일)이 있다
- 프로파일: `{{profile}}`
- 판정 기준: framework `{{framework_path}}` · 심각도 앵커 `{{rubric_dir}}/<차원>.md`
- 추출 결과: `{{extract_dir}}/index.json` · `{{extract_dir}}/<차원>.json`
- 묶음 문서(논리 경로 → 실제 파일, 역할):
{{documents}}
