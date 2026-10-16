// Shared reader for the PreToolUse(Bash) hooks: which parts of a command string would the shell actually run?
// scan(src) splits it into simple commands (quoting, $(...), backticks, heredocs, subshells understood) and keeps,
// per command, only the text that can run something. Data is left out: echo/grep/printf arguments, commit messages,
// heredoc bodies fed to cat/tee, interpreter code that has no process API.
// Whatever it cannot read safely (a computed command name, a script file run in the same command, data piped into
// a shell) sets `fallback`, and callers go back to checking the whole text. Parse errors throw; callers do the same.
// mentions(src, re) is the one-call form: does `re` match anything the command would run?

const META = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);
const VAR_START = /[A-Za-z_0-9@*#?$!-]/;
const MAX_NEST = 40;
const FN_DEF = /\(\s*\)/y;

export const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh"]);
const RESERVED = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time", "coproc", "esac"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

// Commands whose arguments and stdin are only data. A few options that run a program take them off the list.
const SAFE = new Set([
  "echo", "printf", "grep", "egrep", "fgrep", "rg", "ag", "ack", "cat", "tee", "head", "tail", "wc", "sort", "uniq",
  "cut", "tr", "ls", "touch", "mkdir", "rmdir", "cp", "mv", "rm", "ln", "diff", "cmp", "comm", "jq", "column", "fold",
  "nl", "rev", "tac", "file", "stat", "basename", "dirname", "realpath", "readlink", "pwd", "cd", "pushd", "popd",
  "true", "false", ":", "test", "[", "[[", "sleep", "date", "which", "whoami", "hostname", "uname", "pbcopy", "du",
  "df", "tree", "shasum", "md5", "md5sum", "sha256sum", "for", "select", "case", "exit", "return", "shift", "set", "wait",
]);
const SAFE_UNLESS = { printf: /^-v/, rg: /^--pre/, sort: /^--compress-prog/ };
const GIT_SAFE = new Set(["add", "blame", "branch", "commit", "describe", "diff", "log", "ls-files", "notes", "reflog", "rev-parse", "shortlog", "show", "stash", "status", "tag"]);
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path", "--super-prefix"]);
const GH_SAFE = new Set(["pr", "issue"].flatMap((o) =>
  ["create", "comment", "edit", "view", "list", "diff", "checks", "status", "close", "reopen", "review"].map((v) => `${o} ${v}`)));

// Wrappers that run the rest of their arguments as a command: [options taking a value, positional args before the command].
const WRAPPERS = {
  env: { val: ["-u", "--unset", "-C", "--chdir", "-P"], stop: /^(-S|--split-string)/, assigns: true },
  sudo: { val: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "-R", "--user", "--group", "--host", "--prompt", "--chdir", "--role", "--type", "--other-user", "--chroot"] },
  doas: { val: ["-u", "-C"] },
  nohup: {}, builtin: {}, command: {}, time: {},
  exec: { val: ["-a"] },
  nice: { val: ["-n", "--adjustment"] },
  timeout: { val: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  gtimeout: { val: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  stdbuf: { val: ["-i", "-o", "-e"] },
  caffeinate: { val: ["-t", "-w"] },
};

// Interpreters: option whose value is code, options taking a value, and the APIs through which code can start a process.
const INTERP = [
  [/^python[\d.]*$/, "python"], [/^(node|nodejs)$/, "node"], [/^perl[\d.]*$/, "perl"], [/^ruby[\d.]*$/, "ruby"],
  [/^(awk|gawk|mawk|nawk)$/, "awk"], [/^php[\d.]*$/, "php"],
];
const CODE_OPT = { python: /^-[A-Za-z]*c$/, node: /^(-e|--eval|-p|--print|-pe)$/, perl: /^-[A-Za-z]*[eE]$/, ruby: /^-[A-Za-z]*e$/, php: /^-r$/, awk: /^$/ };
const VALUE_OPT = {
  python: new Set(["-W", "-X", "-Q"]), node: new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions"]),
  perl: new Set(["-I"]), ruby: new Set(["-I", "-r", "-C", "-E"]), php: new Set(["-d", "-c"]), awk: new Set(["-F", "-v"]),
};
export const EXEC_API = {
  python: /\bsubprocess\b|\bos\s*\.\s*(system|popen|exec\w*|spawn\w*|posix_spawn\w*|fork\w*)\b|\.\s*(system|popen|exec[lv]\w*|spawn\w*|posix_spawn\w*|fork|forkpty)\s*\(|\b(pty|posix|ctypes|multiprocessing|importlib|runpy|pexpect|plumbum|commands|webbrowser)\b|__import__|__builtins__|__dict__|(?<![.\w])(exec|eval|compile|getattr|globals|vars|breakpoint)\s*\(|\bfrom\s+(os|posix)\s+import\b|\bimport\s+\*/,
  node: /\bchild_process\b|\b(execSync|execFileSync|execFile|spawnSync|spawn|fork|exec)\s*\(|\b(require|import|eval|Function)\s*\(|\bimport\b|\bprocess\s*(\.\s*(binding|dlopen)|\[)|\b(vm|worker_threads|Deno|Bun|globalThis|constructor)\b/,
  perl: /\b(system|exec|qx|open\d*|eval|fork|pipe|do|require|use|syscall|IPC|readpipe)\b|`|%x/,
  ruby: /\b(system|exec|spawn|popen\w*|Open3|Process|fork|eval|instance_eval|class_eval|open|send|__send__|public_send|Kernel|IO|PTY|require|load|syscall|method)\b|`|%x/,
  awk: /\b(system|getline)\b|(^|[^|])\|(?!\|)|\|&/,
  php: /\b(system|exec|shell_exec|passthru|popen|proc_open|pcntl_\w+|eval|assert|create_function|call_user_func\w*|include|require)\b|`/,
};

// A word that may name a script file being run (bash x.sh, ./x, source x, python x.py ...), even inside a -c string.
const SCRIPTY = /(^|[\s;&|(`'"])(\.{1,2}\/|~\/)|(^|[\s;&|(`'"])(source|\.)\s+\S|\.(sh|bash|zsh|command|py|js|mjs|cjs|ts|pl|rb|php)\b|(^|[\s;&|(`'"])((ba|z|da|k|fi)?sh|python[\d.]*|node|perl|ruby|php)(\s|$)/;
// Files whose text something runs later on its own: git hooks, shell startup files, direnv, Claude Code hooks/settings.
const AUTORUN = /(^|\/)(\.git\/hooks|\.husky|\.claude\/hooks)(\/|$)|(^|\/)\.claude\/settings[\w.-]*\.json$|(^|\/)\.(zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|bash_login|profile|envrc)$/;
const AUTORUN_IN_TEXT = /(\.git\/hooks|\.husky|\.claude\/hooks)\/|\.claude\/settings[\w.-]*\.json|\.(zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|bash_login|profile|envrc)\b/;
const WRITERS = new Set(["tee", "cp", "mv", "ln", "install", "rsync", "dd"]);

const base = (v) => v.slice(v.lastIndexOf("/") + 1);
const literal = (w) => (w && !w.quoted && !w.dyn ? w.value : null);
const rawText = (ws) => `${ws.map((w) => w.raw).join(" ")}\n${ws.map((w) => w.value).join(" ")}`;

class Parser {
  constructor(src, fed = false) {
    this.s = src; this.i = 0; this.lastEnd = -1; this.nest = 0;
    this.cmds = []; this.frags = []; this.cur = null; this.pending = [];
    this.stage = 0; this.fed = fed ? 1 : 0; this.braces = []; this.scope = ""; this.gid = 0;
  }

  fail(m) { throw new Error(m); }
  cmd() { return (this.cur ??= { words: [], redirs: [], stdin: [], frags: [], stage: this.stage, scope: this.scope, fed: false, sep: null }); }
  frag(f) { this.frags.push(f); this.cmd().frags.push(f); }

  parse() {
    this.parseList(null);
    if (this.pending.length) this.fail(`unterminated heredoc ${this.pending[0].delim}`);
    return this;
  }

  skipBlank() {
    for (;;) {
      const c = this.s[this.i];
      if (c === " " || c === "\t") this.i++;
      else if (c === "\\" && this.s[this.i + 1] === "\n") this.i += 2;
      else return;
    }
  }

  endCommand(sep) {
    const c = this.cur;
    this.cur = null;
    if (c) {
      const first = literal(c.words[0]);
      if (first === "}" && this.braces.pop()) this.fed--;
      c.fed = c.stage > 0 || this.fed > 0;
      if (first === "{") { this.braces.push(c.fed); if (c.fed) this.fed++; }
      c.sep = sep;
      this.cmds.push(c);
    }
    if (sep === "|" || sep === "|&") this.stage++; else this.stage = 0;
  }

  parseList(term) {
    const s = this.s;
    for (;;) {
      this.skipBlank();
      if (this.i >= s.length) { if (term) this.fail("unterminated ("); this.endCommand(null); return; }
      const c = s[this.i], n = s[this.i + 1];
      if (c === ")") { if (!term) this.fail("unexpected )"); this.i++; this.endCommand(null); return; }
      if (c === "#") { while (this.i < s.length && s[this.i] !== "\n") this.i++; continue; }
      if (c === "\n") { this.i++; this.endCommand("\n"); this.readBodies(); continue; }
      if (c === ";") { this.i += n === ";" ? (s[this.i + 2] === "&" ? 3 : 2) : n === "&" ? 2 : 1; this.endCommand(";"); continue; }
      if (c === "&") {
        if (n === "&") { this.i += 2; this.endCommand("&&"); continue; }
        if (n === ">") { this.redirect(); continue; }
        this.i++; this.endCommand("&"); continue;
      }
      if (c === "|") {
        if (n === "|") { this.i += 2; this.endCommand("||"); continue; }
        this.i += n === "&" ? 2 : 1; this.endCommand(n === "&" ? "|&" : "|"); continue;
      }
      if (c === "(") {
        const cur = this.cur;
        if (!cur || (!cur.redirs.length && cur.words.every((w) => RESERVED.has(literal(w))))) { this.group(); continue; }
        FN_DEF.lastIndex = this.i;
        if (cur.words.length === 1 && FN_DEF.test(s)) { this.i = FN_DEF.lastIndex; this.endCommand(";"); continue; } // f() { ...; }: the body follows
        this.appendParens(); continue;
      }
      if ((c === "<" || c === ">") && n !== "(") { this.redirect(); continue; }
      this.cmd().words.push(this.readWord());
    }
  }

  group() {
    if (++this.nest > MAX_NEST) this.fail("nested too deeply");
    const saved = [this.stage, this.scope, this.fed, this.braces];
    const feed = this.stage > 0 || this.fed > 0;
    this.i++;
    this.cur = null;
    this.scope = `${this.scope}${++this.gid}/`; this.stage = 0; this.braces = [];
    if (feed) this.fed++;
    this.parseList(")");
    [this.stage, this.scope, this.fed, this.braces] = saved;
    this.nest--;
  }

  redirect() {
    const s = this.s, cur = this.cmd();
    const last = cur.words[cur.words.length - 1];
    if (last && this.lastEnd === this.i && /^(\d+|\{\w+\})$/.test(last.raw)) cur.words.pop(); // 2>, {fd}>
    const op = ["&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", ">>", ">&", ">|", "<", ">"].find((o) => s.startsWith(o, this.i));
    this.i += op.length;
    this.skipBlank();
    const c = s[this.i];
    if (c === undefined || (META.has(c) && !((c === "<" || c === ">") && s[this.i + 1] === "("))) this.fail(`missing target after ${op}`);
    const target = this.readWord();
    if (op === "<<" || op === "<<-") this.pending.push({ cmd: cur, delim: target.value, quoted: target.quoted, strip: op === "<<-" });
    else if (op === "<<<") cur.stdin.push({ body: target.value });
    else cur.redirs.push({ op, target });
  }

  readBodies() {
    const s = this.s;
    for (const h of this.pending) {
      const lines = [];
      let found = false;
      while (this.i < s.length) {
        const j = s.indexOf("\n", this.i);
        const line = s.slice(this.i, j < 0 ? s.length : j);
        this.i = j < 0 ? s.length : j + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) { found = true; break; }
        lines.push(line);
      }
      if (!found) this.fail(`unterminated heredoc ${h.delim}`);
      const body = lines.join("\n");
      h.cmd.stdin.push({ body });
      if (!h.quoted) { // an unquoted heredoc still runs its $(...) and backticks
        const p = new Parser(body);
        p.nest = this.nest;
        p.expansions();
        for (const f of p.frags) { this.frags.push(f); h.cmd.frags.push(f); }
      }
    }
    this.pending = [];
  }

  expansions() {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i], n = s[this.i + 1];
      if (c === "\\") this.i += 2;
      else if (c === "`") this.readBacktick();
      else if (c === "$" && n === "(") { if (s[this.i + 2] === "(") this.readArith(); else this.readSubst(2); }
      else if (c === "$" && n === "{") this.readParam();
      else this.i++;
    }
  }

  readWord() {
    const s = this.s, w = { raw: "", value: "", subst: false, dyn: false, quoted: false };
    const add = (r, v = r) => { w.raw += r; w.value += v; };
    if ((s[this.i] === "<" || s[this.i] === ">") && s[this.i + 1] === "(") { add(this.readSubst(2, s[this.i] === ">")); w.subst = w.dyn = true; }
    while (this.i < s.length) {
      const c = s[this.i], n = s[this.i + 1];
      if (META.has(c)) break;
      if (c === "\\") {
        if (n === "\n") { this.i += 2; continue; }
        add(c + (n ?? ""), n ?? ""); w.quoted = true; this.i += 2; continue;
      }
      if (c === "'") {
        const j = s.indexOf("'", this.i + 1);
        if (j < 0) this.fail("unterminated single quote");
        add(s.slice(this.i, j + 1), s.slice(this.i + 1, j)); w.quoted = true; this.i = j + 1; continue;
      }
      if (c === '"') { this.readDouble(w); continue; }
      if (c === "`") { add(this.readBacktick()); w.subst = w.dyn = true; continue; }
      if (c === "$") {
        if (n === "'") { this.readAnsi(w); continue; }
        if (n === '"') { this.i++; w.raw += "$"; this.readDouble(w); continue; }
        if (n === "(") { add(s[this.i + 2] === "(" ? this.readArith() : this.readSubst(2)); w.subst = w.dyn = true; continue; }
        if (n === "{") { add(this.readParam()); w.dyn = true; continue; }
        if (n && VAR_START.test(n)) w.dyn = true;
      }
      add(c); this.i++;
    }
    this.lastEnd = this.i;
    return w;
  }

  readDouble(w) {
    const s = this.s, begin = this.i;
    let v = "";
    this.i++;
    for (;;) {
      if (this.i >= s.length) this.fail("unterminated double quote");
      const c = s[this.i], n = s[this.i + 1];
      if (c === '"') { this.i++; break; }
      if (c === "\\") {
        if (n !== undefined && "$`\"\\\n".includes(n)) { if (n !== "\n") v += n; this.i += 2; } else { v += c; this.i++; }
        continue;
      }
      if (c === "`") { v += this.readBacktick(); w.subst = w.dyn = true; continue; }
      if (c === "$" && n === "(") { v += s[this.i + 2] === "(" ? this.readArith() : this.readSubst(2); w.subst = w.dyn = true; continue; }
      if (c === "$" && n === "{") { v += this.readParam(); w.dyn = true; continue; }
      if (c === "$" && n && VAR_START.test(n)) w.dyn = true;
      v += c; this.i++;
    }
    w.raw += s.slice(begin, this.i); w.value += v; w.quoted = true;
  }

  readAnsi(w) {
    const s = this.s, begin = this.i;
    const map = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "?": "?" };
    let v = "";
    this.i += 2;
    for (;;) {
      if (this.i >= s.length) this.fail("unterminated $'");
      const c = s[this.i];
      if (c === "'") { this.i++; break; }
      if (c !== "\\") { v += c; this.i++; continue; }
      const rest = s.slice(this.i + 1, this.i + 10);
      const m = /^x([0-9a-fA-F]{1,2})|^u([0-9a-fA-F]{1,4})|^U([0-9a-fA-F]{1,8})|^([0-7]{1,3})/.exec(rest);
      if (m) { v += String.fromCodePoint(parseInt(m[1] ?? m[2] ?? m[3] ?? m[4], m[4] ? 8 : 16)); this.i += 1 + m[0].length; continue; }
      const n = s[this.i + 1] ?? "";
      v += map[n] ?? `\\${n}`;
      this.i += 2;
    }
    w.raw += s.slice(begin, this.i); w.value += v; w.quoted = true;
  }

  // $( ... ), <( ... ), >( ... ): parsed in full (that is how the closing paren is found), kept as a fragment to read again.
  readSubst(n, feeds = false) {
    if (++this.nest > MAX_NEST) this.fail("nested too deeply");
    const begin = this.i;
    const saved = [this.cur, this.cmds, this.frags, this.stage, this.fed, this.braces, this.scope];
    this.cur = null; this.cmds = []; this.frags = []; this.stage = 0; this.fed = 0; this.braces = [];
    this.i += n;
    this.parseList(")");
    [this.cur, this.cmds, this.frags, this.stage, this.fed, this.braces, this.scope] = saved;
    this.nest--;
    this.frag({ kind: "subst", text: this.s.slice(begin + n, this.i - 1), fed: feeds });
    return this.s.slice(begin, this.i);
  }

  // $(( ... )): arithmetic, but also how `$((cmd) ...)` starts, so the inside is kept as a fragment too.
  readArith() {
    const s = this.s, begin = this.i;
    let d = 0;
    this.i++;
    for (;;) {
      if (this.i >= s.length) this.fail("unterminated $((");
      const c = s[this.i];
      if (c === "$" && s[this.i + 1] === "(") { if (s[this.i + 2] === "(") this.readArith(); else this.readSubst(2); continue; }
      if (c === "`") { this.readBacktick(); continue; }
      if (c === "(") d++;
      else if (c === ")" && --d === 0) { this.i++; break; }
      this.i++;
    }
    this.frag({ kind: "subst", text: s.slice(begin + 2, this.i - 1), fed: false });
    return s.slice(begin, this.i);
  }

  readBacktick() {
    const s = this.s, begin = this.i;
    let j = this.i + 1;
    while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
    if (j >= s.length) this.fail("unterminated backtick");
    this.i = j + 1;
    this.frag({ kind: "subst", text: s.slice(begin + 1, j).replace(/\\([\\`$"])/g, "$1"), fed: false });
    return s.slice(begin, this.i);
  }

  readParam() {
    const s = this.s, begin = this.i;
    let d = 1;
    this.i += 2;
    while (d > 0) {
      if (this.i >= s.length) this.fail("unterminated ${");
      const c = s[this.i], n = s[this.i + 1];
      if (c === "\\") { this.i += 2; continue; }
      if (c === '"') { this.readDouble({ raw: "", value: "" }); continue; }
      if (c === "`") { this.readBacktick(); continue; }
      if (c === "$" && n === "(") { if (s[this.i + 2] === "(") this.readArith(); else this.readSubst(2); continue; }
      if (c === "$" && n === "{") { d++; this.i += 2; continue; }
      if (c === "}") d--;
      this.i++;
    }
    return s.slice(begin, this.i);
  }

  // a=(1 2), [[ x =~ (a|b) ]]: parentheses that belong to a word.
  appendParens() {
    const s = this.s, begin = this.i;
    let d = 0;
    for (;;) {
      if (this.i >= s.length) this.fail("unterminated (");
      const c = s[this.i];
      if (c === "\\") { this.i += 2; continue; }
      if (c === "'") { const j = s.indexOf("'", this.i + 1); if (j < 0) this.fail("unterminated single quote"); this.i = j + 1; continue; }
      if (c === '"') { this.readDouble({ raw: "", value: "" }); continue; }
      if (c === "`") { this.readBacktick(); continue; }
      if (c === "$" && s[this.i + 1] === "(") { if (s[this.i + 2] === "(") this.readArith(); else this.readSubst(2); continue; }
      if (c === "(") d++;
      else if (c === ")" && --d === 0) { this.i++; break; }
      this.i++;
    }
    const cur = this.cmd(), raw = s.slice(begin, this.i);
    const last = cur.words[cur.words.length - 1];
    if (last && this.lastEnd === begin) { last.raw += raw; last.value += raw; }
    else cur.words.push({ raw, value: raw, subst: false, dyn: false, quoted: false });
    this.lastEnd = this.i;
  }
}

function interpInfo(lang, words, k) {
  const n = words.length, codes = [];
  let file = false, i = k + 1;
  while (i < n) {
    const v = words[i].value;
    if (v === "--") { i++; if (i < n && !codes.length && lang !== "awk") file = true; else if (i < n && lang === "awk" && !codes.length) codes.push({ idx: i, text: words[i].value }); break; }
    if (v === "-") break; // code from stdin
    if (CODE_OPT[lang].test(v)) { if (i + 1 < n) codes.push({ idx: i + 1, text: words[i + 1].value }); i += 2; continue; }
    const eq = lang === "node" && /^--(eval|print)=([\s\S]*)$/.exec(v);
    if (eq) { codes.push({ idx: i, text: eq[2] }); i++; continue; }
    if ((lang === "python" && /^-[A-Za-z]*m$/.test(v)) || (lang === "node" && /^--(test|run)\b/.test(v)) || ((lang === "awk" || lang === "php") && v === "-f")) { file = true; break; }
    if (VALUE_OPT[lang].has(v)) { i += 2; continue; }
    if (v.startsWith("-")) { i++; continue; }
    if (lang === "awk" && !codes.length) { codes.push({ idx: i, text: v }); i++; continue; }
    if (!codes.length) file = true; // a script file; with inline code, the rest is argv / input files
    break;
  }
  return { kind: "interp", lang, codes, file, stdin: !codes.length && !file };
}

function shellInfo(words, k) {
  const n = words.length;
  let c = false, s = false, i = k + 1;
  while (i < n) {
    const v = words[i].value;
    if (v === "--") { i++; break; }
    if (["-o", "-O", "+o", "+O", "--rcfile", "--init-file"].includes(v)) { i += 2; continue; }
    if (/^[-+][A-Za-z]+$/.test(v)) { if (v[0] === "-" && v.includes("c")) c = true; if (v[0] === "-" && v.includes("s")) s = true; i++; continue; }
    if (v.startsWith("--")) { i++; continue; }
    break;
  }
  const file = !c && !s && i < n;
  return { file, stdin: !c && !file };
}

// What a simple command is: its head after reserved words, assignments and wrappers, and how its arguments are used.
export function classify(words) {
  const n = words.length;
  let k = 0;
  for (;;) {
    const lit = literal(words[k]);
    if (lit !== null && RESERVED.has(lit)) { k++; if (lit === "time" && words[k]?.value === "-p") k++; continue; }
    if (k < n && ASSIGN.test(words[k].raw)) { k++; continue; }
    const wrap = lit !== null ? WRAPPERS[base(lit)] : undefined;
    if (!wrap) break;
    if (wrap.stop && words.slice(k + 1).some((w) => wrap.stop.test(w.value))) return { kind: "other", head: k, name: base(lit) };
    k++;
    let pos = wrap.positional ?? 0;
    while (k < n) {
      const v = words[k].value;
      if (v === "--") { k++; break; }
      if (wrap.val?.includes(v)) { k += 2; continue; }
      if (v.startsWith("-") && v !== "-") { k++; continue; }
      if (wrap.assigns && ASSIGN.test(words[k].raw)) { k++; continue; }
      if (pos > 0) { pos--; k++; continue; }
      break;
    }
  }
  if (k >= n) return { kind: "empty", head: n };
  const hw = words[k];
  if (hw.dyn || hw.subst) return { kind: "dynamic", head: k };
  const name = base(hw.value);
  const lang = INTERP.find(([re]) => re.test(name))?.[1];

  if (name === "git") {
    let i = k + 1;
    while (i < n && words[i].value.startsWith("-")) i += GIT_VALUE_OPTS.has(words[i].value) ? 2 : 1;
    if (literal(words[i]) !== null && GIT_SAFE.has(words[i].value)) return { kind: "safe", head: k, name, prefixEnd: i + 1 };
    return { kind: "other", head: k, name };
  }
  if (name === "gh") {
    if (literal(words[k + 1]) !== null && literal(words[k + 2]) !== null && GH_SAFE.has(`${words[k + 1].value} ${words[k + 2].value}`)) return { kind: "safe", head: k, name, prefixEnd: k + 3 };
    return { kind: "other", head: k, name };
  }
  if (SHELLS.has(name)) return { kind: "shell", head: k, name, ...shellInfo(words, k) };
  if (lang) return { head: k, name, ...interpInfo(lang, words, k) };
  if (name === "source" || name === ".") return { kind: "source", head: k, name, file: true };
  if (hw.value.includes("/")) return { kind: "path", head: k, name, file: true };
  if (SAFE.has(name) && !(SAFE_UNLESS[name] && words.slice(k + 1).some((w) => SAFE_UNLESS[name].test(w.value)))) return { kind: "safe", head: k, name, prefixEnd: k + 1 };
  return { kind: "other", head: k, name };
}

// Can this command run what arrives on its stdin?
const runsStdin = (info) => info.kind !== "safe" && !(info.kind === "interp" && info.codes.length && !info.file && !info.codes.some((c) => EXEC_API[info.lang].test(c.text)));

/**
 * Read `src` as the shell would. Returns
 *   commands: [{ words, redirs, stdin, frags, scope, sep, info }] — simple commands in order (scope: subshell path)
 *   texts:    text per command that can run something (data arguments left out)
 *   frags:    { kind, text } — subst: $(...)/backticks/<(...) (read again with scan), shell: a heredoc a shell runs
 *             (read again with scan), code: interpreter code that uses a process API, text: stdin of a command
 *             that may run it (check as plain text)
 *   fallback: null, or why this command needs the whole-text check
 * Throws when the command cannot be parsed.
 */
export function scan(src, { fed = false } = {}) {
  const p = new Parser(String(src), fed).parse();
  const texts = [], frags = p.frags;
  let fallback = null;
  const add = (c, f) => { c.frags.push(f); frags.push(f); };
  for (const c of p.cmds) {
    const info = (c.info = classify(c.words));
    const runs = c.words.slice(info.head + 1);
    if (info.kind === "dynamic") fallback ??= "the command name is computed";
    if (info.file) fallback ??= "it runs a script file";
    if (info.kind !== "safe" && runs.some((w) => SCRIPTY.test(w.value))) fallback ??= "it may run a script file";
    if ((info.kind === "shell" || info.kind === "interp") && info.stdin && c.redirs.some((r) => r.op === "<" || r.op === "<>")) fallback ??= "it runs a script file";
    if (c.fed && runsStdin(info)) fallback ??= "it pipes data into a command that may run it";
    const writesAutorun = c.redirs.some((r) => r.op !== "<" && r.op !== "<&" && AUTORUN.test(r.target.value)) ||
      ((info.kind !== "safe" || WRITERS.has(info.name)) && runs.some((w) => AUTORUN.test(w.value))) ||
      (info.kind === "interp" && [...info.codes.map((x) => x.text), ...c.stdin.map((x) => x.body)].some((t) => AUTORUN_IN_TEXT.test(t)));
    if (writesAutorun) fallback ??= "it writes a file that runs later (hook, shell startup)";

    const redirs = c.redirs.map((r) => `${r.op} ${r.target.raw}`).join(" ");
    if (info.kind === "safe") texts.push(rawText(c.words.slice(0, info.prefixEnd)));
    else if (info.kind === "interp") {
      const codeIdx = new Set(info.codes.map((x) => x.idx));
      texts.push(`${rawText(c.words.filter((_, i) => !codeIdx.has(i)))}\n${redirs}`);
      for (const code of info.codes) if (EXEC_API[info.lang].test(code.text)) texts.push(code.text);
    } else texts.push(`${rawText(c.words)}\n${redirs}`);

    for (const { body } of c.stdin) {
      if (info.kind === "safe") continue;
      if (info.kind === "shell" && info.stdin) add(c, { kind: "shell", text: body });
      else if (info.kind === "interp" && info.stdin) { if (EXEC_API[info.lang].test(body)) add(c, { kind: "code", text: body }); }
      else if (runsStdin(info)) add(c, { kind: "text", text: body });
    }
  }
  for (const f of frags) { // tee >(bash): data written into a process substitution that may run it
    if (!f.fed || fallback) continue;
    let inner;
    try { inner = scan(f.text, { fed: true }).fallback; } catch { inner = "unparsable"; }
    if (inner) fallback = "it writes data into >(...) that may run it";
  }
  return { commands: p.cmds, texts, frags, fallback };
}

/** Would anything `src` runs match `re`? Errs toward true: on any doubt it checks the whole text, as the hooks did before. */
export function mentions(src, re, opts = {}, depth = 0) {
  src = String(src);
  if (depth > 8) return re.test(src);
  let r;
  try { r = scan(src, opts); } catch { return re.test(src); }
  if (r.fallback) return re.test(src);
  if (r.texts.some((t) => re.test(t))) return true;
  for (const f of r.frags) {
    if (f.kind === "subst" || f.kind === "shell") { if (mentions(f.text, re, { fed: f.fed }, depth + 1)) return true; }
    else if (re.test(f.text)) return true;
  }
  return false;
}
