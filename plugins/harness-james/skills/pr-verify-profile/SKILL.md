---
name: pr-verify-profile
description: /pr-verify 프로필(평가 폴더 docs/evaluation/profiles/*.json, 문서 표기 '프로파일')의 초안과 구조 목록(structures) 변경안을 만든다. 새 레포를 /pr-verify·PR 게이트에 붙이는데 프로필이 없을 때("레포를 알 수 없음", "workspace를 찾지 못함"), /pr-verify 준비 단계가 구조 밖 파일이나 파일을 못 잡는 구조를 경고했을 때, 사용자가 프로필 초안·구조 목록 정리·coverage_ignore 정리·프로필 점검을 요청할 때 쓴다. 레포를 읽기 전용 git으로 훑어 초안, 기계 점검, 확인 표까지 만든다. 등록은 사용자 확인 뒤에만 하고, /pr-verify 실행, rubric·산식 수정, 기능 문서 메타 수정은 하지 않는다.
argument-hint: "<레포 폴더 | 등록 프로필 파일> [--head <ref>] [--base <ref>]"
allowed-tools: Read(/${CLAUDE_SKILL_DIR}/**) Bash(node ${CLAUDE_SKILL_DIR}/bin/pvp.mjs *)
---

# pr-verify-profile

대상: `$ARGUMENTS`

/pr-verify는 레포마다 프로필이 있어야 돈다. 프로필의 핵심은 구조 목록이다. 바뀐 파일이 어느 구조에 드는지, 그 구조의 중요도와 검토 문턱이 얼마인지로 사람이 직접 검토할 변경이 정해진다. 필드 전체의 뜻은 같은 플러그인 pr-verify 스킬의 `references/profile-guide.md`에 있다.

이 스킬은 레포를 읽어 초안을 만들고, 스크립트로 점검하고, 확인 표를 사용자에게 보여 주는 데까지 한다.

## 지킬 것

- 결과는 초안까지다. 구조 목록이 바뀌면 사람이 검토할 변경의 범위가 달라지므로 사용자가 확인 표를 보고 정한다. 스크립트는 워크스페이스의 `.verify/` 아래와 임시 폴더에만 쓰고 평가 폴더의 `profiles/`에는 쓰지 않는다. 등록(복사)은 사용자가 확인한 뒤 아래 "등록" 절의 순서로 한다.
- 대상 레포는 읽기만 한다. 다른 세션이나 사람이 같은 체크아웃에서 일하고 있을 수 있으니 브랜치를 바꾸거나 파일을 고치지 않는다. 스크립트는 읽기 전용 git 명령만 쓰고 fetch도 하지 않는다. 코드를 직접 읽을 때도 읽기 명령만 쓴다: `git -C <레포> show <ref>:<경로>`, `git -C <레포> grep <말> <ref> -- <경로>`, `git -C <레포> log`, `git -C <레포> ls-tree`. 레포의 시험·빌드는 돌리지 않는다(외부 서비스나 실데이터를 부를 수 있다).
- 시크릿 파일(`.env` 등) 내용은 읽지 않는다. 설정 키 이름은 inventory의 "예시 env 파일의 키 이름" 칸에서 본다. 레포에 커밋된 env 파일은 inventory가 경로만 알려 준다. 그 경로를 구조 `paths`에 적는 것은 된다.
- 평가 기준(rubric·framework)은 레포와 무관한 원칙이고, 레포 지식(경로, 벤더 사실, 수치)은 프로필에만 둔다. 이 스킬은 결정적 규칙(`rules`)을 새로 짓지 않는다. 사용자가 규칙을 요청했거나 등록본에 이미 있으면 check가 /pr-verify 준비 단계와 같은 조건으로 모양을 본다.
- 구조끼리 경로가 겹쳐도 된다(놓치느니 더 경고). check는 겹침을 INFO로만 낸다.

## 명령

워크스페이스 루트(검증할 레포들을 품은 프로젝트 루트, 평가 폴더가 있거나 둘 곳)에서 실행한다. 위치 규칙은 /pr-verify와 같다.

- 평가 폴더: `docs/evaluation/`. 환경 변수 `VERIFY_EVAL_DIR`(워크스페이스 기준 상대 경로)로 바꾼다.
- 워크스페이스: `VERIFY_WORKSPACE`가 있으면 그 값, 없으면 평가 폴더의 `profiles/`가 있는 가장 가까운 상위 폴더, 그것도 없으면 지금 폴더(첫 프로필을 만들 때).
- 산식 숫자(`config/scoring.json`): 평가 폴더에 있으면 그것, 없으면 pr-verify 스킬의 기본값.

```bash
node ${CLAUDE_SKILL_DIR}/bin/pvp.mjs inventory --repo <레포 폴더> [--ref <ref>]
node ${CLAUDE_SKILL_DIR}/bin/pvp.mjs skeleton  --repo <레포 폴더> --key <짧은 이름> [--alias <별칭>]… [--ref <ref>] [--base <default_base>] [--out <초안 폴더>]
node ${CLAUDE_SKILL_DIR}/bin/pvp.mjs check     --profile <프로필> [--head <ref>] [--base <ref>] [--against <등록 프로필>] [--quiet] [--json <파일>]
node ${CLAUDE_SKILL_DIR}/bin/pvp.mjs table     --profile <프로필> [--head <ref>] [--base <ref>] [--against <등록 프로필>]
```

- 레포는 프로필의 `repo.path`에서 찾는다. 다른 위치의 같은 레포(worktree)를 보려면 `check`와 `table`에 `--repo <폴더>`를 준다. `--json`은 구조 밖 파일 전체 목록까지 든 결과를 `.verify/` 아래 파일로 남긴다.
- 초안 폴더의 기본값은 `.verify/profile-drafts/`다(/pr-verify 실행 산출물 `.verify/runs/`와 같은 작업 폴더. `.gitignore`에 `.verify/`를 권한다). 있는 파일은 `--force` 없이는 덮어쓰지 않는다.
- inventory와 skeleton은 `--ref`를 안 주면 원격 기본 브랜치(`origin/HEAD`가 가리키는 것)를 보고, 없으면 `origin/main`, `origin/master`, `origin/dev`, `origin/develop` 순서로 있는 것을, 원격 추적 브랜치가 하나도 없으면 `HEAD`를 본다. skeleton의 `default_base`도 같은 순서로 정해진다. PR을 받는 브랜치가 원격 기본 브랜치와 다르면(예: 기능 PR은 `dev`로 받는다) `--base origin/<그 브랜치>`로 바꾼다. inventory가 후보를 모두 보여 준다.
- check와 table은 `--head`를 안 주면 프로필의 `default_base`를 본다. ref는 `origin/…`으로 준다. 로컬 브랜치는 origin보다 뒤처져 있을 수 있다(inventory가 뒤처진 브랜치를 알려 준다).
- 종료 코드(모든 명령): 0 = 돌았음(WARN이 있어도 0), 1 = FAIL 있음(`check`만), 2 = 인자 오류나 쓰기 거부, 3 = 레포·ref·프로필을 못 읽음.
- 모드 고르기: 대상이 등록 프로필 파일이거나 그 레포의 프로필이 평가 폴더 `profiles/`에 있으면 변경안 모드다(inventory 없이 check부터). 없으면 새 레포 모드다. 모르겠으면 inventory를 돌린다. 등록돼 있으면 첫머리에 "이미 등록된 프로필" 줄이 나온다.

## 새 레포: 프로필 초안

1. `inventory`로 레포를 훑는다. 성격 추정, 폴더 묶음(파일 수, 건드린 커밋 합, 첫 커밋 그대로인 파일 수), 뺄 파일 후보, 첫 커밋, default_base 후보를 본다.
2. `skeleton`으로 뼈대를 만든다. 레포 정보, traits, 주석 문법, coverage_ignore는 채워져 있다. 차원 가중치·차단선·criteria는 같은 성격(traits)의 등록 프로필이 있으면 거기서 가져온 출발값이고, 없으면 차원 가중치가 비어 있다(아래 판단 기준 문서의 "차원 가중치"로 채운다). `--key`는 `/pr-verify <key>`로 부르는 짧은 이름이고 다른 프로필의 dependents가 가리키는 값이다.
3. 코드를 읽고 뼈대의 빈 칸을 채운다. 판단 기준과 중요도 눈금은 `${CLAUDE_SKILL_DIR}/references/judgment.md`에 있다. 구조를 처음 나눌 때와 dependents를 걸 때 읽는다.
   - `structures`: id(`<접두어>.<이름>`), name, criticality, review_threshold, paths(glob 목록), exclude(선택, glob 목록), why, specs(판정 에이전트가 참고할 문서 경로. 없으면 `[]`). 접두어는 레포의 짧은 약자이고 다른 프로필과 겹치지 않게 짓는다.
   - `dependents`: 다른 레포와 계약이 있는 파일(서버 응답 모양과 그것을 해석하는 화면 코드 등). 모양은 `{ "source": "<이 레포 파일>", "replicas": [{ "repo": "<상대 프로필 key>", "path": "<상대 레포 파일>", "ref": "origin/<브랜치>" }], "note": "<무엇이 무엇의 거울인지>" }`다. 코드가 아닌 파일(설정)도 된다.
   - `dimensions`: 출발값이 이 레포의 위험과 다르면 고치고 합을 1.0으로 맞춘다.
   - 맨 위 `$comment`: 레포가 무엇인지 한 구절을 더한다.
4. `check --profile <초안>`을 돌려 FAIL과 WARN을 없앤다. 구조 밖 파일은 구조에 넣거나 `coverage_ignore`에 넣는다. 둘 다 아니라고 판단한 파일은 남기고 보고에 이유를 적는다.
5. `table --profile <초안>`으로 확인 표를 만든다. 첫 검증에서 구조별로 몇 파일이 걸리는지 보려면 `--base <첫 커밋>`을 준다.

## 기존 레포: 구조 목록 변경안

1. `check --profile <평가 폴더>/profiles/<파일>.json`을 돌린다. 특정 브랜치의 경고에서 시작했으면 `--head <그 브랜치> --base <갈림점이나 default_base>`를 준다. 고칠 것은 FAIL과 WARN 줄이다. 마지막 줄이 "고칠 것 없음"이면 여기서 끝내고 그대로 보고한다.
2. 고칠 것이 있으면 등록 프로필을 같은 파일 이름으로 초안 폴더(`.verify/profile-drafts/`)에 복사하고(`cp`), 복사본만 고친다. 같은 폴더의 다른 초안은 대조 상대 초안으로 읽힌다. 파일을 어느 구조에 넣을지와 새 구조의 중요도는 `references/judgment.md`의 기준으로 정한다.
   - `uncovered-changed`, `uncovered-tree`: 줄 끝의 단서(같은 폴더 파일을 잡는 구조, coverage_ignore 후보)는 출발점일 뿐이다. 파일과 그것을 부르는 곳을 읽고 넣을 곳을 정한다. 기존 구조 어디와도 틀렸을 때 생기는 일이 다르면 새 구조를 만든다.
   - `uncovered-tree`가 파일 목록 없이 폴더 요약으로만 나오면(60개 초과) 그 프로필은 핵심 구조만 잡도록 짠 것이다. 그때는 `uncovered-changed`에 나온 파일만 다루고, 나머지는 개수와 폴더 요약을 보고에 적는다.
   - `empty-structure`, `renamed-path`: 경로가 옮겨졌는지, 코드가 없어졌는지 git log로 확인한다. `dead-path`(INFO) 중 파일 이름을 그대로 적은 경로는 지워졌거나 이름이 바뀐 것이니 정리하고, 앞으로 생길 파일을 잡으려고 둔 이름 패턴(`*Filter*` 등)은 둔다.
   - 기존 구조 id는 그대로 둔다. 리포트·보정 기록과 기능 문서 메타가 id를 가리킨다. 꼭 필요하면 바꾸되 check의 `structure-id-change` 줄을 보고에 옮긴다.
   - `version`을 올린다. 구조 삭제·id 변경은 MAJOR, 그 밖의 구조·coverage_ignore·dependents 변경은 MINOR, 문구만 고치면 PATCH다. 덜 올렸으면 check가 `WARN version`으로 필요한 단계를 알려 준다.
3. `check --profile <초안> --against <등록 프로필>`로 다시 본다. `repo.key`가 같은 등록 프로필이 있으면 `--against` 없이도 자동으로 견준다.
4. `table --profile <초안> --against <등록 프로필>`로 확인 표를 만든다. 바뀌는 구조는 "바뀌는 점" 칸에, id 변경·삭제는 표 아래 ⚠ 줄에, 더하고 뺀 경로·dependents 변경·version은 표 아래 줄에 나온다.

## 확인 받기와 보고

- `table` 출력을 그대로 보여 준다. 중요도와 문턱은 표가 "몇 줄 바뀌면 사람이 보는지"로 풀어 준다. 표 밖 설명은 짧게 한다.
- 표와 함께 알린다: 초안 파일 경로, check 마지막 줄, 남긴 WARN과 이유, 판단이 갈린 곳(어느 구조에 넣을지 망설인 파일, 손댄 가중치), 표에 안 나오는 변경(가중치, 별칭, comment_syntax).
- 묻는 것은 구조 목록(나눈 방식, 중요도, 문턱) 하나다. 가중치나 별칭처럼 나중에 고쳐도 되는 값은 정한 값과 이유만 적는다.

## 등록 (사용자 확인 뒤)

사용자가 표를 보고 확정하면 초안을 `<평가 폴더>/profiles/<레포 이름>.json`으로 복사하고 `check --profile <등록한 파일>`을 한 번 더 돌린다. 함께 알린다:

- 등록하면 그 레포의 `gh pr create`에 PR 게이트(`require-verify-before-pr` 훅)가 붙는다. 게이트는 `repo.path`(git 폴더)와 `repo.github`(origin slug)로 레포를 알아보고, 지금 head에 대한 /pr-verify 리포트가 없거나 PASS가 아니면 PR 생성을 사용자 승인에서 멈춘다. `long_lived_branches`에 든 브랜치에서 여는 PR은 갈림점 기준 전체 모드(`--full`) 리포트를 요구한다.
- 두 레포가 서로를 dependents로 가리키면 함께 등록한다. 한쪽만 있으면 /pr-verify가 경고만 내고 그 대조를 건너뛴다.
- 새 레포의 첫 검증은 첫 커밋을 base로 준다: `/harness-james:pr-verify <key> <default_base 브랜치> --base <첫 커밋>`. 빈 트리는 base로 못 쓰고, `--full`에 대상이 default_base면 "변경 없음"(종료 3)으로 끝난다. 첫 커밋은 inventory에 있다.
- 프로필에 `feature_map`(기능 문서 폴더)이 있고 구조 id를 바꿨거나 기존 기능에 속하는 새 구조를 넣었으면, 기능 문서 첫 줄 메타(`<!-- fm: …; structures=… -->`)도 맞춰야 한다고 보고에 적는다. 그 메타는 이 스킬이 고치지 않는다(그 문서를 관리하는 도구나 사람의 몫).

## check 결과 읽기

| 줄 | 뜻 | 할 일 |
|---|---|---|
| FAIL shape·weights·alias·structure-id·rules | /pr-verify가 멈추거나 엉뚱한 프로필을 고른다 | 고친다 |
| FAIL repo | 레포 폴더나 ref를 못 열어 트리 점검을 건너뛰었다 | `repo.path`, `--repo`, `--head`를 확인한다 |
| WARN repo·weights | `repo.github`가 origin과 다르다(PR 게이트가 못 찾음), default_base가 없다, client 아닌 레포에 A11Y가 있다 | 고친다 |
| WARN empty-structure | 구조가 파일을 하나도 못 잡는다 | 경로를 고치거나 구조를 없앤다(id 삭제 표시) |
| WARN uncovered-changed | `--base` 뒤 바뀐 파일이 구조 밖이다. /pr-verify 준비 단계가 경고하는 파일이다 | 구조나 coverage_ignore에 넣는다 |
| WARN uncovered-tree | 트리 전체에서 구조 밖인 파일이다. 바뀌면 경고가 난다 | 새 초안은 0으로 만든다. 등록본은 변경안에 넣을지 정한다 |
| WARN renamed-path | 파일 이름을 적은 경로가 죽었고 git 기록에 이름 바뀜이 있다 | 맞는지 확인하고 새 이름으로 고친다 |
| WARN dependent-repo·ref·path·source | 대조 상대 프로필이 없거나, ref가 뒤처진 로컬 브랜치이거나 이미 머지된 옛 브랜치이거나, 파일이 없다 | 고친다 |
| WARN structure-id-change | 등록본의 구조 id가 없어지거나 바뀐다 | 확인 표에 표시하고 사용자에게 알린다 |
| WARN version | 내용이 바뀌었는데 version이 그대로다 | version을 올린다 |
| WARN feature-meta | `feature_map` 폴더의 기능 문서 메타가 없는 구조 id를 가리킨다 | 보고에 옮긴다(메타는 고치지 않는다) |
| WARN rules·unread-key | 규칙의 `repo`가 이 프로필 key와 달라 건너뛰어진다, /pr-verify가 읽지 않는 칸(`known_debt`)이 있다 | 고치거나 지운다 |
| INFO dependent-repo·dependent-ref | 상대 프로필이 초안에만 있다, ref가 로컬 브랜치 이름이지만 지금은 안 뒤처졌다 | 함께 등록한다, `origin/…`으로 적는다 |
| INFO dead-path·overlap·comment-syntax·ignore-dead·alias·stale-branch·structure-specs-change | 참고 | 필요하면 정리하고, 손대지 않은 것은 보고에 한 줄로 적는다 |

## 파일

Node 18 이상과 git이 필요하다. 외부 npm 패키지와 그 밖의 외부 CLI는 쓰지 않는다.

- `bin/pvp.mjs`: 명령 진입점
- `lib/inventory.mjs`·`skeleton.mjs`·`ignore.mjs`: 레포 훑기와 뼈대
- `lib/check.mjs`: 기계 점검(모양, 규칙, 가중치 합, 별칭 중복, 빈 구조, 구조 밖 파일, 대조 상대, 구조 id 변경)
- `lib/rule.mjs`·`table.mjs`: 중요도·문턱을 쉬운 말로 푼 확인 표(산식 숫자는 `config/scoring.json`에서 읽는다)
- `lib/git.mjs`·`workspace.mjs`·`glob.mjs`: 읽기 전용 git, 위치 규칙과 쓰기 위치 제한, /pr-verify와 같은 glob
- `test/`: 스킬 폴더에서 `node --test test/`. 임시 워크스페이스와 임시 git 레포만 쓴다
