#!/usr/bin/env node
// PreToolUse(SendMessage) hook: pane-collab 설정에서 꺼진(roles의 false) 역할의 메인에게 보내는 SendMessage를 막는다.
// 꺼 둔 역할을 메시지로 깨워 토큰을 쓰지 않게 하려는 것이다. 켜고 끄기는 사용자가 정한다.
// 설정은 pane-collab 스킬과 같은 모듈(skills/pane-collab/lib/config.mjs)로 읽는다: 기본값 + <작업 공간>/.loop/collab/config.json.
// 메인 이름은 <계보>-main-N이고, 계보 → 역할은 설정의 lineages(+ 옛 이름 oldLineages)다.
// 받는 이름만 본다(뒤의 " [ref]"는 뗀다). uds 주소처럼 이름이 아닌 것은 지나가게 둔다.
// 프로젝트 설정이 없으면(기본값은 모두 켜짐) 아무것도 막지 않는다. 설정 파일이 깨졌어도 막지 않는다.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { loadConfig, offRoles, resolveRoot } from "../skills/pane-collab/lib/config.mjs";

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const to = String(input?.tool_input?.to ?? "").replace(/\s*\[[^\]]*\]\s*$/, "").trim();
if (!to) process.exit(0);

const root = resolveRoot({ cwd: input?.cwd || process.cwd() });
const config = loadConfig({ root });
if (config.error) process.exit(0);
const off = offRoles(config);
if (!off.length) process.exit(0);

const lineages = { ...config.oldLineages, ...config.lineages };
const hit = Object.entries(lineages).find(([lineage, role]) => off.includes(role) && to.startsWith(`${lineage}-main-`));
if (hit) {
  const [lineage, role] = hit;
  const where = config.file && !relative(root, config.file).startsWith("..") ? relative(root, config.file) : config.file;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `${role} 역할은 지금 꺼져 있어요(pane-collab 설정 ${where}의 roles, 사용자가 정해요). ${lineage}-main-*에게는 보내지 않아요. ` +
        `게시판 받는 쪽에서도 ${role}을 빼요. 다시 켜는 건 사용자가 정해요.`,
    },
  }));
}
