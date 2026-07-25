import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import RegisterServiceWorker from "./register-sw";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "경제데이터 통합조회",
  description: "한국·미국 공공 경제데이터 통합 조회",
  // 홈 화면 설치(PWA) — 아이콘은 public/의 정적 PNG라 인증 게이트를 통과한다
  // (동적 생성 아이콘 라우트는 확장자가 없어 게이트에 막힌다). 재생성: scripts/make_icons.py
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    // 홈 화면 아이콘 아래 표시되는 이름 — 길면 잘리므로 짧게
    title: "경제데이터",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#147b6d",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
