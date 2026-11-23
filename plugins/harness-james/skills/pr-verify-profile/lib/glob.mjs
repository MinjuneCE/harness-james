// 프로필 경로 glob. pr-verify/scripts/lib.mjs의 globToRegExp와 같은 뜻이다(프로필을 /pr-verify와 똑같이 읽는다).
// 같은지는 test/glob.test.mjs가 워크스페이스의 pr-verify 구현과 대조한다.
const cache = new Map();
export function globToRegExp(glob) {
  if (cache.has(glob)) return cache.get(glob);
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
  const rx = new RegExp(`^${re}$`);
  cache.set(glob, rx);
  return rx;
}
export const matchesAny = (path, globs = []) => globs.some((g) => globToRegExp(g).test(path));
export const matchPaths = (path, include = [], exclude = []) => matchesAny(path, include) && !matchesAny(path, exclude);
export const inStructure = (path, s) => matchPaths(path, s.paths ?? [], s.exclude ?? []);
