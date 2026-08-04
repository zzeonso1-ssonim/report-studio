import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * ECOS 항목명 색인 로더 — 서버 전용.
 *
 * 표 이름만으로 통계표를 고르면 도달 못 하는 계열이 있다. 국고채가 대표 사례로,
 * ECOS에서 표 이름은 "시장금리(일별)"이고 "국고채"는 **항목 이름에만** 있다.
 * 항목 상한을 얼마로 올려도 표가 후보에 못 오르면 도달률은 0이다.
 *
 * 색인은 `scripts/build-ecos-item-index.mjs`가 만드는 빌드 산출물이며
 * 저장소에 커밋한다(런타임 생성은 ECOS 3분 300회 한도를 반드시 넘긴다).
 * 파일이 없거나 깨져 있으면 **항목명 매칭만 꺼지고 검색은 종전대로 동작한다.**
 */
export interface EcosItemIndex {
  /** 색인 생성 시점 — 화면·보고에 기준일로 병기할 값 */
  builtAt: string;
  searchableTables: number;
  indexedTables: number;
  /** statCode → { n: 항목 수, s: 항목명을 정규화해 '|'로 이은 블롭 } */
  tables: Record<string, { n: number; s: string }>;
}

let cache: EcosItemIndex | null | undefined;

export function ecosItemIndex(): EcosItemIndex | null {
  if (cache !== undefined) return cache;
  try {
    const file = path.join(process.cwd(), "data", "ecos-item-names.json");
    if (!existsSync(file)) {
      console.warn(
        "[search] ECOS 항목명 색인이 없습니다 — 표 선정에서 항목명 매칭이 꺼집니다. " +
          "`node --env-file=.env.local scripts/build-ecos-item-index.mjs`로 생성하세요"
      );
      cache = null;
    } else {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as EcosItemIndex;
      cache = parsed?.tables ? parsed : null;
    }
  } catch (err) {
    console.warn(`[search] ECOS 항목명 색인 읽기 실패 — 항목명 매칭 없이 진행: ${String(err)}`);
    cache = null;
  }
  return cache;
}
