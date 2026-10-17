#!/usr/bin/env python3
"""TONGVEO web-config API (the camera's ONVIF encoder/imaging config is a stub).

  camweb.py get venc|vimg            print the encoder / image config (JSON)
  camweb.py set-venc <stream> <kbps> set a stream's bitrate (0 = main/clips, 1 = sub/vision)
  camweb.py set-vimg <cmd> <param>   one image setting, raw value, e.g. ExpComp 5
                                     (ExpComp is RAW 0..14, 7 = 0 EV, 5 = two steps darker; the web
                                     UI shows raw-7. A negative raw value is out of range and came out
                                     BRIGHTER on 2026-10-16.)

Setting the encoder restarts the RTSP streams; the tracker's ffmpeg pipelines reconnect.
CAMERA_IP / CAMERA_USER / CAMERA_PASS override the defaults.
"""
import json, os, sys, urllib.request

IP = os.environ.get("CAMERA_IP", "192.168.5.206")
USER = os.environ.get("CAMERA_USER", "admin")
PASS = os.environ.get("CAMERA_PASS", "admin")


def call(cmd, body):
    req = urllib.request.Request(f"http://{IP}/api/{cmd}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    out = json.load(urllib.request.urlopen(req, timeout=10))
    if str(out.get("errorCode")) != "0":
        sys.exit(f"{cmd}: {out}")
    return out.get("result")


def login():
    return call("setLogin", {"Username": USER, "Password": PASS, "lg": "en", "VerifyID": "", "ID": ""})["ID"]


def main(argv):
    sid = login()
    if argv[:1] == ["get"]:
        cmd = {"venc": "GetCfgVEnc", "vimg": "AjaxGetCfgVImg"}[argv[1]]
        print(json.dumps(call(cmd, {"Channel": 0, "ID": sid}), indent=1))
    elif argv[:1] == ["set-venc"]:
        stream, kbps = int(argv[1]), int(argv[2])
        v = call("GetCfgVEnc", {"Channel": 0, "ID": sid})["Vec"][stream]
        vec = {"VideoEncodeType": v["VideoEncodeType"], "Resolution": f"{v['ImageWidth']}x{v['ImageHeight']}",
               "KeyInterval": v["KeyInterval"], "Fr": v["FRNumerator"], "BitrateType": v["BitrateType"],
               "Bitrate": kbps, "Qulity": v["Qulity"], "Profiles": v["Profiles"]}
        call("SetCfgVEnc", {"saveAllChannel": 0, "setChannel": "0", "setStream": str(stream), "Vec": vec, "ID": sid})
        print(call("GetCfgVEnc", {"Channel": 0, "ID": sid})["Vec"][stream]["Bitrate"])
    elif argv[:1] == ["set-vimg"]:
        call("AjaxSetCfgVImg", {"saveAllChannel": 0, "setChannel": 0, "cmd": argv[1], "param": argv[2],
                                "profile": 0, "ID": sid})
        print(json.dumps(call("AjaxGetCfgVImg", {"Channel": 0, "ID": sid})["AE"]))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
