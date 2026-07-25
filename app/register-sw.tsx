"use client";

import { useEffect } from "react";

/** 서비스워커 등록 — 안드로이드 크롬의 "앱 설치"(WebAPK) 요건 충족용. */
const SW_PATH = "/sw.js";

export default function RegisterServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(SW_PATH).catch((e) => {
      // 등록 실패해도 앱 기능에는 영향이 없다 (설치 프롬프트만 안 뜸)
      console.warn("[sw] 등록 실패:", e);
    });
  }, []);

  return null;
}
