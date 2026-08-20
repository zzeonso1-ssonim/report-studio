import { fetchOfficial, htmlToText, pdfText } from "./official-document";
import { SourceError, type SeriesPoint, type SourceAdapter } from "./types";

const LIST_URL = "https://www.mpb.go.kr/web/main/bbs/b_0001?bcId=b_0001";
let cached: Promise<Record<string, SeriesPoint[]>> | undefined;

async function collect(): Promise<Record<string, SeriesPoint[]>> {
  const list = await fetchOfficial("mpb", LIST_URL, { method: "GET", allowedHosts: ["mpb.go.kr"], maxBytes: 5 * 1024 * 1024 });
  const listHtml = list.text();
  const detailHref = /href="([^"]*\/web\/main\/bbs\/b_0001\/\d+[^"]*)"[^>]*>「월간 재정동향」\s*(\d{4})년\s*(\d{1,2})월호 발간/.exec(listHtml)?.[1];
  if (!detailHref) throw new SourceError("mpb", "최신 월간 재정동향 게시물을 찾지 못했습니다");
  const detailUrl = new URL(detailHref.replaceAll("&amp;", "&"), LIST_URL).toString();
  const detail = await fetchOfficial("mpb", detailUrl, { method: "GET", allowedHosts: ["mpb.go.kr"], maxBytes: 5 * 1024 * 1024 });
  const html = detail.text();
  const attachmentBlock = [...html.matchAll(/<li>[\s\S]*?<\/li>/gi)]
    .map((match) => match[0])
    .find((block) => /\(책자\)[\s\S]*?월간 재정동향[\s\S]*?\.pdf/i.test(block));
  const attachment = attachmentBlock
    ? /href="([^"]*\/web\/main\/file\/download\/uu\/[^"]+)"/i.exec(attachmentBlock)
    : null;
  if (!attachment) throw new SourceError("mpb", "월간 재정동향 책자 PDF를 찾지 못했습니다");
  const pdfUrl = new URL(attachment[1], detailUrl).toString();
  const pdf = await fetchOfficial("mpb", pdfUrl, { method: "GET", allowedHosts: ["mpb.go.kr"], maxBytes: 20 * 1024 * 1024 });
  const text = await pdfText(pdf.bytes);
  if (!text.includes("재정운용동향") || !text.includes("국채시장")) throw new SourceError("mpb", "월간 재정동향 책자 구성을 검증하지 못했습니다");
  const revenue = /(\d{1,2})월\s*누계\s*총수입\s*은\s*([0-9]+(?:\.[0-9]+)?)조원[\s\S]{0,100}?진도율\s*은?\s*([0-9]+(?:\.[0-9]+)?)%/.exec(text);
  const expenditure = /(\d{1,2})월\s*누계\s*총지출\s*은\s*([0-9]+(?:\.[0-9]+)?)조원[\s\S]{0,100}?진도율\s*은?\s*([0-9]+(?:\.[0-9]+)?)%/.exec(text);
  const ktb = /1\s*[~～-]\s*(\d{1,2})월\s*국고채\s*발행량\s*은\s*([0-9]+(?:\.[0-9]+)?)조원[\s\S]{0,160}?([0-9]+(?:\.[0-9]+)?)%/.exec(text);
  if (!revenue || !expenditure || !ktb) throw new SourceError("mpb", "총수입·총지출·국고채 진도율 표를 모두 확인하지 못했습니다");
  const revenueRow = /\u25a0\s*총수입\s+((?:[0-9,.]+\s+){9,})/.exec(text)?.[1].match(/[0-9,.]+/g)?.map(Number);
  const expenditureRow = /\u25a0\s*총지출\s+((?:[0-9,.]+\s+){9,})/.exec(text)?.[1].match(/[0-9,.]+/g)?.map(Number);
  const ktbLimit = /발행한도액\s*기준\s*\(([0-9.]+)조원\)\s*중\s*개인투자용\s*국채\(([0-9.]+)조원\)\s*제외/.exec(text);
  const revenuePlan = revenueRow?.[6];
  const expenditurePlan = expenditureRow?.[6];
  const eligibleKtbLimit = ktbLimit ? Number(ktbLimit[1]) - Number(ktbLimit[2]) : null;
  const validations = [
    [Number(revenue[2]), revenuePlan, Number(revenue[3])],
    [Number(expenditure[2]), expenditurePlan, Number(expenditure[3])],
    [Number(ktb[2]), eligibleKtbLimit, Number(ktb[3])],
  ] as const;
  if (validations.some(([actual, plan, progress]) => plan == null || plan <= 0 || Math.abs((actual / plan) * 100 - progress) > 0.11)) {
    throw new SourceError("mpb", "진도율 누계액과 계획 분모가 공식 표의 공표치와 맞지 않습니다");
  }
  const issue = /「월간 재정동향」\s*(\d{4})년\s*(\d{1,2})월호/.exec(htmlToText(html));
  if (!issue) throw new SourceError("mpb", "월간 재정동향 발행월을 확인하지 못했습니다");
  const year = issue[1];
  const fiscalDate = `${year}-${revenue[1].padStart(2, "0")}`;
  const ktbDate = `${year}-${ktb[1].padStart(2, "0")}`;
  const provenance = { publishedAt: `${year}-${issue[2].padStart(2, "0")}`, sourceUrl: detail.url, title: `월간 재정동향 ${year}년 ${issue[2]}월호`, vintage: "해당 월호 계획 분모" };
  return {
    total_revenue_progress: [{ date: fiscalDate, value: Number(revenue[3]), provenance: { ...provenance, note: `누계 ${revenue[2]}조원 / 계획 ${revenuePlan}조원` } }],
    total_expenditure_progress: [{ date: `${year}-${expenditure[1].padStart(2, "0")}`, value: Number(expenditure[3]), provenance: { ...provenance, note: `누계 ${expenditure[2]}조원 / 계획 ${expenditurePlan}조원` } }],
    ktb_issuance_progress: [{ date: ktbDate, value: Number(ktb[3]), provenance: { ...provenance, note: `누계 ${ktb[2]}조원 / 개인투자용 제외 한도 ${eligibleKtbLimit}조원` } }],
  };
}

export const mpb: SourceAdapter = {
  id: "mpb", name: "기획예산처 월간 재정동향", requiresKey: false,
  async fetchSeries(params, range) {
    cached ??= collect().catch((error) => { cached = undefined; throw error; });
    const points = (await cached)[params.metric];
    if (!points) throw new SourceError("mpb", "지원하지 않는 월간 재정동향 지표입니다");
    return points.filter((point) => point.date >= range.start.slice(0, 7) && point.date <= range.end.slice(0, 7));
  },
};
