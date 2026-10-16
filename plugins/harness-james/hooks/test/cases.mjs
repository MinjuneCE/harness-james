// Shared inputs for the hook tests and the probe/bench scripts. Nothing here is ever run as a command;
// the strings only go to the hooks as JSON on stdin.

// Must ask (require-push-approval).
export const CATCH = {
  basic: [
    "git push",
    "git push origin feat/x",
    "git -C dir push",
    "git -c k=v push",
    "git --git-dir=x push",
    "/usr/bin/git push",
    "git-push",
    "gh pr merge 12",
  ],
  wrapped: [
    "env A=1 git push",
    "A=1 git push",
    "sudo git push",
    "nohup git push &",
    "time git push",
    "command git push",
    "exec git push",
    "xargs git push",
    "find . -exec git push \\;",
  ],
  chained: [
    "a && git push",
    "a; git push",
    "a || git push",
    "a | git push",
    "(git push)",
    "{ git push; }",
    "echo start\ngit status\ngit push origin feat/x\necho done",
  ],
  substitution: [
    "$(git push)",
    "`git push`",
    'echo "$(git push)"',
    "echo `git push`",
    "x=$(git push origin feat/x)",
    "cat <(git push)",
    'echo "${x:-$(git push)}"',
  ],
  shellString: [
    'bash -c "git push"',
    'bash -lc "cd x && git push"',
    "sh -c 'git push origin x'",
    "zsh -c 'git push'",
    'eval "git push"',
    "ssh host 'git push'",
  ],
  heredocToShell: [
    "bash <<EOF\ngit push\nEOF",
    "sh <<'EOF'\ncd repo\ngit push origin feat/x\nEOF",
    "ssh host <<EOF\ngit push\nEOF",
    "cat <<'EOF' | bash\ngit push\nEOF",
    "sudo bash <<EOF\ngit push\nEOF",
    "cat <<EOF\n$(git push)\nEOF",
    'echo "git push" | sh',
    "printf 'git push\\n' | bash -s",
    "echo 'git push' | tee >(bash)",
  ],
  writeThenRun: [
    "cat > x.sh <<EOF\ngit push\nEOF\nbash x.sh",
    "cat > x.sh <<EOF\ngit push\nEOF\nsh x.sh",
    "cat > x.sh <<EOF\ngit push\nEOF\n./x.sh",
    "cat > x.sh <<EOF\ngit push\nEOF\nsource x.sh",
    "cat > x.sh <<EOF\ngit push\nEOF\n. x.sh",
    "cat > x.sh <<'EOF'\ngit push\nEOF\nchmod +x x.sh && ./x.sh",
    "tee x.sh <<'EOF' >/dev/null\ngit push\nEOF\nbash x.sh",
    "echo 'git push' > x.sh; bash x.sh",
    "printf -v c 'git push'; $c",
    "cat > .git/hooks/pre-commit <<'EOF'\ngit push\nEOF",
    "echo 'git push' >> ~/.zshrc",
    "tee -a .envrc <<'EOF'\ngit push\nEOF",
  ],
  interpreter: [
    `python3 -c "import os; os.system('git push')"`,
    `node -e "require('child_process').execSync('git push')"`,
    "python3 - <<EOF\nimport subprocess\nsubprocess.run('git push', shell=True)\nEOF",
    `perl -e 'system("git push")'`,
    `awk 'BEGIN{system("git push")}'`,
    "ruby -e '`git push`'",
    "node <<'EOF'\nconst { execSync } = require('child_process');\nexecSync('git push');\nEOF",
    "python3 <<'EOF'\nimport os\nos.popen('git push')\nEOF",
  ],
  unparsable: [
    "git push origin 'feat/x",
    "echo \"unclosed && git push",
    "cat <<EOF\nno terminator git push",
  ],
};

// Must not ask.
export const PASS = {
  realIncidents: [
    // 2026-10-16 #1: test file written with a heredoc, then the plugin tests run
    "cd /home/u/mods/work-trace && cp tests/fixtures/a.json tests/fixtures/b.json && cat > tests/zz-dump.test.ts <<'EOF'\n" +
      "import { test, expect } from 'bun:test';\n" +
      "test('dump', () => {\n" +
      "  const ev = { tool: 'Bash', input: { command: 'git push' } };\n" +
      "  expect(render(ev)).toContain('git push');\n" +
      "});\n" +
      "EOF\n" +
      "claude plugin test . 2>&1 | grep -E 'pass|fail' | head -80",
    // 2026-10-16 #2: python heredoc that rewrites a file
    "cd /home/u/mods/work-trace && python3 - <<'EOF'\n" +
      "import re, pathlib\n" +
      "p = pathlib.Path('hooks/approve.mjs')\n" +
      "s = p.read_text()\n" +
      "s = s.replace(\"'git push'\", \"'git push --dry-run'\")\n" +
      "s = re.sub(r'Bash\\(git push:\\*\\)', 'Bash(git push *)', s)\n" +
      "pat = re.compile(r'gh pr merge')\n" +
      "p.write_text(s)\n" +
      "print('ok')\n" +
      "EOF\n" +
      "claude plugin validate .; claude plugin test .",
  ],
  dataHeredoc: [
    "cat > notes.md <<'EOF'\nRun git push origin feat/x after review.\ngh pr merge 12 --squash\nEOF",
    "tee f <<EOF\ngit push\nEOF",
    "cat >> log.txt <<-EOF\n\tgit push origin main\n\tEOF",
    "cat <<'EOF' > a.txt && echo saved\nit's git push time\nEOF",
    'git commit -m "$(cat <<\'EOF\'\nhooks: stop asking for git push in heredoc data\n\nCo-Authored-By: x\nEOF\n)"',
    "gh pr create --title t --body \"$(cat <<'EOF'\nAfter merge, do not git push to main.\nEOF\n)\"",
  ],
  dataArgs: [
    'echo "git push"',
    'echo "git push 하세요"',
    "printf '%s\\n' 'git push origin main'",
    'grep -rn "git push" .claude/hooks',
    "rg 'git push' -n",
    'git commit -m "docs: explain why git push asks"',
    'git log --grep "git push" --oneline',
    "git -C /tmp/r commit -m 'gh pr merge later'",
    'gh pr comment 12 --body "please git push the fix"',
    "jq '.cmd == \"git push\"' f.json",
    "[[ $x == 'git push' ]] && echo yes",
    'echo "$(date) git push"',
    "for m in 'git push' 'git pull'; do echo \"$m\"; done",
  ],
  interpreterNoExec: [
    "python3 -c \"print('git push')\"",
    "node -e \"console.log('git push')\"",
    "perl -pe 's/git push/git push --dry-run/' f",
    "awk '/git push/ {n++} END {print n}' f",
    "python3 - <<'EOF'\nfrom pathlib import Path\nPath('x.md').write_text('git push origin main\\n')\nEOF",
  ],
  other: [
    "git status && git log --oneline -3",
    "ls -la",
    "node --test .claude/hooks/test/",
  ],
};
