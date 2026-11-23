// 레포 읽기 전용 git. 대상 레포는 읽기만 한다: 아래 목록 밖의 git 명령은 던진다(fetch·switch·checkout·commit 없음).
// 파일 내용은 예시 env 파일의 키 이름만 읽는다. 진짜 .env 파일은 열지 않는다.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const READ_ONLY = new Set(["rev-parse", "ls-tree", "show", "log", "diff", "merge-base", "rev-list", "cat-file", "for-each-ref", "config", "remote"]);
const EXAMPLE_ENV = /(^|\/)(\.env\.(example|sample|template|dist)|[^/]+\.example)$/;
export const isExampleEnv = (path) => EXAMPLE_ENV.test(path);
export const isRealEnv = (path) => /(^|\/)\.env(\.[^/]+)?$/.test(path) && !isExampleEnv(path);

export function assertReadOnly(args) {
  const [sub, a1] = args;
  if (!READ_ONLY.has(sub)) throw new Error(`읽기 전용 git 명령만 쓴다: git ${sub}`);
  if (sub === "config" && a1 !== "--get") throw new Error("git config는 --get만 쓴다");
  if (sub === "remote" && a1 !== "get-url") throw new Error("git remote는 get-url만 쓴다");
  if (sub === "show") for (const a of args.slice(1)) { const p = a.includes(":") ? a.slice(a.indexOf(":") + 1) : ""; if (p && isRealEnv(p)) throw new Error(`.env 파일 내용은 읽지 않는다: ${p}`); }
}

export function gitIn(dir) {
  const run = (...args) => {
    assertReadOnly(args);
    return execFileSync("git", ["-C", dir, "-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 512 << 20, stdio: ["ignore", "pipe", "pipe"] });
  };
  const tryRun = (...args) => { assertReadOnly(args); try { return run(...args); } catch { return null; } };
  const lines = (...args) => (tryRun(...args) ?? "").split("\n").filter(Boolean);
  const commit = (ref) => (ref ? tryRun("rev-parse", "--verify", "-q", `${ref}^{commit}`)?.trim() || null : null);
  const tree = (sha) => lines("ls-tree", "-r", "--name-only", sha);
  // 예시 env 파일의 키 이름만(값은 버린다)
  const envKeys = (sha, path) => {
    if (!isExampleEnv(path)) throw new Error(`예시 env 파일만 읽는다: ${path}`);
    return [...new Set((tryRun("show", `${sha}:${path}`) ?? "").split("\n").map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=/.exec(l)?.[1]).filter(Boolean))];
  };
  const isRepo = () => tryRun("rev-parse", "--git-dir") !== null;
  // 마지막 fetch 시각(FETCH_HEAD 수정 시각). origin/… ref가 얼마나 낡았을 수 있는지의 단서
  const lastFetch = () => {
    const d = tryRun("rev-parse", "--git-common-dir")?.trim();
    if (!d) return null;
    try { return statSync(join(isAbsolute(d) ? d : resolve(dir, d), "FETCH_HEAD")).mtime.toISOString(); } catch { return null; }
  };
  return { dir, run, tryRun, lines, commit, tree, envKeys, isRepo, lastFetch };
}

// ref가 로컬 브랜치를 가리키고 origin 쪽 같은 이름이 앞서 있으면 { local, origin, behind }
export function localLag(g, ref) {
  if (!ref || /^origin\//.test(ref) || /^[0-9a-f]{7,40}$/.test(ref)) return null;
  const local = g.commit(`refs/heads/${ref}`);
  const origin = g.commit(`refs/remotes/origin/${ref}`);
  if (!local || !origin || local === origin) return local && origin ? { local, origin, behind: 0, ahead: 0 } : null;
  const n = (a, b) => Number(g.tryRun("rev-list", "--count", `${a}..${b}`)?.trim() ?? 0);
  return { local, origin, behind: n(local, origin), ahead: n(origin, local) };
}
