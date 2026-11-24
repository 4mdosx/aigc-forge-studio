#!/usr/bin/env python3
"""把 danbooru 补采候选灌进 runner 资产库，并回写 danbooru 标签。

为什么不走 `POST /capture/collected` 的 imgUrl 直下模式：runner 的 refererFor()
只认 pixiv 与 pinterest，其他一律送 pinterest 的 Referer，danbooru CDN 会回
Cloudflare 挑战页（5.8KB HTML）。所以本地先下好再 multipart 上传。

为什么用 sampleUrl 不用 fileUrl：original 路径稳定撞 Cloudflare 挑战（"Just a
moment..."），sample 是 850px 长边的 jpg，对 SDXL 训练（1024）足够，且不触发。

用法：
  .venv/bin/python scripts_and_tools/ingest_candidates.py \
      --batch mecha-core-artists --max-aspect 0.75 \
      --map-out data/capture/mecha-core-artists/ingested.json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import time
from pathlib import Path

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/125.0 Safari/537.36')
REF = 'https://danbooru.donmai.us/'
API = 'http://127.0.0.1:8787'


def is_img(b: bytes) -> bool:
    return b[:2] == b'\xff\xd8' or b[:4] == b'\x89PNG' or b[:4] == b'RIFF' or b[:2] == b'BM'


def download(url: str, dst: Path) -> bytes | None:
    if dst.exists():
        b = dst.read_bytes()
        if is_img(b):
            return b
    for extra in ([], ['-x', 'http://127.0.0.1:7897']):
        subprocess.run(['curl', '-s', '-m', '60', *extra, '-A', UA, '-H', f'Referer: {REF}',
                        '-o', str(dst), url], capture_output=True)
        if dst.exists():
            b = dst.read_bytes()
            if is_img(b):
                return b
        time.sleep(0.2)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--batch', required=True)
    ap.add_argument('--file', default='candidates-danbooru.json')
    ap.add_argument('--max-aspect', type=float, default=0.75)
    ap.add_argument('--min-mecha', type=int, default=1)
    ap.add_argument('--map-out', required=True)
    ap.add_argument('--cache', default='/tmp/db_ingest')
    args = ap.parse_args()

    src = Path('data/capture') / args.batch / args.file
    d = json.loads(src.read_text())
    sel = [x for x in d['items']
           if x['aspect'] <= args.max_aspect and len(x['flags']['mecha']) >= args.min_mecha]
    sel.sort(key=lambda x: x['aspect'])
    print(f'{src.name}: {len(d["items"])} 张 → 选中 {len(sel)} 张（aspect<={args.max_aspect}, mecha>={args.min_mecha}）')

    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    done: dict[str, dict] = {}
    out_path = Path(args.map_out)
    if out_path.exists():
        for r in json.loads(out_path.read_text()).get('records', []):
            done[str(r['post'])] = r

    records = list(done.values())
    ok = skip = 0
    for i, x in enumerate(sel):
        pid = str(x['id'])
        if pid in done:
            skip += 1
            continue
        fp = cache / f'{pid}.jpg'
        b = download(x['sampleUrl'] or x['previewUrl'], fp)
        if not b:
            print(f'  [{i:02d}] {pid} 下载失败，跳过')
            continue
        r = subprocess.run(
            ['curl', '-s', '-m', '180', '-X', 'POST', f'{API}/capture/collected',
             '-F', f'file=@{fp}', '-F', 'sourceType=crawler',
             '-F', f'sourceUrl=https://danbooru.donmai.us/posts/{pid}'],
            capture_output=True)
        try:
            j = json.loads(r.stdout)
        except Exception:
            print(f'  [{i:02d}] {pid} 入库响应异常')
            continue
        aid = j.get('id')
        if not aid:
            print(f'  [{i:02d}] {pid} 入库失败 {str(j)[:80]}')
            continue
        tags = []
        for k in ('general', 'character', 'copyright'):
            tags += x['tags'].get(k) or []
        subprocess.run(
            ['curl', '-s', '-X', 'PUT', f'{API}/capture/assets/{aid}',
             '-H', 'content-type: application/json',
             '-d', json.dumps({'tags': tags, 'rating': 'general',
                               'note': f'danbooru/{pid} · {(x["tags"]["artist"] or ["?"])[0]}'})],
            capture_output=True)
        rec = {'assetId': aid, 'post': pid, 'idx': i, 'aspect': x['aspect'],
               'artist': (x['tags']['artist'] or ['?'])[0],
               'mecha': len(x['flags']['mecha'])}
        records.append(rec)
        done[pid] = rec
        ok += 1
        if ok % 10 == 0:
            out_path.write_text(json.dumps({'records': records}, ensure_ascii=False, indent=1))
            print(f'  已入库 {ok}')

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({'records': records}, ensure_ascii=False, indent=1))
    print(f'完成：新入库 {ok}，已存在跳过 {skip}，累计 {len(records)} → {out_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
