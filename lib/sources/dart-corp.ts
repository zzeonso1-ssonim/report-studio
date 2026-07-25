import { inflateRawSync } from "zlib";
import { SourceError, requireKey } from "./types";
import { dataPath, isEphemeralDataRoot, readJsonFile, warnOnce, writeJsonFile } from "../data-dir";

/**
 * DART 회사 고유번호(corp_code) 카탈로그.
 * https://opendart.fss.or.kr/api/corpCode.xml 은 zip(내부에 CORPCODE.xml 1개)으로 내려오며
 * 전체 회사(~11만 건)를 담고 있어 매 요청마다 받을 수 없다.
 * → <데이터루트>/dart/corp-codes.json 에 1회 캐시, 30일 경과 시 재다운로드
 *   (루트 결정은 lib/data-dir.ts).
 * zip 해제는 셸아웃 없이 Node 내장 zlib(inflateRaw)로 최소 구현.
 *
 * ⚠️ 휘발성 환경(Vercel 등 → /tmp)에서의 한계:
 * - JSON 캐시가 ~8.4MB다. /tmp는 인스턴스마다 별도이고 콜드스타트마다 비므로
 *   새 인스턴스의 첫 공시검색은 다운로드+파싱(수 초)을 다시 치른다.
 *   같은 인스턴스가 살아 있는 동안은 memCache(프로세스 메모리)로 즉시 응답한다.
 * - 파일 쓰기가 불가능해도 검색은 동작한다: 메모리 캐시만으로 그 인스턴스의
 *   수명 동안 재사용하고, 다음 콜드스타트에서 다시 받는다.
 * - 근본 해소책은 영속 저장소(DATA_DIR 볼륨 / 외부 DB)이거나, 검색을 DART의
 *   회사명 검색 API 쪽으로 옮기는 것. 현재는 전량 캐시 방식을 유지한다.
 */

export interface CorpEntry {
  corpCode: string;
  corpName: string;
  stockCode: string | null; // 상장사만 6자리, 비상장은 null
}

interface CorpCache {
  fetchedAt: string; // ISO
  count: number;
  corps: CorpEntry[];
}

/** 저장 위치 — 매 호출 시 계산 (DATA_DIR 런타임 주입 대응) */
const cacheFile = () => dataPath("dart", "corp-codes.json");
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일

/** ---- 최소 zip 해제 (단일/소수 엔트리, deflate 또는 store) ---- */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function unzipFirstEntry(buf: Buffer): Buffer {
  // EOCD(End of Central Directory)를 끝에서부터 탐색 (주석 최대 65535바이트 허용)
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SourceError("dart", "corpCode zip: EOCD를 찾지 못했습니다");

  const entryCount = buf.readUInt16LE(eocd + 10);
  let cenOffset = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(cenOffset) !== CEN_SIG)
      throw new SourceError("dart", "corpCode zip: central directory 손상");
    const method = buf.readUInt16LE(cenOffset + 10);
    const compSize = buf.readUInt32LE(cenOffset + 20);
    const nameLen = buf.readUInt16LE(cenOffset + 28);
    const extraLen = buf.readUInt16LE(cenOffset + 30);
    const commentLen = buf.readUInt16LE(cenOffset + 32);
    const locOffset = buf.readUInt32LE(cenOffset + 42);
    const name = buf.subarray(cenOffset + 46, cenOffset + 46 + nameLen).toString("utf8");

    // 첫 파일(또는 .xml 파일)을 대상으로 한다 — corpCode zip은 CORPCODE.xml 1개
    if (n === 0 || name.toLowerCase().endsWith(".xml")) {
      if (buf.readUInt32LE(locOffset) !== LOC_SIG)
        throw new SourceError("dart", "corpCode zip: local header 손상");
      const locNameLen = buf.readUInt16LE(locOffset + 26);
      const locExtraLen = buf.readUInt16LE(locOffset + 28);
      const dataStart = locOffset + 30 + locNameLen + locExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(data); // store
      if (method === 8) return inflateRawSync(data); // deflate
      throw new SourceError("dart", `corpCode zip: 지원하지 않는 압축방식 ${method}`);
    }
    cenOffset += 46 + nameLen + extraLen + commentLen;
  }
  throw new SourceError("dart", "corpCode zip: 엔트리를 찾지 못했습니다");
}

/** ---- CORPCODE.xml 파싱 (고정 포맷이므로 정규식으로 충분) ---- */

function parseCorpXml(xml: string): CorpEntry[] {
  const corps: CorpEntry[] = [];
  const listRe = /<list>([\s\S]*?)<\/list>/g;
  const field = (block: string, tag: string): string => {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : "";
  };
  let m: RegExpExecArray | null;
  while ((m = listRe.exec(xml)) !== null) {
    const block = m[1];
    const corpCode = field(block, "corp_code");
    const corpName = field(block, "corp_name");
    if (!corpCode || !corpName) continue;
    const stock = field(block, "stock_code");
    corps.push({
      corpCode,
      corpName,
      stockCode: /^\d{6}$/.test(stock) ? stock : null,
    });
  }
  return corps;
}

/** ---- 캐시 로드/갱신 ---- */

/**
 * 프로세스 내 재파싱 방지 겸, 파일 캐시를 못 쓰는 환경의 유일한 캐시.
 * 만료(30일 경과)된 값도 버리지 않는다 — 재다운로드가 실패하면 stale이라도
 * 반환하는 편이 검색 자체를 실패시키는 것보다 낫기 때문.
 */
let memCache: CorpCache | null = null;

async function downloadCorpCodes(): Promise<CorpCache> {
  const key = requireKey("dart", "DART_API_KEY");
  const res = await fetch(
    `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${key}`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new SourceError("dart", `corpCode 다운로드 실패 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 키 오류 등은 zip이 아니라 XML/JSON 에러 본문으로 온다
  if (buf.length < 4 || buf.readUInt16LE(0) !== 0x4b50) {
    const head = buf.toString("utf8", 0, 300);
    const msg = head.match(/<message>([\s\S]*?)<\/message>/)?.[1] ?? head.slice(0, 120);
    throw new SourceError("dart", `corpCode 응답이 zip이 아닙니다: ${msg}`);
  }
  const xml = unzipFirstEntry(buf).toString("utf8");
  const corps = parseCorpXml(xml);
  if (corps.length === 0) throw new SourceError("dart", "corpCode 파싱 결과가 비어 있습니다");

  const cache: CorpCache = {
    fetchedAt: new Date().toISOString(),
    count: corps.length,
    corps,
  };
  // 파일 쓰기 실패는 무시한다(경고만) — 이번 프로세스는 memCache로 계속 동작한다.
  const written = await writeJsonFile(cacheFile(), cache, { warnKey: "dart:corp-codes" });
  if (written && isEphemeralDataRoot()) {
    warnOnce(
      "dart:corp-codes-ephemeral",
      `[dart] corp_code 카탈로그(${corps.length}건)를 휘발성 경로에 캐시했습니다 — ` +
        `콜드스타트마다 재다운로드(수 MB)가 발생할 수 있습니다.`
    );
  }
  return cache;
}

export async function getCorpCatalog(): Promise<CorpCache> {
  const fresh = (c: CorpCache) =>
    Date.now() - new Date(c.fetchedAt).getTime() < CACHE_TTL_MS;
  const usable = (c: CorpCache | null): c is CorpCache =>
    Boolean(c && Array.isArray(c.corps) && c.corps.length > 0);

  if (usable(memCache) && fresh(memCache)) return memCache;

  // 파일 캐시 (읽기 실패·손상은 "캐시 없음"으로 간주)
  const cached = await readJsonFile<CorpCache | null>(cacheFile(), null);
  if (usable(cached) && fresh(cached)) {
    memCache = cached;
    return cached;
  }

  try {
    memCache = await downloadCorpCodes();
    return memCache;
  } catch (e) {
    // 다운로드 실패 — stale 캐시가 있으면 그것으로라도 검색을 계속한다.
    // (회사 고유번호는 거의 변하지 않으므로 만료본도 실용적으로 유효)
    const stale = usable(memCache) ? memCache : usable(cached) ? cached : null;
    if (stale) {
      warnOnce(
        "dart:corp-codes-stale",
        `[dart] corp_code 재다운로드 실패 — 만료된 캐시(${stale.fetchedAt})로 계속합니다: ` +
          `${e instanceof Error ? e.message : String(e)}`
      );
      memCache = stale;
      return stale;
    }
    throw e; // 캐시가 전혀 없으면 검색 불가 — 원래 오류를 그대로 노출
  }
}

/**
 * 회사명 부분일치 검색 → 상장사(stock_code 보유) 우선, 이름 짧은 순(정확 일치가 앞으로).
 */
export async function searchCorpsByName(
  name: string,
  limit = 20
): Promise<CorpEntry[]> {
  const q = name.replace(/\s+/g, "").toLowerCase();
  if (!q) return [];
  const { corps } = await getCorpCatalog();
  const matches = corps.filter((c) =>
    c.corpName.replace(/\s+/g, "").toLowerCase().includes(q)
  );
  matches.sort((a, b) => {
    const aListed = a.stockCode ? 0 : 1;
    const bListed = b.stockCode ? 0 : 1;
    if (aListed !== bListed) return aListed - bListed;
    if (a.corpName.length !== b.corpName.length)
      return a.corpName.length - b.corpName.length;
    return a.corpName.localeCompare(b.corpName, "ko");
  });
  return matches.slice(0, limit);
}
