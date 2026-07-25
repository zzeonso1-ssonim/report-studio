"""econ-cockpit 앱 아이콘 생성 — AI OS 민트 팔레트.

디자인: 민트 대각 그라디언트 + 상승 라인차트 + 최신 지점 도트.
홈 화면에서 작게 보이므로 요소를 최소화하고(격자·면적 없음) 선을 굵게 잡는다.
iOS는 squircle로 모서리를 잘라내므로 모든 요소를 중앙 안전영역(21% 여백) 안에 둔다.
반투명 요소는 별도 RGBA 레이어에 그린 뒤 alpha_composite로 합성한다
(ImageDraw의 fill 알파는 배경과 블렌딩되지 않는 경우가 있다).

재생성: python3 make_icons.py  → public/ 아래 PNG 4종
"""

import os

from PIL import Image, ImageDraw, ImageFilter

SS = 4  # 슈퍼샘플 배율 (안티에일리어싱)

TOP = (28, 152, 134)    # 밝은 민트 (좌상단)
BOTTOM = (12, 78, 70)   # 짙은 민트 (우하단)
WHITE = (255, 255, 255)

OUT_DIR = "/Users/jeonsoyoung/Desktop/econ-cockpit/public"
PREVIEW = "/private/tmp/claude-501/-Users-jeonsoyoung-Desktop/db72840d-f23b-4db4-934b-36c5ddc387ea/scratchpad"


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def gradient(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    last = size - 1
    for y in range(size):
        for x in range(size):
            px[x, y] = lerp(TOP, BOTTOM, (x + y) / (2 * last))
    return img


def layer(size):
    return Image.new("RGBA", (size, size), (0, 0, 0, 0))


def draw_icon(out_size):
    S = out_size * SS
    base = gradient(S).convert("RGBA")

    pad = S * 0.21  # iOS squircle 마스킹 대비 안전영역
    w = h = S - pad * 2

    pts_norm = [(0.00, 0.80), (0.22, 0.60), (0.44, 0.68), (0.68, 0.34), (1.00, 0.10)]
    pts = [(pad + x * w, pad + y * h) for x, y in pts_norm]

    line = layer(S)
    ld = ImageDraw.Draw(line)
    lw = max(2, round(S * 0.050))
    ld.line(pts, fill=WHITE + (255,), width=lw, joint="curve")
    r = lw / 2
    for x, y in pts:  # 꼭짓점을 원으로 메워 라운드 조인 효과
        ld.ellipse([x - r, y - r, x + r, y + r], fill=WHITE + (255,))

    # 최신 지점 강조 도트 (흰 원 + 민트 속)
    lx, ly = pts[-1]
    outer = S * 0.070
    inner = outer * 0.42
    ld.ellipse([lx - outer, ly - outer, lx + outer, ly + outer], fill=WHITE + (255,))
    ld.ellipse(
        [lx - inner, ly - inner, lx + inner, ly + inner],
        fill=lerp(TOP, BOTTOM, 0.62) + (255,),
    )

    # 은은한 그림자 — 선을 배경에서 살짝 띄운다
    shadow = line.filter(ImageFilter.GaussianBlur(S * 0.012))
    dark = Image.new("RGBA", (S, S), (4, 40, 36, 0))
    dark.putalpha(shadow.split()[3].point(lambda a: int(a * 0.35)))
    base = Image.alpha_composite(base, dark)
    base = Image.alpha_composite(base, line)

    return base.resize((out_size, out_size), Image.LANCZOS)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    targets = {
        "apple-icon.png": 180,  # iOS 홈 화면
        "icon-192.png": 192,    # 안드로이드·PWA
        "icon-512.png": 512,    # PWA 스플래시
        "icon-32.png": 32,      # 브라우저 탭
    }
    for name, size in targets.items():
        path = os.path.join(OUT_DIR, name)
        # iOS는 투명 픽셀을 검게 칠하므로 RGB로 저장
        draw_icon(size).convert("RGB").save(path, "PNG")
        print(name, os.path.getsize(path), "bytes")

    draw_icon(512).convert("RGB").save(os.path.join(PREVIEW, "icon-preview.png"), "PNG")


if __name__ == "__main__":
    main()
