import { fetchOfficial, htmlToText } from "./official-document";
import { SourceError, type SeriesPoint, type SourceAdapter } from "./types";

const LIST_URL = "https://www.customs.go.kr/kcs/na/ntt/selectNttList.do";
const DETAIL_URL = "https://www.customs.go.kr/kcs/na/ntt/selectNttInfo.do";
let cached: Promise<SeriesPoint[]> | undefined;

interface ReleaseLink { title: string; id: string; token: string; }

async function listPage(page: number): Promise<ReleaseLink[]> {
  const body = new URLSearchParams({
    bbsId: "1362", mi: "2891", currPage: String(page),
    searchType: "sj", searchValue: "수출입 현황 [잠정치]",
  });
  const response = await fetchOfficial("kcs", LIST_URL, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    allowedHosts: ["customs.go.kr"],
    maxBytes: 5 * 1024 * 1024,
  });
  const links: ReleaseLink[] = [];
  for (const anchor of response.text().matchAll(/<a\b[^>]*class="[^"]*nttInfoBtn[^"]*"[^>]*>[\s\S]*?<\/a>/gi)) {
    const tag = anchor[0];
    const title = /title="([^"]+)"/i.exec(tag)?.[1]?.trim();
    const id = /data-id="([^"]+)"/i.exec(tag)?.[1];
    const token = /data-url="([^"]+)"/i.exec(tag)?.[1];
    if (title && id && token && /^\d{4}년 \d{1,2}월 수출입 현황 \[잠정치\]$/.test(title)) {
      links.push({ title, id, token });
    }
  }
  return links;
}

async function parseRelease(release: ReleaseLink): Promise<SeriesPoint> {
  const url = `${DETAIL_URL}?nttSn=${encodeURIComponent(release.id)}&nttSnUrl=${encodeURIComponent(release.token)}`;
  const response = await fetchOfficial("kcs", url, {
    method: "GET", allowedHosts: ["customs.go.kr"], maxBytes: 5 * 1024 * 1024,
  });
  const text = htmlToText(response.text());
  const titlePeriod = /^(\d{4})년 (\d{1,2})월/.exec(release.title);
  const daily = /일평균\s*수출액\s*\[.*?\)\s*([0-9.]+)\s*,\s*\([^)]*\)\s*([0-9.]+)\s*억\s*달러\s*\]\s*([0-9.]+)\s*%\s*(증가|감소)/.exec(text);
  if (!titlePeriod || !daily) throw new SourceError("kcs", `${release.title} 일평균 수출액 표를 확인하지 못했습니다`);
  const previous = Number(daily[1]);
  const current = Number(daily[2]);
  const published = Number(daily[3]) * (daily[4] === "감소" ? -1 : 1);
  const recomputed = ((current / previous) - 1) * 100;
  if (![previous, current, published].every(Number.isFinite) || previous <= 0 || current <= 0 || Math.abs(recomputed - published) > 0.35) {
    throw new SourceError("kcs", `${release.title} 일평균 수출 증가율 검증에 실패했습니다`);
  }
  const date = `${titlePeriod[1]}-${titlePeriod[2].padStart(2, "0")}`;
  return {
    date,
    value: published,
    provenance: { publishedAt: date, sourceUrl: response.url, title: release.title, vintage: "월간 잠정치", note: `일평균 ${current}억달러` },
  };
}

async function collect(): Promise<SeriesPoint[]> {
  const releases: ReleaseLink[] = [];
  // 관세청 게시판은 병렬 POST 페이징을 누락할 때가 있어 순차 수집한다.
  for (let page = 1; page <= 20 && releases.length < 36; page += 1) {
    releases.push(...await listPage(page));
  }
  releases.splice(36);
  if (releases.length < 6) throw new SourceError("kcs", `월간 전체 잠정치를 충분히 확보하지 못했습니다(${releases.length}개)`);
  const points: SeriesPoint[] = [];
  for (let index = 0; index < releases.length; index += 6) {
    const batch = await Promise.allSettled(releases.slice(index, index + 6).map(parseRelease));
    points.push(...batch.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
  }
  if (points.length < 6) throw new SourceError("kcs", `일평균 수출액을 검증한 월이 부족합니다(${points.length}개)`);
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

export const kcs: SourceAdapter = {
  id: "kcs",
  name: "관세청 월간 수출입 현황",
  requiresKey: false,
  async fetchSeries(params, range) {
    if (params.metric !== "daily_average_export_yoy") throw new SourceError("kcs", "지원하지 않는 관세청 문서 지표입니다");
    cached ??= collect().catch((error) => { cached = undefined; throw error; });
    return (await cached).filter((point) => point.date >= range.start.slice(0, 7) && point.date <= range.end.slice(0, 7));
  },
};
