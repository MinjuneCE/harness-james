// What the pane reads off the trace, worked out only while it draws: each call
// named as an action a person reads ("읽음", "검색 \"x\"", "git status"), the
// actions grouped into a flow, the files the turn looked at, where its time
// went, the harness it touched, and the places it got stuck, each with the
// harness piece that could fix it. Pure functions; the hooks never call them.
import type { TraceAgent, TraceFile, TraceStep, TraceTool, TraceTurn } from '../types'
import { MAIN, cellWidth, oneLine, runMs, summarize, waitMs } from './trace'

/** The stuck signals' thresholds, in one place to tune. */
export const BLOCK = {
  /** The same file read again: flagged from this read on. */
  rereadFrom: 3,
  /** Searches in a row. */
  searchRun: 4,
  /** Failures of the same call (same tool, like input). */
  retryFails: 2,
  /** The person's approval took this long. */
  humanWaitMs: 10_000,
  /** The model thought this long before it picked its calls. */
  thinkMs: 120_000,
  /** One call ran this long. */
  toolMs: 60_000,
  /** The auto-mode decider took this long. */
  judgeMs: 5_000,
  /** The first piece of a response came this late. */
  firstChunkMs: 20_000,
} as const

/** The harness piece each signal points at. */
export const HINT = {
  reread: '요약 문서·메모리 후보',
  searchRun: '위치 안내(CLAUDE.md·스킬) 후보',
  retry: '스킬에 맞는 명령, 또는 훅 후보',
  humanWait: '권한 규칙 후보',
  /** A check a hook or an ask rule asked for on purpose: no allow rule to suggest. */
  intended: '의도된 확인 (훅·규칙)',
  think: '판단 근거 문서·스킬 후보',
  slowTool: '명령·스크립트 개선 후보',
  judge: '권한 규칙 후보',
} as const

// ---- durations, as the pane says them ----

/** A duration in Korean words; '' under a second (the pane leaves those out). */
export function fmtKo(ms: number): string {
  const s = Math.floor((Number.isFinite(ms) ? ms : 0) / 1000)
  if (s < 1) return ''
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m}분` : `${m}분 ${s % 60}초`
  const h = Math.floor(m / 60)

  return m % 60 === 0 ? `${h}시간` : `${h}시간 ${m % 60}분`
}

/** Like fmtKo, but '0초' where fmtKo says nothing. */
export const fmtKo0 = (ms: number): string => fmtKo(ms) || '0초'

// ---- paths ----

export type Where = { cwd: string; home: string }

/** The home folder the cwd sits under, as far as the path tells. */
export function homeOf(cwd: string): string {
  return /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/.exec(cwd)?.[1] ?? ''
}

function normalize(path: string): string {
  const isHome = path === '~' || path.startsWith('~/')
  const out: string[] = []
  for (const part of (isHome ? path.slice(1) : path).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }

  // Home unknown (a cwd outside it): `~` stays, so the same file still reads as one.
  return `${isHome ? '~' : ''}/${out.join('/')}`
}

/** A path made absolute against a folder (the command's `cd`, else the cwd). */
export function resolvePath(p: string, base: string, w: Where): string {
  if (p.startsWith('/')) return normalize(p)
  if (p === '~' || p.startsWith('~/')) return normalize(w.home === '' ? p : `${w.home}${p.slice(1)}`)
  if (base === '') return p

  return normalize(`${base}/${p}`)
}

/** A path as the pane shows it: under the cwd relative, under home with `~`, the tail kept when long. */
export function shortPath(path: string, w: Where, max = 40): string {
  let p = path
  if (w.cwd !== '' && (p === w.cwd || p.startsWith(`${w.cwd}/`))) p = p === w.cwd ? '.' : p.slice(w.cwd.length + 1)
  else if (w.home !== '' && (p === w.home || p.startsWith(`${w.home}/`))) p = `~${p.slice(w.home.length)}`
  if (p.length <= max) return p
  const parts = p.split('/')

  return `…/${parts.slice(-2).join('/')}`
}

export const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path

const dirOf = (path: string): string => {
  const i = path.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

/** Whether a path names a file rather than a folder, as far as its look tells. */
export function looksLikeFile(p: string): boolean {
  if (p.endsWith('/') || /[*?[\]{}]/.test(p)) return false
  const name = baseName(p)
  if (name === '.' || name === '..' || name === '' || name === '~') return false

  return /.\.[A-Za-z0-9]{1,8}$/.test(name) || /^\.[A-Za-z]/.test(name) || /^(Makefile|Dockerfile|LICENSE|README)$/.test(name)
}

const isMemoryPath = (p: string): boolean => /\/\.claude\/projects\/[^/]+\/memory\//.test(p) || /\/memory\/MEMORY\.md$/.test(p)
const isSkillDoc = (p: string): boolean => baseName(p) === 'SKILL.md' || /\/skills\//.test(p)
const isGuide = (p: string): boolean => /^CLAUDE(\.local)?\.md$/.test(baseName(p))

// ---- an action: one call, named ----

export type Act = {
  /** What groups it with its neighbours: the same kind reads as one line. */
  kind: string
  label: string
  /** How the header says it while it runs ("읽는 중"). */
  progress: string
  /** What it acted on, as the flow shows it. */
  targets: string[]
  /** Files it looked at (read, searched, compared), absolute where known. */
  files: string[]
  urls: string[]
  pattern?: string
  isMemory: boolean
  /** The command as given, for 자세히. */
  raw: string
}

const VERB_PROGRESS: Record<string, string> = {
  읽음: '읽는 중',
  '부분 읽음': '읽는 중',
  검색: '검색 중',
  둘러봄: '둘러보는 중',
  비교: '비교 중',
  테스트: '테스트 중',
  검증: '검증 중',
  빌드: '빌드 중',
  '웹 요청': '웹 요청 중',
  '파일 작업': '파일 작업 중',
}

function act(kind: string, label: string, progress: string, raw: string, extra: Partial<Act> = {}): Act {
  return { kind, label, progress, targets: [], files: [], urls: [], isMemory: false, raw, ...extra }
}

const str = (o: Record<string, unknown>, k: string): string | undefined => {
  const v = o[k]
  return typeof v === 'string' && v !== '' ? v : undefined
}

const quote = (s: string, max = 14): string => `"${oneLine(s, max)}"`

const hostOf = (url: string): string => /^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1] ?? oneLine(url, 30)

/** A file the model read: named for where it lies (memory, a skill's doc, CLAUDE.md), else by how much it read. */
function readAct(path: string, isPartial: boolean, raw: string, w: Where): Act {
  const shown = baseName(path)
  const extra = { targets: [shown], files: [path] }
  if (isMemoryPath(path)) return act('memory', '메모리 확인', '메모리 확인 중', raw, { ...extra, isMemory: true })
  if (isSkillDoc(path)) return act('skilldoc', '스킬 문서 읽음', '스킬 문서 읽는 중', raw, extra)
  if (isGuide(path)) return act('guide', '지침 읽음', '지침 읽는 중', raw, extra)
  void w

  return isPartial ? act('partial', '부분 읽음', '읽는 중', raw, extra) : act('read', '읽음', '읽는 중', raw, extra)
}

/** One call named by the rules: never by asking a model. */
export function actOf(t: TraceTool, w: Where): Act {
  const input = t.input ?? {}
  const name = t.name
  const raw = summarize(name, input, w.cwd)
  switch (name) {
    case 'Read': {
      const path = str(input, 'file_path')
      if (path === undefined) return act('read', '읽음', '읽는 중', raw)
      const isPartial = input.offset !== undefined || input.limit !== undefined
      return readAct(resolvePath(path, w.cwd, w), isPartial, raw, w)
    }
    case 'Grep': {
      const pattern = str(input, 'pattern') ?? ''
      const path = str(input, 'path')
      const abs = path === undefined ? undefined : resolvePath(path, w.cwd, w)
      const extra: Partial<Act> = { pattern, targets: abs === undefined ? [] : [looksLikeFile(abs) ? baseName(abs) : shortPath(abs, w)] }
      if (abs !== undefined && looksLikeFile(abs)) extra.files = [abs]
      return act('search', `검색 ${quote(pattern)}`, '검색 중', raw, extra)
    }
    case 'Glob': {
      const pattern = str(input, 'pattern') ?? ''
      const path = str(input, 'path')
      return act('find', `파일 찾기 ${quote(pattern)}`, '파일 찾는 중', raw, { pattern, targets: path === undefined ? [] : [shortPath(resolvePath(path, w.cwd, w), w)] })
    }
    case 'Edit':
    case 'MultiEdit': {
      const path = str(input, 'file_path')
      return act('edit', '고침', '고치는 중', raw, { targets: path === undefined ? [] : [baseName(path)] })
    }
    case 'Write': {
      const path = str(input, 'file_path')
      const targets = path === undefined ? [] : [baseName(path)]
      if (t.resultType === 'create') return act('create', '새 파일', '파일 만드는 중', raw, { targets })
      if (t.resultType === 'update') return act('overwrite', '덮어씀', '덮어쓰는 중', raw, { targets })
      return act('write', '파일 씀', '파일 쓰는 중', raw, { targets })
    }
    case 'NotebookEdit': {
      const path = str(input, 'notebook_path')
      return act('notebook', '노트북 고침', '노트북 고치는 중', raw, { targets: path === undefined ? [] : [baseName(path)] })
    }
    case 'Bash':
      return bashAct(str(input, 'command') ?? '', str(input, 'description'), w)
    case 'Agent':
    case 'Task': {
      const type = str(input, 'subagent_type') ?? 'general-purpose'
      const desc = str(input, 'description')
      return act(`delegate:${t.id}`, `위임 ${type}${desc === undefined ? '' : `: ${oneLine(desc, 40)}`}`, '서브에이전트 기다리는 중', raw)
    }
    case 'Skill': {
      const skill = str(input, 'skill') ?? '?'
      return act(`skill:${skill}`, `스킬 ${skill}`, '스킬 실행 중', raw)
    }
    case 'Workflow': {
      const wf = str(input, 'name') ?? (typeof input.script === 'string' ? /name\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(input.script)?.[2] : undefined) ?? '?'
      return act(`workflow:${t.id}`, `워크플로 ${wf}`, '워크플로 실행 중', raw)
    }
    case 'WebFetch': {
      const url = str(input, 'url') ?? ''
      return act('webfetch', `웹 읽음 ${hostOf(url)}`, '웹 읽는 중', raw, { urls: url === '' ? [] : [url] })
    }
    case 'WebSearch': {
      const q = str(input, 'query') ?? ''
      return act(`websearch:${q}`, `웹 검색 ${quote(q, 24)}`, '웹 검색 중', raw)
    }
    case 'AskUserQuestion': {
      const qs = input.questions
      const first = Array.isArray(qs) ? (qs[0] as { question?: unknown } | undefined)?.question : undefined
      return act(`ask:${t.id}`, `질문 ${quote(typeof first === 'string' ? first : '', 30)}`, '사람 답 기다리는 중', raw)
    }
    case 'ToolSearch':
      return act('toolsearch', '도구 찾기', '도구 찾는 중', raw)
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      if (mcp !== null) return act(`mcp:${name}`, `${mcp[1]} ${mcp[2]}`, `${mcp[1]} ${mcp[2]} 실행 중`, raw)
      return act(`tool:${name}`, name, `${name} 실행 중`, raw)
    }
  }
}

// ---- Bash: a command line split into what each part does ----

/** Splits a command line at `&&`, `||`, `;`, `|` and newlines outside quotes; heredoc bodies are dropped. */
export function splitCommand(cmd: string): { text: string; isPiped: boolean }[] {
  const lines = cmd.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    kept.push(line)
    const doc = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (doc !== null) {
      const end = doc[2]
      while (i + 1 < lines.length && (lines[i + 1] ?? '').trim() !== end) i += 1
      i += 1
    }
  }
  const out: { text: string; isPiped: boolean }[] = []
  let cur = ''
  let quoteCh = ''
  let isPiped = false
  const text = kept.join('\n')
  const push = (nextPiped: boolean): void => {
    if (cur.trim() !== '') out.push({ text: cur.trim(), isPiped })
    cur = ''
    isPiped = nextPiped
  }
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? ''
    if (quoteCh !== '') {
      if (c === '\\' && quoteCh === '"') {
        cur += c + (text[i + 1] ?? '')
        i += 1
        continue
      }
      if (c === quoteCh) quoteCh = ''
      cur += c
      continue
    }
    if (c === '\\') {
      cur += c + (text[i + 1] ?? '')
      i += 1
      continue
    }
    if (c === "'" || c === '"') {
      quoteCh = c
      cur += c
      continue
    }
    const two = text.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      push(false)
      i += 1
      continue
    }
    if (c === '|' && text[i - 1] !== '>') {
      push(true)
      continue
    }
    if (c === ';' || c === '\n') {
      push(false)
      continue
    }
    cur += c
  }
  push(false)

  return out
}

/** Words of one command, quotes taken off; redirections and their targets apart. */
export function words(seg: string): { args: string[]; writes: string[] } {
  const args: string[] = []
  const writes: string[] = []
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g
  const raw: { text: string; isQuoted: boolean }[] = []
  for (let m = re.exec(seg); m !== null; m = re.exec(seg)) {
    if (m[1] !== undefined) raw.push({ text: m[1].replace(/\\(.)/g, '$1'), isQuoted: true })
    else if (m[2] !== undefined) raw.push({ text: m[2], isQuoted: true })
    else raw.push({ text: m[3] ?? '', isQuoted: false })
  }
  for (let i = 0; i < raw.length; i += 1) {
    const w = raw[i]
    if (w === undefined) continue
    if (!w.isQuoted && /^(\d?>>?|&>|\d?<|<<-?|\d>&\d|>&\d)/.test(w.text)) {
      const rest = w.text.replace(/^(\d?>>?|&>|\d?<<?-?|\d>&\d|>&\d)/, '')
      const isOut = /^(\d?>>?|&>)/.test(w.text) && !/^\d>&\d|^>&\d/.test(w.text)
      const target = rest !== '' ? rest : (raw[i + 1]?.text ?? '')
      if (rest === '' && !/^\d>&\d$|^>&\d$/.test(w.text)) i += 1
      if (isOut && target !== '' && target !== '/dev/null' && !/^&\d$/.test(target)) writes.push(target)
      continue
    }
    args.push(w.text)
  }

  return { args, writes }
}

const IGNORED = new Set(['echo', 'printf', 'true', 'false', ':', 'sleep', 'export', 'set', 'unset', 'exit', 'wait', 'source', '.', 'clear', 'date', 'pwd', 'which', 'type', 'trap', 'read', 'local', 'return', 'shift'])
const PREFIX = new Set(['sudo', 'time', 'env', 'command', 'nice', 'nohup', 'exec', 'builtin'])
const SEARCH = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack'])
const BROWSE = new Set(['ls', 'find', 'tree', 'fd', 'du', 'll'])
const READ = new Set(['cat', 'head', 'tail', 'wc', 'jq', 'nl', 'less', 'more', 'bat', 'stat', 'file', 'xxd', 'od', 'strings'])
const COMPARE = new Set(['diff', 'cmp', 'comm'])
const FILEOPS = new Set(['mkdir', 'cp', 'mv', 'rm', 'touch', 'chmod', 'chown', 'ln', 'rmdir'])
const WEB = new Set(['curl', 'wget'])
/** Flags that take the next word as their value, per command family. */
const VALUE_FLAGS: Record<string, Set<string>> = {
  search: new Set(['-e', '-f', '-A', '-B', '-C', '-m', '-d', '-D', '-g', '-t', '-T', '-M', '-j', '--glob', '--type', '--max-count', '--context', '--after-context', '--before-context', '--regexp', '--file']),
  read: new Set(['-n', '-c', '--lines', '--bytes', '--arg', '--argjson', '-L']),
  browse: new Set(['-name', '-iname', '-type', '-path', '-maxdepth', '-mindepth', '-newer', '-size', '-mtime', '-e', '-E', '-t', '-d', '-I', '-L', '--max-depth', '--exclude', '--extension']),
}

type Part = { verb: string; label?: string; paths: string[]; folders: string[]; urls: string[]; pattern?: string }

function positional(args: string[], family: string): string[] {
  const takes = VALUE_FLAGS[family] ?? new Set<string>()
  const out: string[] = []
  let isEnd = false
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? ''
    if (!isEnd && a === '--') {
      isEnd = true
      continue
    }
    if (!isEnd && a.startsWith('-') && a !== '-') {
      if (takes.has(a)) i += 1
      continue
    }
    out.push(a)
  }

  return out
}

const isTest = (cmd: string, args: string[]): boolean => {
  const a0 = args[0] ?? ''
  const a1 = args[1] ?? ''
  if (['vitest', 'jest', 'pytest', 'mocha', 'ava', 'phpunit', 'rspec'].includes(cmd)) return true
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd)) return a0 === 'test' || a0 === 't' || (a0 === 'run' && /^test/.test(a1)) || /^test:/.test(a0)
  if (cmd === 'npx' || cmd === 'bunx' || cmd === 'pnpx') return ['vitest', 'jest', 'mocha', 'playwright'].includes(a0)
  if (cmd === 'go' || cmd === 'cargo' || cmd === 'deno' || cmd === 'dotnet' || cmd === 'mix') return a0 === 'test'
  if (cmd === 'python' || cmd === 'python3') return a0 === '-m' && (a1 === 'pytest' || a1 === 'unittest')
  if (cmd === 'node') return a0 === '--test'
  if (cmd === 'make') return /^(test|check)/.test(a0)
  if (cmd === 'claude') return a0 === 'plugin' && a1 === 'test'

  return false
}

const isBuild = (cmd: string, args: string[]): boolean => {
  const a0 = args[0] ?? ''
  const a1 = args[1] ?? ''
  if (['tsc', 'webpack', 'esbuild', 'rollup', 'vite', 'next', 'turbo'].includes(cmd)) return cmd !== 'vite' && cmd !== 'next' ? true : a0 === 'build'
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd)) return a0 === 'build' || (a0 === 'run' && /^build/.test(a1))
  if (cmd === 'cargo' || cmd === 'go' || cmd === 'dotnet' || cmd === 'gradle' || cmd === 'mvn') return a0 === 'build' || a0 === 'package'
  if (cmd === 'make') return !/^(test|check|clean)/.test(a0)

  return false
}

/** What one command of a line does, or undefined when it does nothing the flow names (echo, true). */
function partOf(argv: string[], writes: string[]): Part | 'ignored' | { unknown: string } {
  let args = argv.slice()
  while (args.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0] ?? '') || PREFIX.has(args[0] ?? ''))) {
    const a = args.shift() ?? ''
    if (a === 'timeout' || a === 'nice') args.shift()
  }
  if (args[0] === 'xargs') {
    args.shift()
    while (args.length > 0 && (args[0] ?? '').startsWith('-')) args.shift()
  }
  const cmd = baseName(args[0] ?? '')
  const rest = args.slice(1)
  if (cmd === '') return 'ignored'
  if (writes.length > 0 && (cmd === 'cat' || cmd === 'echo' || cmd === 'printf' || cmd === 'tee')) {
    return { verb: '파일 작업', paths: writes, folders: [], urls: [] }
  }
  if (IGNORED.has(cmd)) return 'ignored'
  if (cmd === 'tee') return { verb: '파일 작업', paths: positional(rest, ''), folders: [], urls: [] }
  if (SEARCH.has(cmd)) {
    const e = rest.indexOf('-e')
    const pos = positional(rest, 'search')
    const pattern = e >= 0 ? (rest[e + 1] ?? '') : (pos.shift() ?? '')
    return { verb: '검색', paths: pos, folders: [], urls: [], pattern }
  }
  if (BROWSE.has(cmd)) {
    const pos = positional(rest, 'browse')
    if (cmd === 'fd') pos.shift()
    return { verb: '둘러봄', paths: [], folders: pos.length === 0 ? ['.'] : pos, urls: [] }
  }
  if (cmd === 'sed') {
    if (!rest.includes('-n')) return { unknown: cmd }
    // `sed -n` takes no value of its own: the first word left is the script.
    const pos = positional(rest, '')
    pos.shift()
    return { verb: '읽음', paths: pos, folders: [], urls: [] }
  }
  if (READ.has(cmd)) {
    const pos = positional(rest, 'read')
    if (cmd === 'jq') pos.shift()
    return { verb: '읽음', paths: pos, folders: [], urls: [] }
  }
  if (COMPARE.has(cmd)) return { verb: '비교', paths: positional(rest, ''), folders: [], urls: [] }
  if (cmd === 'git') {
    let i = 0
    while (i < rest.length && (rest[i] ?? '').startsWith('-')) i += rest[i] === '-C' || rest[i] === '-c' ? 2 : 1
    const sub = rest[i]
    return { verb: sub === undefined ? 'git' : `git ${sub}`, paths: [], folders: [], urls: [] }
  }
  if (isTest(cmd, rest)) return { verb: '테스트', paths: [], folders: [], urls: [] }
  if (cmd === 'claude' && rest[0] === 'plugin' && rest[1] === 'validate') return { verb: '검증', paths: [], folders: [], urls: [] }
  if (isBuild(cmd, rest)) return { verb: '빌드', paths: [], folders: [], urls: [] }
  if (WEB.has(cmd)) return { verb: '웹 요청', paths: [], folders: [], urls: rest.filter(a => /^https?:\/\//.test(a)) }
  if (FILEOPS.has(cmd)) return { verb: '파일 작업', paths: positional(rest, ''), folders: [], urls: [] }

  return { unknown: cmd }
}

/** A Bash call named by what its commands do: `cd` sets the folder, a pipe's tail filters its head. */
export function bashAct(command: string, description: string | undefined, w: Where): Act {
  const raw = oneLine(command, 200)
  let base = w.cwd
  const verbs: string[] = []
  const files: string[] = []
  const targets: string[] = []
  const urls: string[] = []
  const patterns: string[] = []
  let unknown: string | undefined
  let hasRead = false
  const seen = new Set<string>()
  const addTarget = (t: string): void => {
    if (!seen.has(t)) {
      seen.add(t)
      targets.push(t)
    }
  }
  for (const seg of splitCommand(command)) {
    const { args, writes } = words(seg.text)
    if (args[0] === 'cd') {
      if (args[1] !== undefined && !seg.isPiped) base = resolvePath(args[1], base, w)
      continue
    }
    // A pipe's later commands filter what its first one gave (grep … | head): the first names it.
    if (seg.isPiped) continue
    const part = partOf(args, writes)
    if (part === 'ignored') continue
    if ('unknown' in part) {
      unknown = unknown ?? part.unknown
      continue
    }
    if (!verbs.includes(part.verb)) verbs.push(part.verb)
    if (part.pattern !== undefined && part.pattern !== '') patterns.push(part.pattern)
    const isLook = part.verb === '읽음' || part.verb === '검색' || part.verb === '비교'
    for (const p of part.paths) {
      const abs = resolvePath(p, base, w)
      const isFile = looksLikeFile(abs)
      addTarget(isFile ? baseName(abs) : shortPath(abs, w))
      if (isLook && isFile) {
        files.push(abs)
        hasRead = true
      }
    }
    for (const f of part.folders) addTarget(shortPath(resolvePath(f, base, w), w))
    for (const u of part.urls) {
      urls.push(u)
      addTarget(hostOf(u))
    }
  }
  void hasRead
  if (verbs.length === 0) {
    const label = description !== undefined ? oneLine(description, 40) : unknown !== undefined ? `명령 실행 ${unknown}` : '명령 실행'
    return act(`cmd:${label}`, label, unknown !== undefined ? `${unknown} 실행 중` : '명령 실행 중', raw)
  }
  const shown = verbs.slice(0, 3)
  const first = shown[0] ?? ''
  const progress = VERB_PROGRESS[first] ?? `${first} 실행 중`
  const isMemory = files.some(isMemoryPath)
  if (shown.length === 1 && first === '검색') {
    const pattern = patterns[0] ?? ''
    return act('search', `검색 ${quote(pattern)}`, progress, raw, { targets, files, urls, pattern, isMemory })
  }
  if (shown.length === 1 && first === '둘러봄') return act('browse', '폴더 둘러봄', progress, raw, { targets, files, urls, isMemory })
  if (shown.length === 1 && first === '읽음' && isMemory) return act('memory', '메모리 확인', '메모리 확인 중', raw, { targets, files, urls, isMemory })
  const label = shown.join('·')
  const extra: Partial<Act> = { targets, files, urls, isMemory }
  if (patterns[0] !== undefined) extra.pattern = patterns[0]

  return act(first === '읽음' && shown.length === 1 ? 'read' : `bash:${label}`, label, progress, raw, extra)
}

// ---- the flow: actions grouped, said lines between, stuck signals on their line ----

export type Mark = '✓' | '✗' | '!' | '●' | '?' | '-' | '»' | '·'

export type FlowLine = {
  mark: Mark
  /** 'ok' | 'bad' | 'warn' | 'live' | 'wait' | 'idle' | 'say' | 'signal' */
  tone: 'ok' | 'bad' | 'warn' | 'live' | 'wait' | 'idle' | 'say'
  label: string
  targets: string[]
  /** The harness piece a stuck signal points at. */
  hint?: string
  /** A refusal's or failure's reason. */
  reason?: string
  /** A neutral word on the line: the time an auto-judged call took while judge and run are one span. */
  note?: string
  /** For 자세히: the commands as given, times and verdicts. */
  details: string[]
  isSignal?: boolean
  /** A step boundary for 자세히: `#n · model/effort · ctx · out`. */
  isStep?: boolean
}

type Entry = { tool: TraceTool; act: Act; step: TraceStep }

const stateTone = (t: TraceTool): { mark: Mark; tone: FlowLine['tone'] } => {
  switch (t.state) {
    case 'ok':
      return { mark: '✓', tone: 'ok' }
    case 'fail':
      return { mark: '✗', tone: 'bad' }
    case 'deny':
      return { mark: '!', tone: 'warn' }
    case 'stop':
      return { mark: '-', tone: 'idle' }
    case 'wait':
      return { mark: '?', tone: 'wait' }
    case 'queued':
      return { mark: '·', tone: 'idle' }
    default:
      return { mark: '●', tone: 'live' }
  }
}

/** Calls that settle the same way read as one line; a failure or a refusal keeps its own. */
const groupClass = (t: TraceTool): string => (t.state === 'ok' ? 'ok' : t.state === 'run' || t.state === 'ask' || t.state === 'queued' ? 'live' : `solo:${t.id}`)

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)]

function toolDetail(t: TraceTool, a: Act, now: number): string {
  const parts: string[] = []
  if (a.raw !== '') parts.push(a.raw)
  const ran = t.state === 'ok' || t.state === 'fail' || t.state === 'run' ? runMs(t, now) : undefined
  if (ran !== undefined) parts.push(`${(ran / 1000).toFixed(1)}s`)
  if (t.verdict !== undefined) parts.push(t.verdict)
  const wait = waitMs(t, now)
  const split = judgeSplit(t, now)
  if (t.isPrompted === true) parts.push(`사람 승인 ${(wait / 1000).toFixed(1)}s`)
  else if (split !== undefined && 'judge' in split) parts.push(`자동 판정 ${(split.judge / 1000).toFixed(1)}s`)
  else if (split !== undefined) parts.push(`판정·실행${split.isRunning ? ' 중' : ''} ${(split.mixed / 1000).toFixed(1)}s`)

  return parts.join(' · ')
}

/** Calls made the same way (same tool, like input) read as one; digits and spaces aside. */
const callKey = (t: TraceTool, a: Act): string => `${t.name} ${a.raw.replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 80)}`

/**
 * How an auto-judged call's time splits. `tool.check` says a verdict was asked
 * for, not when it settled and the run began: until the call ends with its run
 * time (PostToolUse `duration_ms`), the decider's wait and the run are one span,
 * told neutrally and never flagged.
 */
export type JudgeSplit = { judge: number; run: number } | { mixed: number; isRunning: boolean }

export function judgeSplit(t: TraceTool, now: number): JudgeSplit | undefined {
  if (t.isAsked !== true || t.isPrompted === true || t.startedAt === undefined) return undefined
  if (t.endedAt !== undefined && t.execMs !== undefined) {
    return { judge: Math.max(0, t.endedAt - t.startedAt - t.execMs), run: t.execMs }
  }
  const isRunning = t.endedAt === undefined && (t.state === 'ask' || t.state === 'run')
  const end = t.endedAt ?? (isRunning ? now : undefined)
  if (end === undefined) return undefined

  return { mixed: Math.max(0, end - t.startedAt), isRunning }
}

/** The neutral words for a span the API cannot split: '판정·실행 중 12초'. */
export function mixedText(m: { mixed: number; isRunning: boolean }): string {
  const ms = fmtKo(m.mixed)
  return ms === '' ? '' : `판정·실행${m.isRunning ? ' 중' : ''} ${ms}`
}

export type FlowOptions = {
  now: number
  w: Where
  isExpanded: boolean
  notes?: readonly string[]
  compactions?: TraceTurn['compactions']
  isLive: boolean
  /** Calls whose subagent still runs (an Agent call answers at once for a background agent). */
  runningCalls?: ReadonlySet<string>
}

/** The steps' story as lines, oldest first: what was said, what was done, where it got stuck. */
export function buildFlow(steps: readonly TraceStep[], o: FlowOptions): FlowLine[] {
  const lines: FlowLine[] = []
  /** The entries each action line holds, for the signals placed after it. */
  const held = new Map<FlowLine, Entry[]>()
  const readCount = new Map<string, number>()
  const failCount = new Map<string, number>()
  let searchRun: Entry[] = []
  let searchLine: FlowLine | undefined
  const after = new Map<FlowLine, FlowLine[]>()
  const addAfter = (line: FlowLine, s: FlowLine): void => {
    after.set(line, [...(after.get(line) ?? []), s])
  }
  const signal = (mark: Mark, label: string, targets: string[], hint?: string): FlowLine => {
    const line: FlowLine = { mark, tone: mark === '✗' ? 'bad' : 'warn', label, targets, details: [], isSignal: true }
    if (hint !== undefined) line.hint = hint
    return line
  }
  let last: FlowLine | undefined
  let lastKind = ''
  let lastClass = ''
  const running = o.runningCalls ?? new Set<string>()
  const toneOf = (t: TraceTool): { mark: Mark; tone: FlowLine['tone'] } => (t.state === 'ok' && running.has(t.id) ? { mark: '●', tone: 'live' } : stateTone(t))
  const classOf = (t: TraceTool): string => (t.state === 'ok' && running.has(t.id) ? `solo:${t.id}` : groupClass(t))

  for (const s of steps) {
    if (o.isExpanded) {
      const head = [s.index >= 0 ? `#${s.index + 1}` : '#?', s.model === '' ? '' : `${s.model.replace(/^claude-/, '')}${s.effort === undefined ? '' : `/${s.effort}`}`]
      if (s.contextTokens !== undefined) head.push(`ctx ${(s.contextTokens / 1000).toFixed(1)}k`)
      if (s.outputTokens !== undefined) head.push(`out ${s.outputTokens}`)
      const step: FlowLine = { mark: '·', tone: 'idle', label: head.filter(p => p !== '').join(' · '), targets: [], details: [], isStep: true }
      const thought = s.thinking.replace(/\s+/g, ' ').trim()
      if (thought !== '') step.details.push(`생각 끝부분: …${thought.slice(-160)}`)
      lines.push(step)
      last = undefined
    }
    const first = s.firstAt ?? (s.phase === 'request' ? o.now : undefined)
    if (first !== undefined && first - s.startedAt >= BLOCK.firstChunkMs) {
      lines.push(signal('!', `응답 대기 ${fmtKo(first - s.startedAt)}`, []))
      last = undefined
    }
    const said = s.said.split('\n').map(l => l.trim()).find(l => l !== '')
    if (said !== undefined && (s.tools.length > 0 || s.phase === 'done' || s.phase === 'failed')) {
      lines.push({ mark: '»', tone: 'say', label: said, targets: [], details: [] })
      last = undefined
    }
    const thinkMs = (s.thinkMs ?? 0) + (s.phase === 'think' ? o.now - s.phaseAt : 0)
    const stepFirstLine = lines.length
    const entries: Entry[] = s.tools.map(tool => ({ tool, act: actOf(tool, o.w), step: s }))
    // Calls the step sent together, of one kind, read as one line.
    const byKind = new Map<string, Entry[]>()
    for (const en of entries) {
      const key = `${en.act.kind}|${classOf(en.tool)}`
      byKind.set(key, [...(byKind.get(key) ?? []), en])
    }
    const placed = new Set<Entry>()
    for (const en of entries) {
      if (placed.has(en)) continue
      const group = byKind.get(`${en.act.kind}|${classOf(en.tool)}`) ?? [en]
      for (const g of group) placed.add(g)
      const { mark, tone } = toneOf(en.tool)
      const cls = classOf(en.tool)
      const targets = uniq(group.flatMap(g => g.act.targets))
      const details = o.isExpanded ? group.map(g => toolDetail(g.tool, g.act, o.now)) : []
      const canJoin = last !== undefined && group.length === 1 && lastKind === en.act.kind && lastClass === cls && !cls.startsWith('solo')
      if (canJoin && last !== undefined) {
        // In a row, the same kind of action: one line, counted.
        const prev = held.get(last) ?? []
        const all = [...prev, en]
        held.set(last, all)
        last.label = en.act.kind === 'search' ? `검색 ×${all.length}` : `${baseLabel(en.act)} ×${all.length}`
        last.targets = en.act.kind === 'search' ? uniq(all.map(a => `"${oneLine(a.act.pattern ?? '', 12)}"`)) : uniq([...last.targets, ...targets])
        last.details.push(...details)
      } else {
        const label = group.length > 1 ? `${group.length}개 동시 ${baseLabel(en.act)}` : en.act.label
        const line: FlowLine = { mark, tone, label, targets, details }
        if ((en.tool.state === 'fail' || en.tool.state === 'deny' || en.tool.state === 'stop') && en.tool.note !== undefined && en.tool.note !== '') {
          line.reason = en.tool.note
        }
        lines.push(line)
        held.set(line, group.slice())
        last = line
        lastKind = en.act.kind
        lastClass = cls
      }
      const line = last ?? lines[lines.length - 1]
      if (line === undefined) continue
      for (const g of group) {
        const t = g.tool
        // The same file read again (a search over it is no read).
        if ((t.state === 'ok' || t.state === 'run') && isRead(g.act)) {
          for (const f of g.act.files) {
            const n = (readCount.get(f) ?? 0) + 1
            readCount.set(f, n)
            if (n >= BLOCK.rereadFrom) addAfter(line, signal('!', `같은 파일 ${n}번째`, [baseName(f)], HINT.reread))
          }
        }
        // Searches in a row.
        if (g.act.kind === 'search') {
          searchRun.push(g)
          searchLine = line
        } else {
          flushSearch()
        }
        // The same call failing again.
        if (t.state === 'fail') {
          const key = callKey(t, g.act)
          const n = (failCount.get(key) ?? 0) + 1
          failCount.set(key, n)
          if (n >= BLOCK.retryFails) addAfter(line, signal('✗', `실패 후 재시도 ${n}번`, [g.act.targets[0] ?? oneLine(g.act.raw, 30)], HINT.retry))
        }
        const wait = waitMs(t, o.now)
        const split = judgeSplit(t, o.now)
        if (split !== undefined && 'mixed' in split) {
          // Judge and run not yet told apart: the time is said, nothing is flagged.
          const text = mixedText(split)
          if (text !== '') line.note = text
        }
        if (t.isPrompted === true && wait >= BLOCK.humanWaitMs) {
          addAfter(line, signal('!', `사람 승인 ${fmtKo(wait)}`, [g.act.targets[0] ?? g.act.label], isIntended(t) ? HINT.intended : HINT.humanWait))
        } else if (split !== undefined && 'judge' in split && split.judge >= BLOCK.judgeMs) {
          addAfter(line, signal('!', `자동 판정 ${fmtKo(split.judge)}`, [g.act.targets[0] ?? g.act.label], HINT.judge))
        }
        if ((t.state === 'ok' || t.state === 'fail' || t.state === 'run') && (split === undefined || 'judge' in split)) {
          const ran = runMs(t, o.now)
          if (ran >= BLOCK.toolMs) addAfter(line, signal('!', `오래 걸림 ${fmtKo(ran)}`, [g.act.targets[0] ?? g.act.label], HINT.slowTool))
        }
      }
    }
    if (thinkMs >= BLOCK.thinkMs && entries.length > 0) {
      const at = lines[stepFirstLine]
      const sig = signal('!', `${fmtKo(thinkMs)} 고민 후 선택`, [entries[0]?.tool.name ?? ''], HINT.think)
      if (at !== undefined) lines.splice(stepFirstLine, 0, sig)
    }
    if (s.stop === 'max_tokens') lines.push(signal('!', '출력 한도에 걸려 잘림', []))
    if (s.stop === 'model_context_window_exceeded') lines.push(signal('✗', '컨텍스트 창을 넘김', []))
    if (s.stop === 'refusal') lines.push(signal('✗', '모델이 응답을 거절함', []))
    if (s.phase === 'failed') lines.push(signal('✗', '모델 요청이 끝나지 못함', []))
    // A request that ended badly breaks the run of like actions; one that picked tools goes on with it.
    if ((s.stop !== undefined && s.stop !== 'tool_use' && s.stop !== 'end_turn') || s.phase === 'failed') last = undefined
  }
  flushSearch()

  function flushSearch(): void {
    if (searchRun.length >= BLOCK.searchRun && searchLine !== undefined) {
      const pats = uniq(searchRun.map(e => `"${oneLine(e.act.pattern ?? '', 10)}"`))
      addAfter(searchLine, signal('!', `검색 ${searchRun.length}번 연달아`, pats.length > 2 ? [...pats.slice(0, 2), '…'] : pats, HINT.searchRun))
    }
    searchRun = []
    searchLine = undefined
  }

  for (const c of o.compactions ?? []) {
    const ms = (c.endedAt ?? o.now) - c.startedAt
    const how = c.trigger === 'auto' ? '자동' : c.trigger === 'manual' ? '수동' : c.trigger
    lines.push(signal('!', `컨텍스트 압축${c.endedAt === undefined ? ' 중' : ''} ${fmtKo(ms)}`.trim() + ` (${how})`, []))
  }
  for (const note of o.notes ?? []) {
    if (/^API 오류/.test(note)) lines.push(signal('✗', note, []))
  }

  // The signals go right under the line they are about.
  const out: FlowLine[] = []
  for (const line of lines) {
    out.push(line)
    for (const s of after.get(line) ?? []) out.push(s)
  }
  const live = liveLine(steps, o)
  if (live !== undefined) out.push(live)

  return out
}

/** The dialog was asked for on purpose: a classic hook reached the verdict, or an ask rule matched. */
export const isIntended = (t: TraceTool): boolean =>
  t.check !== undefined && (t.check.hook !== undefined || (t.check.decision === 'ask' && t.check.rule !== undefined))

const READ_KINDS = new Set(['read', 'partial', 'memory', 'skilldoc', 'guide'])
const isRead = (a: Act): boolean => READ_KINDS.has(a.kind) || (a.kind.startsWith('bash:') && a.label.split('·').includes('읽음'))

/** An action's label without what it was about: "검색", not "검색 \"x\"". */
function baseLabel(a: Act): string {
  if (a.kind === 'search') return '검색'
  if (a.kind === 'find') return '파일 찾기'
  return a.label
}

/** What the model is doing at the end of the flow, while it writes or thinks. */
function liveLine(steps: readonly TraceStep[], o: FlowOptions): FlowLine | undefined {
  if (!o.isLive) return undefined
  const s = steps[steps.length - 1]
  if (s === undefined) return undefined
  const since = fmtKo(o.now - s.phaseAt)
  const at = since === '' ? '' : ` · ${since}`
  switch (s.phase) {
    case 'request':
      return { mark: '●', tone: 'live', label: `응답 기다리는 중${at}`, targets: [], details: [] }
    case 'think':
      return { mark: '●', tone: 'live', label: `생각 중${at}`, targets: [], details: [] }
    case 'write':
      return { mark: '●', tone: 'live', label: `답변 쓰는 중${at}`, targets: [], details: [] }
    case 'input':
      return { mark: '●', tone: 'live', label: `${s.inputTool ?? '도구'} 입력 쓰는 중${at}`, targets: [], details: [] }
    default:
      return undefined
  }
}

/** The newest lines that fit, the older folded into one line on top. */
export function foldFlow(lines: readonly FlowLine[], room: number): { folded: number; shown: FlowLine[] } {
  if (lines.length <= room) return { folded: 0, shown: lines.slice() }
  const keep = Math.max(1, room - 1)

  return { folded: lines.length - keep, shown: lines.slice(-keep) }
}

// ---- the files the turn looked at ----

export type RefRow = { label: string; items: string[] }
export type Refs = { count: number; rows: RefRow[]; web: string[] }

/** The files read, searched or compared, by folder; a folder with one file goes under 그 밖. */
export function refsOf(steps: readonly TraceStep[], w: Where): Refs {
  const seen = new Map<string, number>()
  const web: string[] = []
  for (const s of steps) {
    for (const t of s.tools) {
      if (t.state === 'deny' || t.state === 'queued') continue
      const a = actOf(t, w)
      for (const f of a.files) seen.set(f, (seen.get(f) ?? 0) + 1)
      for (const u of a.urls) if (!web.includes(u)) web.push(u)
    }
  }
  const byDir = new Map<string, string[]>()
  for (const f of seen.keys()) {
    const d = dirOf(f)
    byDir.set(d, [...(byDir.get(d) ?? []), f])
  }
  const rows: RefRow[] = []
  const rest: string[] = []
  const item = (f: string): string => {
    const n = seen.get(f) ?? 1
    return n > 1 ? `${baseName(f)} ×${n}` : baseName(f)
  }
  for (const [d, files] of byDir) {
    if (files.length < 2) {
      rest.push(...files)
      continue
    }
    rows.push({ label: dirLabel(d, w), items: files.map(item) })
  }
  if (rest.length > 0) rows.push({ label: rows.length === 0 ? '' : '그 밖', items: rest.map(item) })

  return { count: seen.size, rows, web: web.map(u => oneLine(u.replace(/^https?:\/\//, ''), 50)) }
}

/** A folder named by its last two parts (`work-trace/hooks`), from the cwd or home where it lies under one. */
function dirLabel(d: string, w: Where): string {
  const p = shortPath(d, w, 1000)
  if (p === '.') return '.'
  const parts = p.split('/').filter(x => x !== '')

  return parts.length <= 2 ? p : parts.slice(-2).join('/')
}

/** Wraps items, joined by ' · ', into lines of `cells` columns. */
export function wrapItems(items: readonly string[], cells: number): string[] {
  const out: string[] = []
  let cur = ''
  let used = 0
  for (const it of items) {
    const w = textCells(it)
    const add = cur === '' ? w : w + 3
    if (cur !== '' && used + add > cells) {
      out.push(cur)
      cur = it
      used = w
      continue
    }
    cur = cur === '' ? it : `${cur} · ${it}`
    used += add
  }
  if (cur !== '') out.push(cur)

  return out
}

export function textCells(text: string): number {
  let n = 0
  for (const ch of text) n += cellWidth(ch)
  return n
}

/** `text` padded with spaces to `cells` columns. */
export function padCells(text: string, cells: number): string {
  const w = textCells(text)
  return w >= cells ? text : text + ' '.repeat(cells - w)
}

// ---- where the turn's time went ----

export type TimeItem = { label: string; ms: number }

/** Union length of time intervals. */
function unionMs(spans: [number, number][]): number {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  let total = 0
  let curA = -Infinity
  let curB = -Infinity
  for (const [a, b] of sorted) {
    if (a > curB) {
      if (curB > curA) total += curB - curA
      curA = a
      curB = b
    } else if (b > curB) {
      curB = b
    }
  }
  if (curB > curA) total += curB - curA

  return total
}

/** The turn's time by what it went on: thinking, waiting on the model, writing, tools, the person, the decider, compaction. */
export function timeOf(steps: readonly TraceStep[], now: number, compactions: TraceTurn['compactions'] = []): TimeItem[] {
  let think = 0
  let wait = 0
  let write = 0
  let human = 0
  let judge = 0
  let mixed = 0
  let isMixedRunning = false
  const spans: [number, number][] = []
  for (const s of steps) {
    const isOpen = s.phase !== 'done' && s.phase !== 'failed'
    think += (s.thinkMs ?? 0) + (isOpen && s.phase === 'think' ? now - s.phaseAt : 0)
    write += (s.writeMs ?? 0) + (isOpen && (s.phase === 'write' || s.phase === 'input') ? now - s.phaseAt : 0)
    if (s.index >= 0) {
      const first = s.firstAt ?? (s.phase === 'request' ? now : (s.endedAt ?? s.startedAt))
      wait += Math.max(0, first - s.startedAt)
    }
    for (const t of s.tools) {
      const split = judgeSplit(t, now)
      if (split !== undefined && 'mixed' in split) {
        // Judge and run not told apart: one neutral span, neither the decider's nor the tool's.
        mixed += split.mixed
        if (split.isRunning) isMixedRunning = true
        continue
      }
      const w = waitMs(t, now)
      if (t.isPrompted === true) human += w
      else if (split !== undefined) judge += split.judge
      if (t.startedAt === undefined) continue
      const end = t.endedAt ?? (t.state === 'run' || t.state === 'ask' ? now : undefined)
      if (end === undefined) continue
      const start = t.execMs !== undefined && t.endedAt !== undefined ? t.endedAt - t.execMs : t.startedAt + (t.isPrompted === true || t.isAsked === true ? w : 0)
      spans.push([start, end])
    }
  }
  const compact = (compactions ?? []).reduce((sum, c) => sum + ((c.endedAt ?? now) - c.startedAt), 0)

  return [
    { label: '생각', ms: think },
    { label: '응답 대기', ms: wait },
    { label: '답변 작성', ms: write },
    { label: '도구', ms: unionMs(spans) },
    { label: '승인 대기', ms: human },
    { label: '자동 판정', ms: judge },
    { label: isMixedRunning ? '판정·실행 중' : '판정·실행', ms: mixed },
    { label: '컨텍스트 압축', ms: compact },
  ]
}

/** The items worth a word (a second or more), the largest with a bar of `width` cells. */
export function timeLine(items: readonly TimeItem[], width = 10): string {
  const shown = items.filter(i => i.ms >= 1000)
  if (shown.length === 0) return ''
  const total = shown.reduce((s, i) => s + i.ms, 0)
  const top = shown.reduce((a, b) => (b.ms > a.ms ? b : a))

  return shown
    .map(i => {
      if (i !== top) return `${i.label} ${fmtKo(i.ms)}`
      const filled = Math.max(1, Math.min(width, Math.round((i.ms / total) * width)))
      return `${i.label} ${fmtKo(i.ms)} ${'━'.repeat(filled)}${'─'.repeat(width - filled)}`
    })
    .join(' · ')
}

// ---- the harness the turn touched ----

export type Harness = {
  skills: string[]
  /** Verdicts a classic hook reached, calls a hook refused, results a PostToolUse hook added to. */
  hooks: number
  hookDetails: string[]
  tools: number
  autoAllowed: number
  prompted: number
  promptedMs: number
  denied: number
  memory: number
}

export function harnessOf(steps: readonly TraceStep[], agents: readonly TraceAgent[], since: number, now: number, w: Where): Harness {
  const h: Harness = { skills: [], hooks: 0, hookDetails: [], tools: 0, autoAllowed: 0, prompted: 0, promptedMs: 0, denied: 0, memory: 0 }
  for (const s of steps) {
    for (const t of s.tools) {
      if (t.state === 'queued') continue
      h.tools += 1
      const a = actOf(t, w)
      if (t.name === 'Skill') {
        const name = typeof t.input?.skill === 'string' ? t.input.skill : '?'
        if (!h.skills.includes(name)) h.skills.push(name)
      }
      if (a.isMemory) h.memory += 1
      if (t.check?.hook !== undefined) {
        h.hooks += 1
        h.hookDetails.push(`${t.check.hook} → ${t.check.decision} · ${a.label}`)
      } else if (t.state === 'deny' && t.verdict !== '자동 모드가 거부' && t.check?.decision !== 'deny' && t.isPrompted !== true && t.note !== '사용자가 거절함') {
        h.hooks += 1
        h.hookDetails.push(`차단 · ${a.label}${t.note === undefined ? '' : ` · ${oneLine(t.note, 60)}`}`)
      }
      if (t.hookContext !== undefined) {
        h.hooks += 1
        h.hookDetails.push(`PostToolUse 내용 추가 ${t.hookContext} · ${a.label}`)
      }
      if (t.state === 'deny') h.denied += 1
      else if (t.isPrompted === true) {
        h.prompted += 1
        h.promptedMs += waitMs(t, now)
      } else h.autoAllowed += 1
    }
  }
  for (const a of agents) {
    if (a.source === 'skill' && a.startedAt >= since && !h.skills.some(s => a.type.includes(s))) h.skills.push(a.type.replace(/^\//, ''))
  }

  return h
}

export function harnessLine(h: Harness): string {
  const parts = [`스킬 ${h.skills.length}${h.skills.length > 0 ? ` (${h.skills.slice(0, 3).join(', ')}${h.skills.length > 3 ? '…' : ''})` : ''}`, `훅 개입 ${h.hooks}`]
  if (h.tools > 0 && h.prompted === 0 && h.denied === 0) parts.push(`도구 ${h.tools}번 모두 자동 허용`)
  else if (h.tools > 0) {
    parts.push(`자동 허용 ${h.autoAllowed}`)
    parts.push(`사람 승인 ${h.prompted}${h.prompted > 0 ? ` (${fmtKo0(h.promptedMs)})` : ''}`)
    parts.push(`거부 ${h.denied}`)
  }
  if (h.memory > 0) parts.push(`메모리 ${h.memory}`)

  return parts.join(' · ')
}

// ---- the header: what runs now ----

export type Now = { label: string; since?: number; tone: 'busy' | 'think' | 'wait' | 'idle' | 'ok' | 'bad'; detail?: string; slowAfter?: number; stuckAfter?: number }

const ENDED: Record<string, { label: string; tone: Now['tone'] }> = {
  answer: { label: '완료 · 입력 대기 중', tone: 'ok' },
  done: { label: '완료', tone: 'ok' },
  aborted: { label: '중단됨', tone: 'bad' },
  refusal: { label: '모델이 거절하고 끝남', tone: 'bad' },
  error: { label: 'API 오류로 끝남', tone: 'bad' },
}

/** What the loop is doing now, and since when, in the flow's words. */
export function nowOf(steps: readonly TraceStep[], end: { isEnded: boolean; outcome?: string } | undefined, compactSince: number | null, w: Where): Now {
  if (compactSince !== null) return { label: '컨텍스트 압축 중', since: compactSince, tone: 'wait', slowAfter: 60, stuckAfter: 180 }
  const recent = steps.slice(-4)
  const live = recent.flatMap(s => s.tools.filter(t => t.state === 'run' || t.state === 'ask' || t.state === 'wait'))
  const waiting = live.find(t => t.state === 'wait')
  if (waiting !== undefined) {
    const a = actOf(waiting, w)
    return { label: '사람 승인 기다리는 중', detail: `${a.label}${a.targets.length > 0 ? ` ${a.targets.join(' · ')}` : ''}`, since: waiting.promptedAt ?? waiting.startedAt, tone: 'wait' }
  }
  if (live.length === 1 && live[0] !== undefined) {
    const t = live[0]
    const a = actOf(t, w)
    // No event marks the verdict settled and the run begun: an asked call is one or the other.
    const label = t.state === 'ask' ? `승인 판정 또는 ${a.progress}` : a.progress
    return { label, detail: a.targets.join(' · '), since: t.startedAt ?? t.queuedAt, tone: 'busy', slowAfter: 30, stuckAfter: 120 }
  }
  if (live.length > 1) {
    return { label: `도구 ${live.length}개 동시 실행 중`, since: Math.min(...live.map(t => t.startedAt ?? t.queuedAt)), tone: 'busy', slowAfter: 30, stuckAfter: 120 }
  }
  if (end?.isEnded === true) {
    const known = ENDED[end.outcome ?? 'done'] ?? { label: `끝남 (${end.outcome ?? '?'})`, tone: 'idle' as const }
    return { label: known.label, tone: known.tone }
  }
  const last = steps[steps.length - 1]
  if (last !== undefined) {
    switch (last.phase) {
      case 'request':
        return { label: '응답 기다리는 중', since: last.startedAt, tone: 'think', slowAfter: 20, stuckAfter: 60 }
      case 'think':
        return { label: '생각 중', since: last.phaseAt, tone: 'think', slowAfter: 90, stuckAfter: 300 }
      case 'write':
        return { label: '답변 쓰는 중', since: last.phaseAt, tone: 'think', slowAfter: 90, stuckAfter: 300 }
      case 'input':
        return { label: `${last.inputTool ?? '도구'} 입력 쓰는 중`, since: last.phaseAt, tone: 'think', slowAfter: 60, stuckAfter: 240 }
      default:
        break
    }
    if (last.tools.some(t => t.state === 'queued')) return { label: '도구 실행 준비 중', since: last.endedAt ?? last.phaseAt, tone: 'busy', slowAfter: 15, stuckAfter: 60 }
    if (end !== undefined) {
      const lastToolEnd = Math.max(0, ...last.tools.map(t => t.endedAt ?? 0))
      return { label: '다음 단계 준비 중', since: Math.max(last.endedAt ?? last.phaseAt, lastToolEnd), tone: 'think', slowAfter: 20, stuckAfter: 60 }
    }
  }

  return { label: '대기 중', tone: 'idle' }
}

/** The steps of the turn shown: the main loop's latest turn, or a subagent's whole run. */
export function turnSteps(steps: readonly TraceStep[], loop: string, turn: TraceTurn | undefined): TraceStep[] {
  const own = steps.filter(s => s.loop === loop)
  return loop === MAIN && turn !== undefined ? own.filter(s => s.turnId === turn.turnId || (s.index < 0 && s.startedAt >= turn.startedAt)) : own
}

/** The files the turn changed: those whose edits came from its calls. */
export function changedIn(steps: readonly TraceStep[], files: readonly TraceFile[]): number {
  const ids = new Set(steps.flatMap(s => s.tools.map(t => t.id)))
  return files.filter(f => f.edits.some(e => ids.has(e.toolUseId))).length
}
