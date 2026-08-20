import ledger from "@/data/official-sources/motir-crude-import-cost.json";
import { SourceError, type SourceAdapter } from "./types";

export const motir: SourceAdapter = {
  id: "motir", name: "산업통상부 수출입 동향", requiresKey: false,
  async fetchSeries(params, range) {
    if (params.metric !== "crude_import_unit_cost") throw new SourceError("motir", "지원하지 않는 산업통상부 문서 지표입니다");
    return ledger.series
      .filter((point) => point.date >= range.start.slice(0, 7) && point.date <= range.end.slice(0, 7))
      .map((point) => ({ ...point, provenance: ledger.provenance }));
  },
};
