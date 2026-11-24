#!/usr/bin/env python3
"""从参考图提取 openpose 骨架（SDPose），输出到指定目录。

为什么不用现成 pose 库：库里的姿态是 3D 写实人体渲染，带画风先验。
SDPose 只吐关节位置，SDPoseDrawKeypoints 画成彩色火柴人，是纯几何信息。
"""
import json, sys, urllib.request, uuid, os

COMFY = "http://192.168.8.136:8188"
CKPT = "sdpose_wholebody_fp16.safetensors"


def upload(path):
    boundary = "----" + uuid.uuid4().hex
    name = os.path.basename(path)
    with open(path, "rb") as f:
        data = f.read()
    body = b""
    body += f"--{boundary}\r\n".encode()
    body += f'Content-Disposition: form-data; name="image"; filename="{name}"\r\n'.encode()
    body += b"Content-Type: image/png\r\n\r\n" + data + b"\r\n"
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="type"\r\n\r\ninput\r\n'
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{COMFY}/upload/image", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return json.load(urllib.request.urlopen(req))["name"]


def build(ref, prefix):
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "2": {"class_type": "LoadImage", "inputs": {"image": ref}},
        "3": {"class_type": "SDPoseKeypointExtractor",
              "inputs": {"model": ["1", 0], "vae": ["1", 2], "image": ["2", 0], "batch_size": 16}},
        "4": {"class_type": "SDPoseDrawKeypoints",
              "inputs": {"keypoints": ["3", 0], "draw_body": True, "draw_hands": False,
                         "draw_face": False, "draw_feet": False, "stick_width": 6,
                         "face_point_size": 3, "score_threshold": 0.3, "draw_head": True}},
        "5": {"class_type": "SaveImage", "inputs": {"images": ["4", 0], "filename_prefix": prefix}},
    }


def run(path, outdir):
    ref = upload(path)
    wf = build(ref, f"refpose/{os.path.basename(path)[:-4]}")
    req = urllib.request.Request(f"{COMFY}/prompt",
                                 data=json.dumps({"prompt": wf, "client_id": "refpose"}).encode(),
                                 headers={"content-type": "application/json"})
    pid = json.load(urllib.request.urlopen(req))["prompt_id"]
    import time
    for _ in range(120):
        time.sleep(2)
        h = json.load(urllib.request.urlopen(f"{COMFY}/history/{pid}"))
        e = h.get(pid)
        if not e:
            continue
        if e.get("status", {}).get("status_str") == "error":
            raise RuntimeError(f"ComfyUI error for {path}: {json.dumps(e.get('status'))[:400]}")
        imgs = [i for o in e.get("outputs", {}).values() for i in o.get("images", [])]
        if imgs:
            i = imgs[0]
            q = urllib.parse.urlencode({"filename": i["filename"], "subfolder": i.get("subfolder", ""), "type": i.get("type", "output")})
            buf = urllib.request.urlopen(f"{COMFY}/view?{q}").read()
            out = os.path.join(outdir, os.path.basename(path))
            with open(out, "wb") as f:
                f.write(buf)
            print("  ->", out)
            return out
    raise TimeoutError(path)


import urllib.parse

if __name__ == "__main__":
    outdir = sys.argv[1]
    os.makedirs(outdir, exist_ok=True)
    for p in sys.argv[2:]:
        print("ref:", p)
        run(p, outdir)
