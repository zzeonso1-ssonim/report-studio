#!/usr/bin/env node
/**
 * 명단(APP_ROSTER) 부트스트랩 CLI.
 *
 * 왜 필요한가 — 닭과 달걀 때문이다. 명단이 비어 있으면 프로덕션은 전면 차단이라
 * 아무도(관리자 포함) 로그인할 수 없고, 앱 안의 명단 관리 화면에도 못 들어간다.
 * 그래서 **첫 관리자 한 명**만 이 스크립트로 만들고, 그 뒤부터는 앱의 /admin/roster 화면을 쓴다.
 *
 * 형식·해시 규칙의 정본은 lib/roster.ts 하나다.
 * 이 스크립트는 그 파일을 저장소의 tsc로 즉석 컴파일해 그대로 불러 쓴다 —
 * 규칙을 여기에 다시 적지 않으므로 둘이 어긋날 수 없다.
 *
 * 사용법:
 *   node scripts/roster.mjs add "홍길동" [admin|staff]
 *   node scripts/roster.mjs list
 *
 *   전화번호는 인자로 받지 않고 **입력 프롬프트로 받는다** — 셸 히스토리·프로세스 목록에
 *   개인정보가 남지 않게 하기 위해서다.
 *
 *   기존 명단을 이어서 늘리려면 APP_ROSTER 를 환경에 둔 채로 실행한다:
 *     APP_ROSTER="$(cat)" node scripts/roster.mjs add "홍길동" staff
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** lib/roster.ts 를 임시 디렉터리에 컴파일해 불러온다 (로직 중복 없음) */
function loadRosterModule() {
  const out = mkdtempSync(join(tmpdir(), "report-studio-roster-"));
  try {
    execFileSync(
      "npx",
      [
        "--no-install",
        "tsc",
        "lib/roster.ts",
        "--outDir",
        out,
        "--module",
        "commonjs",
        "--moduleResolution",
        "node",
        "--target",
        "es2022",
        "--esModuleInterop",
        "--skipLibCheck",
      ],
      { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] }
    );
    return createRequire(import.meta.url)(join(out, "roster.js"));
  } finally {
    // 컴파일 산출물은 남기지 않는다
    process.on("exit", () => rmSync(out, { recursive: true, force: true }));
  }
}

/** 전화번호를 화면에 찍지 않고 입력받는다 */
function askHidden(question) {
  // 프롬프트는 stderr로 낸다 — stdout은 명단 값 한 줄만 담아야 파이프로 쓸 수 있다.
  return new Promise((resolvePrompt) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const onData = (char) => {
      // 입력 중에는 프롬프트만 남기고 글자를 지운다
      if (["\n", "\r", ""].includes(String(char))) return;
      readline.clearLine(process.stderr, 0);
      readline.cursorTo(process.stderr, 0);
      process.stderr.write(question);
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stderr.write("\n");
      resolvePrompt(answer);
    });
  });
}

async function main() {
  const [command, nameArg, roleArg] = process.argv.slice(2);
  const roster = loadRosterModule();
  const current = roster.loadRoster();

  if (command === "list") {
    if (current.length === 0) {
      console.error("(명단이 비어 있습니다 — APP_ROSTER 미설정)");
      return;
    }
    for (const e of current) console.log(`${e.name}\t${e.role}`);
    return;
  }

  if (command !== "add") {
    console.error('사용법: node scripts/roster.mjs add "이름" [admin|staff]');
    console.error("        node scripts/roster.mjs list");
    process.exitCode = 1;
    return;
  }

  const nameCheck = roster.validateName(nameArg ?? "");
  if (!nameCheck.ok) {
    console.error(`오류: ${nameCheck.error}`);
    process.exitCode = 1;
    return;
  }
  if (current.some((e) => e.name === nameCheck.value)) {
    console.error(`오류: 이미 등록된 이름입니다 — ${nameCheck.value}`);
    process.exitCode = 1;
    return;
  }

  const phone = await askHidden(`${nameCheck.value} 님의 전화번호 (화면에 표시되지 않습니다): `);
  const phoneCheck = roster.validatePhone(phone);
  if (!phoneCheck.ok) {
    console.error(`오류: ${phoneCheck.error}`);
    process.exitCode = 1;
    return;
  }

  const role = (roleArg ?? "staff").toLowerCase() === "admin" ? "ADMIN" : "STAFF";
  const next = [...current, roster.makeEntry(nameCheck.value, phoneCheck.value, role)];

  // 사람이 읽는 안내는 stderr, **명단 값만 stdout**으로 낸다.
  // 그래야 `node scripts/roster.mjs add ... 2>/dev/null` 이 값 한 줄만 내놓아
  // 파이프로 이어 붙이거나 클립보드로 넘길 수 있다.
  console.error("");
  console.error(`${nameCheck.value} (${role}) 추가 — 명단 ${next.length}명`);
  console.error(`아래 값을 Vercel 환경변수 ${roster.ROSTER_ENV_NAME} 에 넣고 재배포하세요.`);
  console.error("전화번호는 저장되지 않습니다 (뒤 4자리의 salt+scrypt 해시만 들어갑니다).");
  console.error("");
  console.log(roster.formatRoster(next));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
