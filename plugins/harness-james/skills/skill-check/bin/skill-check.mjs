#!/usr/bin/env node
// skill-check 1단계 CLI. 결과 JSON 하나를 stdout으로 내고 언제나 0으로 끝난다.
// (SKILL.md의 ! 명령 주입은 0이 아닌 종료 코드면 스킬 호출 전체를 멈추기 때문이다.)
//   node bin/skill-check.mjs rules <스킬 디렉터리> [--as user|project] [--eval] [--out <file>]
//   node bin/skill-check.mjs rules --args-stdin   (1줄째 프로젝트 경로, 2줄째부터 사용자 인자. lib/args.mjs)
import fs from 'node:fs';
import path from 'node:path';

const USAGE = '사용법: skill-check rules <스킬 디렉터리> [--as user|project] [--eval] [--out <file>] | skill-check rules --args-stdin';

function parseArgs(argv) {
  const o = { cmd: argv[0], dir: null, as: null, eval: false, out: null, stdin: false, bad: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--eval') o.eval = true;
    else if (a === '--args-stdin') o.stdin = true;
    else if (a === '--as') o.as = argv[++i];
    else if (a.startsWith('--as=')) o.as = a.slice(5);
    else if (a === '--out') o.out = argv[++i];
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--')) o.bad = `모르는 옵션 ${a}`;
    else if (!o.dir) o.dir = a;
    else o.bad = `인자가 너무 많아요: ${a}`;
  }
  if (o.stdin && (o.dir || o.as || o.eval)) o.bad = '--args-stdin과 위치 인자를 함께 쓸 수 없어요';
  if (o.as != null && o.as !== 'user' && o.as !== 'project') o.bad = '--as는 user나 project만 받아요';
  return o;
}

async function main() {
  let result;
  let name = 'unknown';
  const o = parseArgs(process.argv.slice(2));
  try {
    const { runRules, writeRunLog } = await import('../lib/check.mjs');
    const { tildify } = await import('../lib/context.mjs');
    let extraNotes = [];
    if (o.cmd !== 'rules') result = { ok: false, tool: 'skill-check', error: `${USAGE}` };
    else if (o.bad) result = { ok: false, tool: 'skill-check', error: `${o.bad}. ${USAGE}` };
    else {
      if (o.stdin) {
        const { parseStdinArgs, readStdin, ArgsError } = await import('../lib/args.mjs');
        try {
          const a = parseStdinArgs(await readStdin());
          if (a.projectSource === 'stdin') process.env.CLAUDE_PROJECT_DIR = a.projectDir;
          Object.assign(o, { dir: a.dir, as: a.as, eval: a.eval });
          extraNotes = a.notes;
        } catch (e) {
          if (!(e instanceof ArgsError)) throw e;
          result = { ok: false, tool: 'skill-check', error: e.message };
        }
      }
      if (!result) {
        result = await runRules(o.dir, { as: o.as, eval: o.eval });
        if (result.ok) result.notes.push(...extraNotes);
        name = result.ok ? result.target.name : path.basename(String(o.dir || 'unknown'));
      }
    }
    if (result.ok) {
      try { result.runFile = tildify(writeRunLog(result, name)); } catch (e) { result.notes.push(`실행 기록을 남기지 못했어요: ${e.code || e.message}`); }
    }
  } catch (e) {
    result = { ok: false, tool: 'skill-check', error: `내부 오류: ${e && e.message ? e.message : String(e)}` };
  }
  if (o.out) {
    try { fs.writeFileSync(path.resolve(o.out), JSON.stringify(result, null, 1)); } catch (e) { result.notes = [...(result.notes || []), `--out 파일을 쓰지 못했어요: ${e.code || e.message}`]; }
  }
  process.stdout.write(JSON.stringify(result, null, 1) + '\n');
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, tool: 'skill-check', error: `내부 오류: ${e && e.message}` }) + '\n');
}).finally(() => { process.exitCode = 0; });
