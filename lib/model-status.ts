/**
 * 모델 바로가기 카드의 실시간 상태 줄 — 서버 전용.
 *
 * `lib/models.ts`에서 `health`를 선언한 모델만 대상이다. 규약은 그 파일의
 * ModelHealth가 단일 소스이고, 이 파일에는 모델별 URL·필드명을 두지 않는다.
 *
 * 원칙
 * - **가벼운 엔드포인트만** 부른다. 전체 데이터(수 MB)를 목록 화면에서 끌지 않는다.
 * - **실패는 조용히 넘기지 않는다.** 못 불러오면 사유를 화면에 그대로 적는다.
 * - **기준일 없는 수치는 내지 않는다.** generated_at을 못 읽으면 실패로 처리한다.
 * - 외부 앱이 죽어도 이 화면은 살아야 한다 — 모든 예외를 값으로 되돌린다.
 */
import type { ModelLink } from "./models";

/** 외부 상태 조회 제한시간 (ms) — 목록 화면이 여기 묶이면 안 된다 */
export const MODEL_STATUS_TIMEOUT_MS = 3500;

/** 상태 캐시 유지 시간 (초) — 하루 1회 갱신되는 대상이라 5분이면 충분하다 */
export const MODEL_STATUS_REVALIDATE_SECONDS = 300;

export interface ModelStatusMetric {
  label: string;
  value: string;
}

export type ModelStatus =
  | {
      ok: true;
      /** 원문 그대로의 기준일 문자열 (표시는 formatAsOf) */
      generatedAt: string;
      metrics: ModelStatusMetric[];
      /** 사람 확정 여부 — 선언이 없으면 null */
      confirmed: boolean | null;
    }
  | { ok: false; reason: string };

/** 제한시간을 넘긴 요청을 식별하는 표식 */
const TIMED_OUT = Symbol("model-status-timeout");

/**
 * 제한시간을 건다. fetch에 AbortSignal을 넘기지 않는 이유는 lib/search.ts와 같다 —
 * abort된 요청은 Next 데이터 캐시에 적재되지 않아 한 번 느렸던 대상이 영영
 * 캐시되지 않는 상태에 갇힌다. 여기서는 결과만 버리고 남은 요청은 캐시를 채운다.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(TIMED_OUT), ms);
      void work.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer)
      );
    }),
  ]);
}

/** 점경로로 JSON 값을 꺼낸다. 없으면 undefined */
function pick(payload: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, payload);
}

/** 카드에 실을 수 있는 스칼라만 문자열로 — 객체·배열·null은 표시하지 않는다 */
function scalarText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

/**
 * ISO8601 기준일을 표시형으로. **시간대를 변환하지 않는다** — 원천이 적어 보낸
 * 시각을 그대로 보이고 오프셋만 라벨로 바꾼다(+09:00 → KST). 서버·클라이언트
 * 로캘 차이로 표기가 흔들리는 것도 이 방식이면 생기지 않는다.
 */
export function formatAsOf(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?(Z|[+-]\d{2}:\d{2})?/);
  if (!m) return iso;
  const [, date, time, offset] = m;
  const zone = !offset ? "" : offset === "+09:00" ? " KST" : offset === "Z" ? " UTC" : ` ${offset}`;
  return `${date} ${time}${zone}`;
}

/** HTTP·파싱 실패를 사람이 읽을 수 있는 한 줄로 */
function reasonOf(error: unknown): string {
  if (error === TIMED_OUT) return `응답 없음 (${MODEL_STATUS_TIMEOUT_MS / 1000}초 초과)`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 모델의 상태 엔드포인트를 조회한다.
 * health 선언이 없으면 null(상태 줄을 렌더하지 않음), 그 외에는 항상 값으로 되돌린다.
 */
export async function fetchModelStatus(model: ModelLink): Promise<ModelStatus | null> {
  const health = model.health;
  if (!health) return null;

  const url = `${model.url.replace(/\/+$/, "")}${health.path}`;

  try {
    const payload = await withDeadline(
      (async () => {
        const res = await fetch(url, {
          next: { revalidate: MODEL_STATUS_REVALIDATE_SECONDS },
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as unknown;
      })(),
      MODEL_STATUS_TIMEOUT_MS
    );

    const generatedAt = scalarText(pick(payload, health.generatedAtPath));
    if (!generatedAt) return { ok: false, reason: "기준일(generated_at) 없음" };

    const metrics = (health.metrics ?? []).flatMap((metric) => {
      const value = scalarText(pick(payload, metric.path));
      return value === null ? [] : [{ label: metric.label, value }];
    });

    const confirmedRaw = health.confirmedPath ? pick(payload, health.confirmedPath) : undefined;

    return {
      ok: true,
      generatedAt,
      metrics,
      confirmed: typeof confirmedRaw === "boolean" ? confirmedRaw : null,
    };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}
