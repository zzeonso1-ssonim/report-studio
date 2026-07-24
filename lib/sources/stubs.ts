import { SourceAdapter, SourceError } from "./types";

/**
 * 아직 미구현인 소스들의 자리표시자.
 * 각 소스를 붙일 때 이 파일에서 꺼내 개별 파일로 승격시킬 것.
 * - krx: data.krx.co.kr OpenAPI (승인형 키 — 발급 승인 후 구현)
 * - rone: 부동산원 R-ONE 통계 API
 * - bea: 미 경제분석국 (GDP 원천 — 당분간 FRED 재수록본으로 대체)
 */
function stub(id: SourceAdapter["id"], name: string): SourceAdapter {
  return {
    id,
    name,
    requiresKey: true,
    async fetchSeries() {
      throw new SourceError(id, `${name} 어댑터는 아직 구현되지 않았습니다`);
    },
  };
}

export const krx = stub("krx", "한국거래소 KRX");
export const rone = stub("rone", "부동산원 R-ONE");
export const bea = stub("bea", "미 경제분석국 BEA");
