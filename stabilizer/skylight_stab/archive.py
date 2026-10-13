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


def upload(pid: str, name: str, path: str, ctype: str) -> dict:
    size = os.path.getsize(path)
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
