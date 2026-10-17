"""python3 -m pytest stabilizer/tests  (archive client: multipart for files over the single-PUT cap)"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from skylight_stab import archive as A  # noqa: E402


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def _fake(calls, fail_part=None):
    def req(method, path, *, body=None, headers=None, auth=False, timeout=120):
        data = body.read() if hasattr(body, "read") else body
        calls.append((method, path, len(data or b"")))
        if method == "POST" and path.endswith("?uploads"):
            out = {"ok": True, "uploadId": "up/1"}
        elif "partNumber=" in path:
            n = int(path.rsplit("=", 1)[1])
            if n == fail_part:
                raise RuntimeError("HTTP 502")
            out = {"ok": True, "partNumber": n, "etag": f"e{n}"}
        elif path.endswith("&complete"):
            parts = json.loads(data)["parts"]
            out = {"ok": True, "bytes": sum(c[2] for c in calls if "partNumber=" in c[1]), "parts": parts}
        elif method == "DELETE":
            out = {"ok": True, "aborted": True}
        else:
            out = {"ok": True, "bytes": len(data)}
        return _Resp(json.dumps(out).encode())
    return req


def test_part_ranges_equal_parts_remainder_last():
    assert A.part_ranges(25, 10) == [(1, 0, 10), (2, 10, 10), (3, 20, 5)]
    assert A.part_ranges(20, 10) == [(1, 0, 10), (2, 10, 10)]
    assert [p[2] for p in A.part_ranges(134_000_000)] == [A.PART_BYTES, A.PART_BYTES, 134_000_000 - 2 * A.PART_BYTES]
    assert A.SINGLE_PUT_MAX < 100_000_000


def test_small_file_single_put(tmp_path, monkeypatch):
    p = tmp_path / "stab.json"
    p.write_bytes(b"{}")
    calls = []
    monkeypatch.setattr(A, "_req", _fake(calls))
    assert A.upload("x", "stab.json", str(p), "application/json")["bytes"] == 2
    assert calls == [("PUT", "/ingest/x/stab.json", 2)]


def test_big_file_multipart(tmp_path, monkeypatch):
    p = tmp_path / "clip.stab.mp4"
    p.write_bytes(bytes(range(256)) * 4)  # 1024 bytes
    calls = []
    monkeypatch.setattr(A, "_req", _fake(calls))
    monkeypatch.setattr(A, "SINGLE_PUT_MAX", 500)
    monkeypatch.setattr(A, "PART_BYTES", 400)
    out = A.upload("x", "clip.stab.mp4", str(p), "video/mp4")
    q = "/ingest/x/clip.stab.mp4?uploadId=up%2F1"
    assert calls == [
        ("POST", "/ingest/x/clip.stab.mp4?uploads", 0),
        ("PUT", q + "&partNumber=1", 400),
        ("PUT", q + "&partNumber=2", 400),
        ("PUT", q + "&partNumber=3", 224),
        ("POST", q + "&complete", calls[-1][2]),
    ]
    assert out["parts"] == [{"partNumber": n, "etag": f"e{n}"} for n in (1, 2, 3)]


def test_multipart_aborts_on_failure(tmp_path, monkeypatch):
    p = tmp_path / "clip.stab.mp4"
    p.write_bytes(b"\0" * 1024)
    calls = []
    monkeypatch.setattr(A, "_req", _fake(calls, fail_part=2))
    monkeypatch.setattr(A, "SINGLE_PUT_MAX", 500)
    monkeypatch.setattr(A, "PART_BYTES", 400)
    try:
        A.upload("x", "clip.stab.mp4", str(p), "video/mp4")
        raise AssertionError("expected failure")
    except RuntimeError as e:
        assert "502" in str(e)
    assert calls[-1] == ("DELETE", "/ingest/x/clip.stab.mp4?uploadId=up%2F1", 0)
