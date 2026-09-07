#!/usr/bin/env node
/**
 * 명단 게이트 자기시험 — **번호 미등록 항목으로 인증이 성공하는 경로가 하나도 없음**을 확인한다.
 *
 * 왜 이 파일이 있는가 —
 * 이름을 먼저 넣고 번호를 나중에 채우는 구조를 들이면서, 자격증명이 없는 엔트리가 명단에 남게 됐다.
 * 그런 항목으로 로그인이 되면 **지금 무인증인 것보다 나쁘다** — 뚫린 것을 닫았다고 믿게 되기 때문이다.
 * 그래서 조작된 명단까지 포함해 통과 경로를 항목별로 시험한다.
 *
 * 검증 로직의 정본은 lib/roster.ts·lib/auth.ts 하나다. 이 파일은 규칙을 다시 적지 않고
 * 저장소의 tsc로 즉석 컴파일해 그대로 불러 쓴다.
 *
 *   node scripts/roster-selftest.mjs
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "report-studio-selftest-"));
process.on("exit", () => rmSync(out, { recursive: true, force: true }));

execFileSync(
  "npx",
  ["--no-install", "tsc", "lib/roster.ts", "lib/auth.ts", "lib/auth-config.ts",
   "--outDir", out, "--module", "commonjs", "--moduleResolution", "node",
   "--target", "es2022", "--esModuleInterop", "--skipLibCheck"],
  { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] }
);

const require_ = createRequire(import.meta.url);
const roster = require_(join(out, "roster.js"));
const auth = require_(join(out, "auth.js"));

/** 명단을 환경변수에 꽂고 함수를 돌린다 (모듈이 process.env를 매번 읽는다) */
function withRoster(value, fn) {
  const prev = process.env.APP_ROSTER;
  process.env.APP_ROSTER = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.APP_ROSTER;
    else process.env.APP_ROSTER = prev;
  }
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 시험용 명단 ────────────────────────────────────────────────────────────
// 번호가 등록된 사람 1명(뒤 4자리 5678)과 번호 미등록 2명.
process.env.APP_SECRET = "selftest-signing-key";
const withPhone = roster.makeEntry("가진사람", "010-1234-5678", "ADMIN");
const nameOnly = roster.makeNameOnlyEntry("없는사람", "STAFF");
const nameOnlyAdmin = roster.makeNameOnlyEntry("없는관리자", "ADMIN");
const ROSTER = roster.formatRoster([withPhone, nameOnly, nameOnlyAdmin]);

console.log(`\n명단: ${ROSTER.replace(/[0-9a-f]{24,}/g, "…")}\n`);

// ── 1) 구조 ───────────────────────────────────────────────────────────────
console.log("1) 명단 구조");
{
  const parsed = roster.parseRoster(ROSTER);
  check("번호 미등록 엔트리가 명단에 남는다", parsed.length === 3, `${parsed.length}명`);
  check(
    "번호 미등록은 자격증명 없음으로 읽힌다",
    parsed.filter((e) => roster.hasCredential(e)).length === 1
  );
  const pub = withRoster(ROSTER, () => roster.publicRoster());
  check(
    "로그인 화면으로 hasPhone이 내려간다",
    pub.length === 3 && pub.filter((p) => p.hasPhone).length === 1
  );
  check(
    "로그인 화면 데이터에 salt·해시·전화번호가 없다",
    !JSON.stringify(pub).includes(withPhone.salt) &&
      !JSON.stringify(pub).includes(withPhone.hash) &&
      !JSON.stringify(pub).includes("5678")
  );
  check(
    "번호 미등록만 있어도 게이트는 잠긴다(무인증 창 없음)",
    withRoster(roster.formatRoster([nameOnly]), () => auth.gateMode()) === "enforced"
  );
}

// ── 2) 번호 미등록 항목으로 뚫리는 입력이 있는가 ───────────────────────────
console.log("\n2) 번호 미등록 항목 — 입력 전수 시험");
{
  const verify = (id, input) => withRoster(ROSTER, () => roster.verifyCredential(id, input));

  const edge = ["", " ", "0000", "1234", "9999", "5678", "null", "undefined", "0", "00000",
                "  0000  ", "abcd", "００００", "12 34", "-1-2-3-4"];
  const edgeResults = await Promise.all(edge.map((v) => verify(nameOnly.id, v)));
  const okEdge = edgeResults.filter((r) => r.ok);
  check(
    `빈 입력·0000·남의 뒤4자리 등 ${edge.length}종 전부 거부`,
    okEdge.length === 0,
    okEdge.length ? `통과됨: ${okEdge.length}건` : "통과 0건"
  );

  // 뒤 4자리는 경우의 수가 1만뿐이다. **실제로 verifyCredential을 1만 번 호출해** 통과가 0인지 본다.
  // 실패 지연(700ms)은 setTimeout이라 동시에 걸어두면 전체가 한 번의 지연으로 끝난다.
  const codes = Array.from({ length: 10000 }, (_, i) => String(i).padStart(4, "0"));
  const bruteResults = await withRoster(ROSTER, () =>
    Promise.all(codes.map((c) => roster.verifyCredential(nameOnly.id, c)))
  );
  const brute = bruteResults.filter((r) => r.ok).length;
  check("뒤 4자리 전수 10,000건 실제 호출 — 통과 0건", brute === 0, `통과 ${brute}건`);

  const admin = await verify(nameOnlyAdmin.id, "0000");
  check("번호 미등록 ADMIN도 통과하지 못한다", !admin.ok);
  check("실패 사유가 no_phone으로 구분된다(세션은 발급되지 않음)",
    !admin.ok && admin.reason === "no_phone");
}

// ── 3) 조작된 명단 ────────────────────────────────────────────────────────
console.log("\n3) 조작된 명단 (APP_ROSTER를 손댄 경우)");
{
  const cases = [
    ["해시 필드를 비운 명단", `가진사람:A:${withPhone.salt}:`],
    ["salt·해시를 둘 다 비운 4필드", "가진사람:A::"],
    ["salt만 남긴 명단", `가진사람:A:${withPhone.salt}`],
    ["해시를 0으로 채운 명단", `가진사람:A:${withPhone.salt}:${"0".repeat(withPhone.hash.length)}`],
    ["해시를 빈 hex로 둔 명단", `가진사람:A:${withPhone.salt}:00`],
  ];
  for (const [label, value] of cases) {
    const parsed = roster.parseRoster(value);
    const entry = parsed[0];
    let passed = false;
    if (entry) {
      const tries = ["", "0000", "1234", "5678"];
      for (const t of tries) {
        const r = await withRoster(value, () => roster.verifyCredential(entry.id, t));
        if (r.ok) { passed = true; break; }
      }
    }
    check(label, !passed, entry ? (roster.hasCredential(entry) ? "자격증명 있음으로 읽힘" : "번호 미등록으로 강등") : "엔트리 자체가 버려짐");
  }
}

// ── 4) 정상 경로가 여전히 되는가 (게이트를 너무 조여 아무도 못 들어가는 것도 실패다) ──
console.log("\n4) 정상 경로");
{
  const good = await withRoster(ROSTER, () => roster.verifyCredential(withPhone.id, "5678"));
  check("번호 등록자는 올바른 뒤 4자리로 통과한다", good.ok === true);
  const bad = await withRoster(ROSTER, () => roster.verifyCredential(withPhone.id, "5679"));
  check("번호 등록자도 틀린 4자리는 거부된다", bad.ok === false);

  const token = good.ok ? auth.createSessionToken(good.entry) : null;
  check("통과 시 세션 토큰이 발급된다", Boolean(token));
  check(
    "세션 토큰에 전화번호·뒤 4자리가 들어 있지 않다",
    Boolean(token) && !Buffer.from(token.split(".")[2], "base64url").toString("utf8").includes("5678")
  );

  // 번호 미등록자의 id로 위조한 세션 — 서명이 맞아도 명단 재확인에서 걸려야 한다.
  const forged = withRoster(ROSTER, () =>
    auth.createSessionToken({ id: nameOnly.id, name: nameOnly.name, role: "ADMIN", salt: null, hash: null })
  );
  const restored = withRoster(ROSTER, () => auth.verifySessionToken(forged));
  check(
    "번호 미등록자 세션은 서명이 맞아도 ADMIN으로 복원되지 않는다",
    restored === null || restored.role !== "ADMIN",
    restored ? `role=${restored.role}` : "거부됨"
  );
}

// ── 결과 ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
if (failed.length > 0) {
  console.log("실패:");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  process.exitCode = 1;
}
