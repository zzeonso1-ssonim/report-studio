#!/usr/bin/env python3
"""유동성 워치 v2 — 노션 파일 업로드(이미지 블록 첨부).

노션은 외부 URL 없이 파일을 붙일 때 3단계를 요구한다. 좌표·필드명은 config.notion.file_upload에서만 읽는다.
  ① POST /v1/file_uploads   {filename, content_type}  → {id, upload_url}
  ② POST {upload_url}        multipart/form-data, 파일 필드명은 config.form_field('file')
  ③ 블록 append 시           {"type":"image","image":{"type":"file_upload","file_upload":{"id":...}}}

**로컬에서는 검증할 수 없다** — 이 맥에 NOTION_TOKEN이 없다(그리고 키를 여기로 꺼내오지 않는다).
그래서 러너에서 workflow_dispatch input probe_charts=1로 실증한다. 절차·응답 형태를 추측으로
적지 않고, 프로브 실행 결과를 docs/liquidity-watch.md에 실측으로 남긴다.

멀티파트 본문은 표준 라이브러리로 직접 만든다(requests 의존 금지 — 이 저장소의 스크립트는
표준 라이브러리 + curl만 쓴다).
"""

from __future__ import annotations

import json
import mimetypes
import os
import uuid

NOTION_API = "https://api.notion.com/v1"


def _multipart(field_name, filename, content, content_type):
    """multipart/form-data 본문을 손으로 만든다. (body, content_type_header)"""
    boundary = "----liquidity-watch-%s" % uuid.uuid4().hex
    pre = (
        "--%s\r\n"
        'Content-Disposition: form-data; name="%s"; filename="%s"\r\n'
        "Content-Type: %s\r\n\r\n" % (boundary, field_name, filename, content_type)
    ).encode("utf-8")
    post = ("\r\n--%s--\r\n" % boundary).encode("utf-8")
    return pre + content + post, "multipart/form-data; boundary=%s" % boundary


def upload_image(notion, cfg, path):
    """PNG 한 장을 올리고 file_upload id를 돌려준다. 실패는 예외로 던진다(격리는 호출부 몫)."""
    fu = cfg["notion"]["file_upload"]
    filename = os.path.basename(path)
    size = os.path.getsize(path)
    if size > fu["max_bytes"]:
        raise RuntimeError("%s: %d바이트로 업로드 한도 %d를 넘는다"
                           % (filename, size, fu["max_bytes"]))
    ctype = fu["content_type"] or mimetypes.guess_type(filename)[0] or "application/octet-stream"

    created = notion.request("POST", fu["create_path"],
                             {"filename": filename, "content_type": ctype})
    upload_id = created.get("id")
    upload_url = created.get("upload_url")
    if not upload_id or not upload_url:
        raise RuntimeError("file_uploads 응답에 id/upload_url이 없다: %s"
                           % json.dumps(created, ensure_ascii=False)[:400])

    with open(path, "rb") as fh:
        content = fh.read()
    body, ct_header = _multipart(fu["form_field"], filename, content, ctype)
    sent = notion.request_absolute("POST", upload_url, body, ct_header)
    status = sent.get("status")
    if status and status != "uploaded":
        raise RuntimeError("업로드 후 status가 'uploaded'가 아니다: %r (%s)"
                           % (status, json.dumps(sent, ensure_ascii=False)[:300]))
    return upload_id


def image_block(upload_id, caption_rich_text):
    """업로드한 파일을 가리키는 이미지 블록. 캡션은 '이 그림의 주장' 한 문장 + as-of다."""
    return {"object": "block", "type": "image", "image": {
        "type": "file_upload", "file_upload": {"id": upload_id},
        "caption": caption_rich_text}}
