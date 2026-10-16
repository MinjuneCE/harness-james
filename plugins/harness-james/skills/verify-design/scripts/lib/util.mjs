// 설계 검증 공통 유틸: JSON·해시·glob·정규식·텍스트 정규화
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"];
export const SEV_POINTS = { critical: 60, high: 30, medium: 12, low: 4, info: 0 };
export const CONFIDENCES = ["confirmed", "likely", "possible"];
export const CONF_FACTOR = { confirmed: 1.0, likely: 0.7, possible: 0.4 };
export const SCOPE_STATES = ["changed", "carried", "resolved"];
export const SOURCES = ["script", "judge", "human"];
export const REFUTE_VERDICTS = ["upheld", "downgraded", "rejected", "uncertain"];
export const CRITERION_STATUSES = ["evaluated", "not-applicable", "disabled", "skipped-unchanged"];
export const LEVELS = ["light", "standard", "deep"];

export const sevRank = (s) => SEVERITIES.length - SEVERITIES.indexOf(s);
export const atLeast = (sev, min) => sevRank(sev) >= sevRank(min);

export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export function writeJson(p, data) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}
export function writeText(p, text) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const shortHash = (s) => sha256(s).slice(0, 16);

// ---------- glob ----------
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; ) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const atSegStart = i === 0 || glob[i - 1] === "/";
      if (atSegStart && glob[i + 2] === "/") { re += "(?:.*/)?"; i += 3; continue; }
      re += ".*"; i += 2; continue;
    }
    if (c === "*") { re += "[^/]*"; i += 1; continue; }
    if (c === "?") { re += "[^/]"; i += 1; continue; }
    re += "\\^$+.()|{}[]".includes(c) ? "\\" + c : c;
    i += 1;
  }
  return new RegExp(`^${re}$`);
}
export const matchesAny = (path, globs = []) => globs.some((g) => globToRegExp(g).test(path));

// ---------- 정규식 ----------
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ID 패턴을 경계 조건과 함께 전역 정규식으로 만든다. 앞뒤가 영숫자·하이픈이면 매치하지 않는다.
export function idRegex(pattern) {
  return new RegExp(`(?<![A-Za-z0-9_\\-])(?:${pattern})(?![A-Za-z0-9_]|-\\d)`, "gu");
}

// 정규식 문자열이면 정규식으로, 아니면 리터럴로 찾는다(단위 목록 등).
export function looksLikeRegex(s) {
  return /[\\[\]()*+?{}|^$]/.test(s);
}

// ---------- 텍스트 ----------
export function normalizeLine(s) {
  return s
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function lineHasAny(line, words = []) {
  return words.some((w) => w && line.includes(w));
}

export function levenshtein(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      if (prev[j] < rowMin) rowMin = prev[j];
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

export function truncate(s, n = 160) {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 언어 공통 기본 어휘(프로파일 script_hints가 덮어쓰거나 더한다). 도메인 어휘가 아니다.
export const DEFAULT_VOCAB = {
  placeholder: ["TODO", "TBD", "FIXME", "???"],
  time_words: ["아직", "현재", "지금", "이미", "최근", "곧", "currently", "still", "not yet", "as of now"],
  status_words: ["확정", "결정", "제안", "보류", "종결", "폐기", "대체", "철회", "accepted", "proposed", "superseded", "deprecated", "rejected", "open", "closed"],
  supersede_words: ["대체", "supersede", "replaced by", "replaces"],
  secondary_markers: ["회의", "발언", "들었다", "라고 함", "전언", "meeting", "said", "heard"],
  source_markers: ["출처", "근거", "측정", "실측", "조회", "source", "measured", "per "],
  owner_words: ["담당", "owner", "@"],
  method_words: ["방법", "확인", "조회", "질문", "method", "verify", "ask"],
  impact_words: ["영향", "틀리면", "틀렸을 때", "impact", "if wrong"],
  acceptance_markers: ["Given", "When", "Then", "수용 기준", "Acceptance", "인수 기준", "Independent Test", "독립 시험"],
  threat_headers: ["위협", "threat", "STRIDE"],
  timing_keys: ["timeout", "retry", "backoff", "interval", "period", "after", "wait", "delay", "ttl", "expire", "cron", "rate", "limit"],
  history_extra: ["~~"],
};

// 시간 단위 → 초. 언어 공통(한국어·영어)과 ISO 8601 기간.
const UNIT_SECONDS = {
  "초": 1, "s": 1, "sec": 1, "secs": 1, "second": 1, "seconds": 1,
  "분": 60, "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60,
  "시간": 3600, "h": 3600, "hr": 3600, "hrs": 3600, "hour": 3600, "hours": 3600,
  "일": 86400, "d": 86400, "day": 86400, "days": 86400,
  "ms": 0.001,
};
export function durationSeconds(value, unit) {
  const u = unit.toLowerCase();
  if (u in UNIT_SECONDS) return Number(value) * UNIT_SECONDS[u];
  return null;
}
export function isoDurationSeconds(s) {
  const m = s.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m || s === "P" || s === "PT") return null;
  const [, d, h, mi, se] = m;
  return (Number(d || 0) * 86400) + (Number(h || 0) * 3600) + (Number(mi || 0) * 60) + Number(se || 0);
}
