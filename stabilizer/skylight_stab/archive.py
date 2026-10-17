"""Tiny client for the pass archive Worker (docs/pass-archive.md). stdlib only.

PASS_ARCHIVE_URL (default https://passes.skylightceiling.com) and the ingest key: env
PASS_ARCHIVE_KEY, or the file named by PASS_ARCHIVE_KEY_FILE (default passes/.ingest-key next
to this package). The key is never logged.
"""
from __future__ import annotations

import json
import os
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("PASS_ARCHIVE_URL", "https://passes.skylightceiling.com").rstrip("/")
# Cloudflare answers the default Python-urllib agent with 403.
UA = "skylight-stabilizer/1 (+https://skylightceiling.com/passes)"
_HERE = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.environ.get("PASS_ARCHIVE_KEY_FILE", os.path.join(_HERE, "..", "..", "passes", ".ingest-key"))
# Cloudflare rejects request bodies over 100 MB (413): bigger files go up as R2 multipart in
# equal parts (R2: all but the last the same size, >= 5 MiB). Same numbers as the Pi uploader.
SINGLE_PUT_MAX = 90 << 20
PART_BYTES = 50 << 20


def _key() -> str:
    k = os.environ.get("PASS_ARCHIVE_KEY")
    if k:
        return k.strip()
    with open(KEY_FILE) as f:
        return f.read().strip()


def _req(method: str, path: str, *, body=None, headers=None, auth=False, timeout=120):
    h = {"user-agent": UA, **(headers or {})}
    if auth:
        h["authorization"] = f"Bearer {_key()}"
    last = None
    for attempt in range(4):
        req = urllib.request.Request(BASE + path, data=body, method=method, headers=h)
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429:
                detail = e.read()[:300].decode("utf-8", "replace")
                raise RuntimeError(f"{method} {path}: HTTP {e.code} {detail}") from None
            last = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
        time.sleep(2 * 2 ** attempt)
        if hasattr(body, "seek"):
            body.seek(0)
    raise RuntimeError(f"{method} {path}: {last}")


def get_json(path: str):
    with _req("GET", path) as r:
        return json.load(r)


def list_passes(**params) -> dict:
    return get_json("/api/passes?" + urllib.parse.urlencode(params))


def get_pass(pid: str) -> dict:
    return get_json(f"/api/passes/{pid}")


def download(pid: str, name: str, dest: str) -> int:
    tmp = dest + ".part"
    with _req("GET", f"/media/{pid}/{name}", timeout=300) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    os.replace(tmp, dest)
    return os.path.getsize(dest)


def part_ranges(size: int, part: int | None = None) -> list[tuple[int, int, int]]:
    """(partNumber, offset, length) for each multipart part: equal parts, the remainder last."""
    part = part or PART_BYTES
    return [(i // part + 1, i, min(part, size - i)) for i in range(0, size, part)]


def _json_req(method: str, path: str, body: bytes, ctype: str = "application/json", timeout=120) -> dict:
    with _req(method, path, body=body, auth=True, timeout=timeout,
              headers={"content-type": ctype, "content-length": str(len(body))}) as r:
        return json.load(r)


def _upload_multipart(pid: str, name: str, path: str, size: int) -> dict:
    base = f"/ingest/{pid}/{name}"
    uid = _json_req("POST", base + "?uploads", b"")["uploadId"]
    q = f"{base}?uploadId={urllib.parse.quote(uid, safe='')}"
    try:
        parts = []
        with open(path, "rb") as f:
            for n, off, length in part_ranges(size):
                f.seek(off)
                out = _json_req("PUT", f"{q}&partNumber={n}", f.read(length), "application/octet-stream", timeout=600)
                parts.append({"partNumber": n, "etag": out["etag"]})
        return _json_req("POST", f"{q}&complete", json.dumps({"parts": parts}).encode())
    except BaseException:
        try:
            _json_req("DELETE", q, b"")
        except Exception:
            pass
        raise


def upload(pid: str, name: str, path: str, ctype: str) -> dict:
    size = os.path.getsize(path)
    if size > SINGLE_PUT_MAX:
        out = _upload_multipart(pid, name, path, size)
    else:
        with open(path, "rb") as f:
            with _req("PUT", f"/ingest/{pid}/{name}", body=f, auth=True, timeout=600,
                      headers={"content-type": ctype, "content-length": str(size)}) as r:
                out = json.load(r)
    if not out.get("ok") or out.get("bytes") != size:
        raise RuntimeError(f"upload {pid}/{name}: {out}")
    return out


def post_pass(pid: str, meta: dict) -> dict:
    body = json.dumps(meta, ensure_ascii=False, separators=(",", ":")).encode()
    with _req("POST", f"/ingest/{pid}", body=body, auth=True,
              headers={"content-type": "application/json", "content-length": str(len(body))}) as r:
        return json.load(r)
