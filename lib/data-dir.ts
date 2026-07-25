import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 파일 캐시 저장 루트의 단일 소스.
 *
 * 모든 파일 저장소(krx-store, fisis-store, dart-corp)는 경로를 직접 조립하지 말고
 * 이 모듈의 dataPath()만 사용한다. 경로 상수를 여기 한 곳에만 두는 이유는
 * 배포 환경마다 쓰기 가능한 위치가 다르기 때문이다.
 *
 * 결정 순서:
 *  1) process.env.DATA_DIR        — 명시 지정이 항상 최우선 (볼륨 마운트·테스트용)
 *  2) 읽기전용 런타임 감지 시 /tmp/econ-cockpit-data
 *     (Vercel/AWS Lambda 등 서버리스는 프로젝트 디렉터리가 읽기전용, /tmp만 쓰기 가능)
 *  3) 그 외(로컬 개발): <cwd>/.data
 *
 * ⚠️ /tmp 폴백은 "휘발성 캐시"다:
 *  - 인스턴스(람다 컨테이너)마다 별도의 /tmp → 인스턴스 간 공유되지 않음
 *  - 콜드스타트마다 비어 있음 → 캐시 적중률이 낮고 재수집이 잦음
 *  각 저장소의 의미(정확성/한도)는 해당 store 파일 주석 참조.
 */

/** 로컬 개발 기본값 (프로젝트 루트 상대) — .gitignore 등재 */
const LOCAL_DEFAULT_DIR = ".data";
/** 읽기전용 런타임에서 쓰기 가능한 유일한 위치 */
const EPHEMERAL_DIR = "/tmp/econ-cockpit-data";

/**
 * 프로젝트 디렉터리가 읽기전용인 서버리스 런타임인지 감지.
 * VERCEL / AWS_LAMBDA_FUNCTION_NAME·LAMBDA_TASK_ROOT(Vercel Functions 포함) / NETLIFY.
 */
function isReadOnlyRuntime(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT ||
      process.env.NETLIFY
  );
}

/**
 * 저장 루트 절대경로. 매 호출 시 환경변수를 다시 읽는다(테스트·런타임 주입 대응).
 *
 * turbopackIgnore 주석은 번들러의 정적 파일 추적(NFT)을 끄기 위한 것 —
 * 없으면 "경로가 완전히 동적"이라 판단해 프로젝트 전체를 서버리스 번들에 포함시킨다
 * (Turbopack 경고 "Encountered unexpected file in NFT list"). 여기서 다루는 건
 * 런타임 데이터 디렉터리일 뿐 번들에 포함할 소스가 아니므로 추적 대상이 아니다.
 */
export function dataRoot(): string {
  const explicit = process.env.DATA_DIR?.trim();
  if (explicit) return path.resolve(/*turbopackIgnore: true*/ explicit);
  if (isReadOnlyRuntime()) return EPHEMERAL_DIR;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), LOCAL_DEFAULT_DIR);
}

/**
 * 저장 루트가 휘발성(요청 간 보존이 보장되지 않음)인지.
 * DATA_DIR로 /tmp 이하를 지정한 경우도 휘발성으로 본다.
 * FISIS 호출 한도처럼 "영속성 자체가 정확성의 전제"인 곳에서 경고에 쓴다.
 */
export function isEphemeralDataRoot(): boolean {
  const root = dataRoot();
  return isReadOnlyRuntime() || root === EPHEMERAL_DIR || root.startsWith("/tmp/");
}

/** 저장 루트 하위 경로 조립 — 모든 저장소는 이 함수만 사용한다 */
export function dataPath(...segments: string[]): string {
  return path.join(/*turbopackIgnore: true*/ dataRoot(), ...segments);
}

// ── 실패해도 요청을 깨뜨리지 않는 파일 IO 헬퍼 ────────────────────
// 캐시는 "있으면 빠른 것"일 뿐이므로, 읽기 실패 = 캐시 없음, 쓰기 실패 = 경고 후 진행.

/** 같은 경고를 요청마다 반복 출력하지 않기 위한 1회성 로그 키 집합 */
const warned = new Set<string>();
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** JSON 읽기 — 파일 없음·파싱 실패·권한 오류 모두 fallback (캐시 미보유로 간주) */
export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * JSON 원자적 쓰기(임시파일 → rename). 성공 true / 실패 false.
 * 예외를 밖으로 던지지 않는다 — 읽기전용 파일시스템(EROFS/EACCES)에서도
 * 호출자는 API 응답을 그대로 반환할 수 있어야 하기 때문.
 */
export async function writeJsonFile(
  file: string,
  data: unknown,
  opts: { pretty?: boolean; warnKey?: string } = {}
): Promise<boolean> {
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(data, null, opts.pretty ? 2 : undefined), "utf-8");
    await fs.rename(tmp, file);
    return true;
  } catch (e) {
    warnOnce(
      opts.warnKey ?? file,
      `[data-dir] 캐시 쓰기 실패 (${file}): ${e instanceof Error ? e.message : String(e)}. ` +
        `캐시 없이 계속 진행합니다 — DATA_DIR을 쓰기 가능한 경로로 지정하면 해소됩니다.`
    );
    // 임시파일이 남았을 수 있으니 정리 시도 (실패는 무시)
    await fs.rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}
