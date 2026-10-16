// /verify 에이전트 목록: verify-guard.mjs가 훅 입력의 agent_type으로 가드 대상과 하위 에이전트 허용 목록을 정한다.
// 플러그인 에이전트의 agent_type은 "<플러그인>:<name>"(예: harness-james:verify-judge)이고, Agent 도구의 subagent_type도 같은 이름을 써야 한다.
// 프로젝트·사용자 수준에 복사한 에이전트는 접두어 없이 name 그대로 온다. 두 경우 모두 가드한다.
export const VERIFY_AGENTS = ["verify-orchestrator", "verify-judge", "verify-refuter", "verify-explorer"];

// 각 에이전트가 Agent 도구로 띄울 수 있는 에이전트. 에이전트 정의 본문의 역할 경계와 같게 둔다
export const CHILDREN = {
  "verify-orchestrator": ["verify-judge", "verify-refuter", "verify-explorer"],
  "verify-judge": ["verify-explorer"],
  "verify-refuter": ["verify-explorer"],
  "verify-explorer": [],
};

// agent_type → { prefix, role } (가드 대상이 아니면 null). prefix는 "harness-james:"처럼 콜론까지 포함하거나 빈 문자열
export function verifyRole(agentType) {
  if (typeof agentType !== "string") return null;
  const m = /^((?:[^:]+:)*)(verify-(?:orchestrator|judge|refuter|explorer))$/.exec(agentType);
  return m ? { prefix: m[1], role: m[2] } : null;
}

// 이 에이전트가 띄울 수 있는 subagent_type. 자기와 같은 접두어(같은 플러그인)의 이름만 허용한다
export const allowedChildren = ({ prefix, role }) => CHILDREN[role].map((n) => prefix + n);
