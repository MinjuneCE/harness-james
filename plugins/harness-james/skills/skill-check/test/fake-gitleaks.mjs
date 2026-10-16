#!/usr/bin/env node
// 테스트용 가짜 gitleaks. SKILL_CHECK_GITLEAKS로 이 파일을 가리키고 FAKE_GITLEAKS_MODE로 동작을 고른다.
//   exit2: stderr에 오류를 쓰고 종료 코드 2 · empty: 아무것도 쓰지 않고 0 · badjson: JSON이 아닌 출력
//   notarray: JSON 객체 · sleep: 오래 멈춤(시간 초과용) · ok-empty: 정상, 발견 없음("[]")
const mode = process.env.FAKE_GITLEAKS_MODE || 'ok-empty';
if (process.argv[2] === 'version') {
  process.stdout.write('8.30.1\n');
} else if (mode === 'exit2') {
  process.stderr.write('fake: config error\n');
  process.exitCode = 2;
} else if (mode === 'empty') {
  // 출력 없음
} else if (mode === 'badjson') {
  process.stdout.write('[{"RuleID": "x",\n');
} else if (mode === 'notarray') {
  process.stdout.write('{"findings": []}\n');
} else if (mode === 'sleep') {
  setTimeout(() => process.stdout.write('[]\n'), 20000);
} else {
  process.stdout.write('[]\n');
}
