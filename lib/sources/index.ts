import { SourceAdapter, SourceId } from "./types";
import { ecos } from "./ecos";
import { kosis } from "./kosis";
import { fred } from "./fred";
import { bls } from "./bls";
import { dart } from "./dart";
import { krx, rone, freesis, bea } from "./stubs";

export const sources: Record<SourceId, SourceAdapter> = {
  ecos,
  kosis,
  fred,
  bls,
  dart,
  krx,
  rone,
  freesis,
  bea,
};

export * from "./types";
