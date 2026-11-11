// pane-collab 설정: 기본값(이 파일) + 프로젝트 설정 파일 <작업 공간>/.loop/collab/config.json(있을 때만).
// 플러그인 폴더는 설치 캐시라(읽기 전용, 버전마다 경로가 바뀜) 프로젝트마다 다른 값은 게시판 옆에 둔다.
// CLI(bin/collab.mjs), 어긋남 계산(lib/gaps.mjs), 훅(hooks/role-switch-guard.mjs)이 모두 이 모듈로 같은 설정을 읽는다.
//
// 프로젝트 설정 모양(모두 선택, 기본값 위에 덧씌운다. "_"로 시작하는 키는 설명으로 보고 건너뛴다):
//   roles         { "<역할>": true|false }       역할 더하기·켜고 끄기. false인 역할은 add --to에 못 넣고 그 메인에게 SendMessage가 막힌다
//   lineages      { "<계보>": "<역할>" }          pane-lead 계보(세션 <계보>-main-N, 등록부 .research/pane-lead/<계보>/) → 역할
//   oldLineages   { "<옛 계보>": "<역할>" }        이름을 바꾼 계보. 훅만 같이 본다(등록부는 읽지 않는다)
//   roleAliases   { "<옛 역할 이름>": "<역할>" }    게시판이 들어오는 이름과 옛 줄을 지금 이름으로 읽는다
//   ownerAliases  { "<글 속 이름>": "<주인>" }      티켓 route·"<이름> 몫" 글 → 주인. 역할·계보·별칭 이름은 저절로 들어간다
//   gaps          { staleHours, rules: { G1…G9 }, listMax, mdMaxLines, tickets, g8Owners }
//
// 파일이 없으면 기본값이다. 깨졌으면(JSON 오류, 객체가 아님) 기본값을 쓰고 error에 이유를 남긴다.
// 타입이 맞지 않는 항목은 건너뛰고 ignored에 적는다. 훅은 error가 있으면 아무것도 막지 않는다.
import fs from "node:fs";
import path from "node:path";

export const BOARD_REL = ".loop/collab/board.jsonl";
export const CONFIG_REL = ".loop/collab/config.json";

export const DEFAULTS = Object.freeze({
  roles: { impl: true, qa: true, scenarios: true, infra: true, pm: true },
  lineages: { impl: "impl", qa: "qa", scn: "scenarios", infra: "infra", pm: "pm" },
  oldLineages: {},
  roleAliases: {},
  ownerAliases: {},
  gaps: {
    staleHours: 24,
    rules: { G1: true, G2: true, G3: true, G4: true, G5: true, G6: true, G7: false, G8: false, G9: false },
    listMax: 8,
    mdMaxLines: 40,
    // 티켓 장부 폴더(작업 공간 기준). 폴더가 없으면 티켓 규칙은 조용히 건너뛴다. false면 끈다.
    tickets: ".loop/tickets",
    // G8(열린 티켓을 가리키는 게시판 항목이 없음)을 볼 티켓 주인
    g8Owners: ["impl", "scenarios"],
  },
});

const RESERVED = new Set(["user", "all"]);
const ROLE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LINEAGE_RE = /^[a-z][a-z0-9]{0,11}$/; // pane-lead 접두어와 같은 규칙
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 작업 공간 뿌리: --root > COLLAB_ROOT > PANE_LEAD_ROOT(pane-lead 메인) > CLAUDE_PROJECT_DIR(훅)
 * > cwd에서 위로 올라가며 처음 만나는 .loop/collab이 있는 폴더 > cwd.
 */
export function resolveRoot({ root, env = process.env, cwd = process.cwd() } = {}) {
  const given = root || env.COLLAB_ROOT || env.PANE_LEAD_ROOT || env.CLAUDE_PROJECT_DIR;
  if (given) return path.resolve(given);
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".loop", "collab"))) return d;
    if (path.dirname(d) === d) return path.resolve(cwd);
  }
}

export const configPath = ({ root, env = process.env } = {}) => env.COLLAB_CONFIG || (root ? path.join(root, CONFIG_REL) : null);

/** 기본값 + 프로젝트 설정. { roles, lineages, oldLineages, roleAliases, ownerAliases, gaps, file, exists, error?, ignored? } */
export function loadConfig({ root, file, env = process.env } = {}) {
  const where = file ?? configPath({ root, env });
  let raw = null;
  let error;
  if (where) {
    try {
      raw = JSON.parse(fs.readFileSync(where, "utf8"));
      if (!isObj(raw)) throw new Error("not a JSON object");
    } catch (e) {
      if (e?.code !== "ENOENT") error = String(e?.message ?? e).slice(0, 160);
      raw = null;
    }
  }
  return { ...merge(raw), file: where, exists: raw !== null, ...(error ? { error } : {}) };
}

/** 기본값 위에 프로젝트 값을 덧씌운다. 타입이 맞지 않는 항목은 ignored에 남기고 건너뛴다. */
export function merge(raw) {
  const ignored = [];
  const section = (name, keyOk, valOk) => {
    const src = raw?.[name];
    if (src === undefined) return {};
    if (!isObj(src)) {
      ignored.push(name);
      return {};
    }
    const out = {};
    for (const [k, v] of Object.entries(src)) {
      if (k.startsWith("_")) continue;
      if (keyOk(k) && valOk(v)) out[k] = v;
      else ignored.push(`${name}.${k}`);
    }
    return out;
  };
  const str = (v) => typeof v === "string" && v.trim() !== "";
  const roles = { ...DEFAULTS.roles, ...section("roles", (k) => ROLE_RE.test(k) && !RESERVED.has(k), (v) => typeof v === "boolean") };
  const isRole = (v) => str(v) && Object.hasOwn(roles, v);
  const lineages = { ...DEFAULTS.lineages, ...section("lineages", (k) => LINEAGE_RE.test(k), isRole) };
  const oldLineages = { ...DEFAULTS.oldLineages, ...section("oldLineages", (k) => LINEAGE_RE.test(k), isRole) };
  const roleAliases = { ...DEFAULTS.roleAliases, ...section("roleAliases", (k) => str(k) && !Object.hasOwn(roles, k) && !RESERVED.has(k), isRole) };
  // 글 속 이름 → 주인: 역할·계보·옛 이름은 저절로 들어간다(대문자 꼴 포함). 프로젝트 ownerAliases가 위에 온다.
  const derived = {};
  for (const r of Object.keys(roles)) derived[r] = r;
  for (const map of [lineages, oldLineages, roleAliases]) for (const [k, r] of Object.entries(map)) derived[k] ??= r;
  for (const [k, r] of Object.entries(derived)) derived[k.toUpperCase()] ??= r;
  const ownerAliases = { ...derived, ...DEFAULTS.ownerAliases, ...section("ownerAliases", str, str) };
  const gapsRaw = raw?.gaps;
  if (gapsRaw !== undefined && !isObj(gapsRaw)) ignored.push("gaps");
  const g = isObj(gapsRaw) ? gapsRaw : {};
  const gaps = { ...DEFAULTS.gaps, rules: { ...DEFAULTS.gaps.rules } };
  const num = (k, min) => {
    if (g[k] === undefined) return;
    if (typeof g[k] === "number" && Number.isFinite(g[k]) && g[k] >= min) gaps[k] = g[k];
    else ignored.push(`gaps.${k}`);
  };
  num("staleHours", 0);
  num("listMax", 0);
  num("mdMaxLines", 5);
  if (g.rules !== undefined) {
    if (!isObj(g.rules)) ignored.push("gaps.rules");
    else for (const [k, v] of Object.entries(g.rules)) {
      if (Object.hasOwn(DEFAULTS.gaps.rules, k) && typeof v === "boolean") gaps.rules[k] = v;
      else if (!k.startsWith("_")) ignored.push(`gaps.rules.${k}`);
    }
  }
  if (g.tickets !== undefined) {
    if (g.tickets === false || str(g.tickets)) gaps.tickets = g.tickets;
    else ignored.push("gaps.tickets");
  }
  if (g.g8Owners !== undefined) {
    if (Array.isArray(g.g8Owners) && g.g8Owners.every(str)) gaps.g8Owners = [...g.g8Owners];
    else ignored.push("gaps.g8Owners");
  }
  return { roles, lineages, oldLineages, roleAliases, ownerAliases, gaps, ...(ignored.length ? { ignored } : {}) };
}

export const roleNames = (config) => Object.keys(config.roles);
export const offRoles = (config) => roleNames(config).filter((r) => config.roles[r] === false);
/** 옛 역할 이름을 지금 이름으로. 모르는 이름은 그대로 둔다(검사는 게시판이 한다). */
export const roleName = (config, r) => config.roleAliases[r] ?? r;

/** CLI 출력에 붙일 설정 문제(없으면 null): 깨진 파일, 건너뛴 항목. */
export function configNotice(config) {
  if (!config.error && !config.ignored) return null;
  return {
    file: config.file,
    ...(config.error ? { error: config.error, using: "defaults" } : {}),
    ...(config.ignored ? { ignored: config.ignored } : {}),
  };
}
