import { promises as fs } from "fs";
import path from "path";
import { inflateRawSync } from "zlib";
import { SourceError, requireKey } from "./types";

/**
 * DART 회사 고유번호(corp_code) 카탈로그.
 * https://opendart.fss.or.kr/api/corpCode.xml 은 zip(내부에 CORPCODE.xml 1개)으로 내려오며
 * 전체 회사(~11만 건)를 담고 있어 매 요청마다 받을 수 없다.
 * → .data/dart/corp-codes.json 에 1회 캐시, 30일 경과 시 재다운로드.
 * zip 해제는 셸아웃 없이 Node 내장 zlib(inflateRaw)로 최소 구현.
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

const CACHE_DIR = path.join(process.cwd(), ".data", "dart");
const CACHE_FILE = path.join(CACHE_DIR, "corp-codes.json");
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

let memCache: CorpCache | null = null; // 프로세스 내 재파싱 방지

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
  await fs.mkdir(CACHE_DIR, { recursive: true });
  // 부분 쓰기 방지: 임시 파일에 쓰고 rename
  const tmp = `${CACHE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache));
  await fs.rename(tmp, CACHE_FILE);
  return cache;
}

export async function getCorpCatalog(): Promise<CorpCache> {
  const fresh = (c: CorpCache) =>
    Date.now() - new Date(c.fetchedAt).getTime() < CACHE_TTL_MS;

  if (memCache && fresh(memCache)) return memCache;

  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    const cached = JSON.parse(raw) as CorpCache;
    if (Array.isArray(cached.corps) && cached.corps.length > 0 && fresh(cached)) {
      memCache = cached;
      return cached;
    }
  } catch {
    // 캐시 없음/손상 → 재다운로드
  }

  memCache = await downloadCorpCodes();
  return memCache;
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
