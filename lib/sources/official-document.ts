import { SourceError, type SourceId } from "./types";

const USER_AGENT = "Mozilla/5.0 (compatible; econ-cockpit/1.0; +official economic document collector)";

export async function fetchOfficial(
  source: SourceId,
  url: string,
  options: RequestInit & { maxBytes?: number; allowedHosts: string[] }
): Promise<{ bytes: Uint8Array; text(): string; url: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      ...options,
      headers: { "User-Agent": USER_AGENT, ...options.headers },
      redirect: "follow",
      signal: controller.signal,
      cache: "no-store",
    });
    const finalUrl = new URL(response.url);
    if (!options.allowedHosts.some((host) => finalUrl.hostname === host || finalUrl.hostname.endsWith(`.${host}`))) {
      throw new SourceError(source, "공식 도메인 밖으로 이동한 문서를 차단했습니다");
    }
    if (!response.ok) throw new SourceError(source, `HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const maxBytes = options.maxBytes ?? 15 * 1024 * 1024;
    if (bytes.byteLength > maxBytes) throw new SourceError(source, "공식 문서 크기 한도를 넘었습니다");
    return {
      bytes,
      url: response.url,
      text: () => new TextDecoder("utf-8").decode(bytes),
    };
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(source, error instanceof Error && error.name === "AbortError" ? "공식 문서 응답 시간을 초과했습니다" : "공식 문서를 가져오지 못했습니다");
  } finally {
    clearTimeout(timeout);
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/td|\/th|\/h\d)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_, name: string) => ({
      nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    })[name.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function pdfText(bytes: Uint8Array): Promise<string> {
  if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("PDF 파일 형식이 아닙니다");
  }
  // Node에서는 워커 모듈을 먼저 로드하면 PDF.js가 가짜 워커 경로를
  // 번들 상대경로로 다시 찾지 않아 Next 라우트에서도 안정적이다.
  const workerModule = "pdfjs-dist/legacy/build/pdf.worker.mjs";
  await import(/* webpackIgnore: true */ workerModule);
  const pdfModule = "pdfjs-dist/legacy/build/pdf.mjs";
  const pdfjs = await import(/* webpackIgnore: true */ pdfModule);
  const document = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item: { str?: string }) => item.str ?? "").join(" "));
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }
  return pages.join("\n").replace(/\s+/g, " ").trim();
}
