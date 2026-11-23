// 구조에 넣지 않고 coverage_ignore로 빼는 것이 보통인 파일 종류.
import { matchesAny } from "./glob.mjs";

// 구조에 넣지 않고 coverage_ignore로 빼는 것이 보통인 파일. sure = 초안에 바로 넣는 것, 아니면 판단할 후보로만 낸다
export const IGNORE_CLASSES = [
  { reason: "시험 코드", sure: true, globs: ["src/test/**", "**/test/**", "**/tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*"] },
  { reason: "lock 파일", sure: true, globs: ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock", "poetry.lock", "go.sum", "Gemfile.lock", "composer.lock"] },
  { reason: "빌드 래퍼", sure: true, globs: ["gradle/wrapper/**", "gradlew", "gradlew.bat"] },
  { reason: "안내 문서", sure: true, globs: ["README.md"] },
  { reason: "git 설정", sure: true, globs: [".gitignore", ".gitattributes"] },
  { reason: "개발 도구(AI·편집기) 설정", sure: true, globs: [".cursor/**", ".gemini/**", ".mcp.json", "AGENTS.md", "CLAUDE.md", ".claude/**", ".vscode/**"] },
  { reason: "서식·린트 설정", sure: false, globs: [".editorconfig", ".eslintignore", ".eslintrc*", ".prettierignore", ".prettierrc*"] },
  { reason: "변경 기록·자리 표시 파일", sure: false, globs: ["CHANGELOG.md", "**/.gitkeep"] },
  { reason: "문서", sure: false, globs: ["docs/**", "**/*.md"] },
  { reason: "정적 자산(이미지·폰트·소스맵)", sure: false, globs: ["**/*.ico", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.gif", "**/*.webp", "**/*.svg", "**/*.woff", "**/*.woff2", "**/*.map"] },
];

// 파일 하나가 어느 종류에 드는지(없으면 null)
export const ignoreClass = (path) => IGNORE_CLASSES.find((c) => matchesAny(path, c.globs))?.reason ?? null;
