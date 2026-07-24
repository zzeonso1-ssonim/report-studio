# 아키텍처

```mermaid
flowchart LR
  subgraph CLIENT["클라이언트 (브라우저)"]
    UI["대시보드 UI<br/>비교 차트 · 변환 · 테이블"]
    BOT["챗봇 (v2)<br/>function calling"]
  end

  subgraph SERVER["Next.js 서버 — API 키·캐시 (서버 전용)"]
    API["통합 API<br/>/api/series/{id}?transform=yoy|pop|rebase"]
    REG["지표 레지스트리<br/>lib/indicators.ts<br/>(지표→소스 매핑 단일 소스,<br/>원천기관 우선 + fallback)"]
    TR["변환 계층<br/>lib/transforms.ts<br/>YoY · 전기대비 · 재기준화"]
    AD["어댑터 계층<br/>lib/sources/*<br/>(인증·포맷·날짜표기 흡수)"]
  end

  subgraph KR["한국"]
    ECOS["한국은행 ECOS<br/>기준금리·환율·GDP"]
    KOSIS["통계청 KOSIS<br/>CPI"]
    DART["금감원 DART<br/>공시검색"]
    KRSTUB["KRX · R-ONE · FISIS<br/>(자리표시자)"]
  end

  subgraph US["미국"]
    FRED["FRED<br/>금리·GDP + 발표 캘린더(v2)"]
    BLS["BLS<br/>CPI"]
    USSTUB["BEA<br/>(자리표시자)"]
  end

  UI --> API
  BOT --> API
  API --> REG
  API --> TR
  REG --> AD
  AD --> ECOS
  AD --> KOSIS
  AD --> DART
  AD -.-> KRSTUB
  AD --> FRED
  AD --> BLS
  AD -.-> USSTUB
```

## 원칙

- **순수 소비자**: 계산·추정 로직 없음. 나우캐스팅 결과가 필요하면 기존 엔진(GDP/CPI) API만 호출.
- **키는 서버에서만**: 모든 기관 키는 환경변수 → 어댑터. 클라이언트에는 절대 미노출.
- **캐싱**: 어댑터의 외부 fetch에 revalidate 10분 — 기관 호출 한도 보호.
- **UI**: AI OS 민트 팔레트(#147b6d 계열)로 통일. 차트 시리즈 색은 색약 검증 팔레트 별도 사용.
