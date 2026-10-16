// 스킬 스펙 상수를 한 곳에 모은다.
// 기준: Claude Code CLI 2.1.301, 공식 문서 code.claude.com/docs/en/skills·model-config·sub-agents (2026-10-16 확인).
// CLI가 올라가면 이 파일을 먼저 갱신한다.

export const TOOL_VERSION = '0.2.1';
export const RUBRIC_VERSION = '0.2';
export const SPEC_CLI_VERSION = '2.1.301';

// frontmatter 키 표 (skills 문서의 Frontmatter reference)
export const KNOWN_KEYS = [
  'name', 'description', 'when_to_use', 'argument-hint', 'arguments',
  'disable-model-invocation', 'user-invocable', 'allowed-tools', 'disallowed-tools',
  'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell',
  'metadata', 'license', 'compatibility',
];

// 오타가 나면 호출·권한이 조용히 풀리는 키 (S7 BLOCKER)
export const INVOCATION_KEYS = new Set([
  'disable-model-invocation', 'user-invocable', 'allowed-tools', 'disallowed-tools',
  'context', 'agent', 'model', 'effort', 'paths', 'hooks',
]);

export const BOOL_KEYS = ['disable-model-invocation', 'user-invocable', 'background'];
export const BOOL_STRINGS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', '1', '0']);
export const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'];
export const CONTEXT_VALUES = ['fork'];
export const SHELL_VALUES = ['bash', 'powershell'];

// model-config 문서의 별칭 표 + skills 문서의 inherit. 이 밖에는 claude- 로 시작하는 전체 id를 받는다.
export const MODEL_ALIASES = [
  'default', 'best', 'fable', 'sonnet', 'opus', 'haiku',
  'sonnet[1m]', 'opus[1m]', 'opusplan', 'opusplan[1m]', 'inherit',
];
export const MODEL_ID_RE = /^claude-[a-z0-9.-]+(\[1m\])?$/;

// sub-agents 문서의 내장 서브에이전트 타입
export const BUILTIN_AGENTS = ['Explore', 'Plan', 'general-purpose', 'claude', 'statusline-setup', 'claude-code-guide'];

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024; // Agent Skills 스펙 한도
export const LISTING_CAP = 1536; // Claude Code가 목록에서 description+when_to_use를 자르는 길이

// T7 기준값. 목록 예산은 컨텍스트의 1%이고 스킬마다 매 턴 상주한다.
// 1,536자 상한의 1/3 정도면 기능과 사용 시점을 담기에 충분하다고 보고 500자로 시작한다(보정 단계에서 조정).
export const LISTING_SOFT_LIMIT = 500;

export const BODY_MAX_LINES = 500;
export const DOC_TOC_MIN_LINES = 100;
export const TOC_SCAN_LINES = 30;

export const RESERVED_NAMES = ['anthropic-skills', 'synced'];

// 결과 크기 제한
export const TEXT_CLIP = 300;
export const OUTPUT_MAX_BYTES = 30 * 1024;
export const MAX_FINDINGS_PER_RULE = 20;

export const RULE_IDS = [
  'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12',
  'T6', 'T7', 'C3', 'R3', 'R4', 'R6', 'R7', 'R8', 'R9', 'R11', 'X1', 'X2', 'X5',
];

// 제목은 '통과 조건'을 묻는 질문형이다. fail이면 "아니요"로 읽힌다(결함 이름으로 쓰면 fail이 거꾸로 읽힌다).
export const RULE_TITLES = {
  S1: 'frontmatter가 파싱되는가', S2: '이름 형식이 맞는가', S3: 'name과 폴더명이 같은가', S4: 'description이 있는가',
  S5: 'description 길이가 한도 안인가', S6: '설명에 XML 태그가 없는가', S7: '오타 키가 없는가', S8: '모르는 키가 없는가',
  S9: '예약어 이름을 피했는가', S10: '값이 유효한가', S11: 'fork 에이전트가 있는가', S12: '루트에 README가 없는가',
  T6: '인자를 쓰면 argument-hint가 있는가', T7: '상주 비용이 기준 안인가', C3: '본문이 500줄 이하인가', R3: '참조 깊이가 한 단계인가',
  R4: '긴 문서에 목차가 있는가', R6: '스크립트 문법이 맞는가', R7: '진입점이 SKILL.md에 나오는가', R8: '미완성 표시가 없는가',
  R9: '테스트가 있는가', R11: '경로를 박아 두지 않았는가', X1: '평문 비밀값이 없는가', X2: 'allowed-tools에 위험 명령이 없는가',
  X5: '인자를 따옴표 없이 셸에 넣지 않는가',
};

export const CODE_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.mts', '.cts', '.py', '.sh', '.bash', '.zsh', '.rb', '.pl', '.java', '.go', '.rs', '.kt']);
export const SKIP_DIRS = new Set(['node_modules', '.git', '.playwright', '.playwright-mcp', '__pycache__', '.venv', 'venv', '.cache']);
