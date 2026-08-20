import { SourceAdapter, SourceId } from "./types";
import { ecos } from "./ecos";
import { kosis } from "./kosis";
import { kita } from "./kita";
import { kcs } from "./kcs";
import { mpb } from "./mpb";
import { motir } from "./motir";
import { fred } from "./fred";
import { bls } from "./bls";
import { dart } from "./dart";
import { fisis } from "./fisis";
import { krx } from "./krx";
import { rone } from "./rone";
import { bea } from "./stubs";

export const sources: Record<SourceId, SourceAdapter> = {
  ecos,
  kosis,
  kita,
  kcs,
  mpb,
  motir,
  fred,
  bls,
  dart,
  krx,
  rone,
  fisis,
  bea,
};

export * from "./types";
