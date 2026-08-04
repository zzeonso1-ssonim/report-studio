#!/usr/bin/env node
/**
 * ECOS 항목명 색인 생성 — data/ecos-item-names.json
 *
 * 왜 필요한가: 표 이름만으로 통계표를 고르면 도달 못 하는 계열이 있다.
 * 국고채가 대표 사례다 — ECOS에서 표 이름은 "시장금리(일별)"이고 "국고채"는
 * **항목 이름에만** 있다. 항목 상한을 얼마로 올려도 표가 후보에 못 오르면
 * 도달률은 0이다(2026-08-05 실측: "국고채 커브" 0건).
 *
 * 왜 파일로 커밋하는가: 항목 목록은 표마다 API 1회(총 608회)가 필요하고
 * ECOS는 3분 300회 제한이 있다. 서버리스는 콜드스타트마다 캐시가 비므로
 * 런타임에 만들면 한도를 반드시 넘는다. 카탈로그는 비밀이 아니고 거의 변하지
 * 않으므로 빌드 산출물로 저장소에 넣고, 이 스크립트로 주기적으로 갱신한다.
 *
 * 사용법:
 *   cd <저장소> && node --env-file=.env.local scripts/build-ecos-item-index.mjs
 *   (ECOS_API_KEY를 .env.local에서 읽는다 — 키를 인자로 넘기지 않는다)
 *
 * 옵션: --limit N (앞 N개 표만, 점검용) · --out <경로>
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const KEY = process.env.ECOS_API_KEY;
if (!KEY) {
  console.error("ECOS_API_KEY가 없습니다 — node --env-file=.env.local 로 실행하세요");
  process.exit(1);
}

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const LIMIT = Number(argOf("--limit")) || Infinity;
const OUT = resolve(argOf("--out") ?? "data/ecos-item-names.json");

/** 표당 저장하는 항목명 블롭 길이 상한 — 파일 크기를 통제한다 */
const MAX_BLOB = 6000;

/**
 * ECOS 호출 페이싱 — 공식 한도는 3분 300회(ERROR-602).
 * 60초당 90회로 제한해 3분 270회로 여유를 둔다.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 90;
let windowStart = Date.now();
let inWindow = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function paced(fn) {
  if (inWindow >= MAX_PER_WINDOW) {
    const wait = WINDOW_MS - (Date.now() - windowStart) + 500;
    if (wait > 0) {
      process.stderr.write(`  (한도 대기 ${Math.round(wait / 1000)}s)\n`);
      await sleep(wait);
    }
    windowStart = Date.now();
    inWindow = 0;
  }
  inWindow++;
  return fn();
}

async function getJson(url, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await paced(() => fetch(url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.RESULT) {
        // ERROR-602(한도) 는 대기 후 재시도, 나머지는 그대로 보고
        if (String(json.RESULT.CODE).includes("602") && attempt < tries) {
          process.stderr.write("  (ERROR-602 — 90초 대기 후 재시도)\n");
          await sleep(90_000);
          windowStart = Date.now();
          inWindow = 0;
          continue;
        }
        throw new Error(`${json.RESULT.CODE} ${json.RESULT.MESSAGE}`);
      }
      return json;
    } catch (err) {
      if (attempt === tries) throw err;
      await sleep(1500 * attempt);
    }
  }
}

/** 매칭용 정규화 — 소문자 + 공백 제거 (lib/search.ts의 normalize와 같은 규칙) */
const normalize = (s) => s.toLowerCase().replace(/\s/g, "");

const tableJson = await getJson(
  `https://ecos.bok.or.kr/api/StatisticTableList/${KEY}/json/kr/1/1000/`
);
const tables = (tableJson.StatisticTableList?.row ?? []).filter((t) => t.SRCH_YN === "Y");
console.error(`검색가능 통계표 ${tables.length}개`);

// 이어받기 — 기존 색인이 있으면 성공분은 다시 부르지 않는다(한도 절약)
let existing = {};
if (existsSync(OUT)) {
  try {
    existing = JSON.parse(readFileSync(OUT, "utf8")).tables ?? {};
    console.error(`기존 색인 ${Object.keys(existing).length}개 재사용 (--out 파일 삭제 시 전량 재수집)`);
  } catch {
    existing = {};
  }
}

const out = {};
const failed = [];
let done = 0;
for (const t of tables.slice(0, LIMIT === Infinity ? undefined : LIMIT)) {
  done++;
  if (existing[t.STAT_CODE]) {
    out[t.STAT_CODE] = existing[t.STAT_CODE];
    continue;
  }
  try {
    const j = await getJson(
      `https://ecos.bok.or.kr/api/StatisticItemList/${KEY}/json/kr/1/1000/${t.STAT_CODE}`
    );
    const rows = j.StatisticItemList?.row ?? [];
    const names = [...new Set(rows.map((r) => r.ITEM_NAME).filter(Boolean))];
    const blob = normalize(names.join("|")).slice(0, MAX_BLOB);
    out[t.STAT_CODE] = { n: names.length, s: blob };
  } catch (err) {
    failed.push({ statCode: t.STAT_CODE, err: String(err.message ?? err) });
    process.stderr.write(`  실패 ${t.STAT_CODE}: ${err.message ?? err}\n`);
  }
  if (done % 25 === 0) process.stderr.write(`  ${done}/${tables.length}\n`);
}

mkdirSync(dirname(OUT), { recursive: true });
const payload = {
  builtAt: new Date().toISOString(),
  source: "ECOS StatisticItemList (한국은행 경제통계시스템 OpenAPI)",
  searchableTables: tables.length,
  indexedTables: Object.keys(out).length,
  failed,
  note: "s = 항목명을 소문자·공백제거로 정규화해 '|'로 이은 블롭(표당 최대 6000자). 표 선정 시 항목명 대조에만 쓴다.",
  tables: out,
};
writeFileSync(OUT, JSON.stringify(payload));
console.error(
  `완료: ${OUT} · 표 ${payload.indexedTables}/${tables.length} · 실패 ${failed.length} · ${(
    JSON.stringify(payload).length / 1024
  ).toFixed(0)}KB`
);
