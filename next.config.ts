import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * ECOS 항목명 색인은 런타임에 `process.cwd()/data`에서 읽는다
   * (lib/ecos-item-index.ts). 경로가 동적이라 파일 추적이 잡지 못하므로
   * 서버리스 번들에 명시적으로 포함시킨다 — 빠지면 항목명 매칭만 조용히
   * 꺼지고 "국고채 커브" 같은 질의가 다시 0건이 된다.
   */
  outputFileTracingIncludes: {
    "/api/*": ["./data/**/*.json"],
    "/api/**/*": ["./data/**/*.json"],
  },
};

export default nextConfig;
