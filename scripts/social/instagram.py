"""Post a reel to the Kicksmash Instagram account (@kicksma.sh) through Meta's official API, after Claude has approved it.

usage:
  instagram.py check <file.mp4>                         the file against Meta's Reel rules (prints what fails)
  instagram.py post --url <public mp4 url> --caption <text> [--cover <jpeg url>] [--dry]
  instagram.py recent [--limit 10]                       the account's latest posts (for the daily summary)

The owner, 25 November 2026 (CLAUDE.md order 11): "you approve each post at first but send me a daily summary".
Order 10: only a reel that meets the v8 standard goes public, with the players' match sound. This script only posts;
the approval is the session's frame-by-frame check against the v8 table before it calls `post`.

The token is never in this file or in its arguments: it is a network secret of the Claude environment for
graph.facebook.com, which the session's proxy adds as "Authorization: Bearer ...". So every call goes through curl,
which uses that proxy. The account is IG_USER_ID (default: the @kicksma.sh business account, not a secret).

Meta's rules (developers.facebook.com, Instagram Platform, content publishing and IG User Media, read 26 November
2026): a container (POST /<ig>/media, media_type=REELS, video_url) is fetched and processed by Meta, then published
(POST /<ig>/media_publish, creation_id). Check the container's status_code once a minute, for no more than five
minutes. A container expires after 24 hours. 100 published posts and 400 containers per account per 24 hours. A Reel:
MP4 or MOV with the moov box before the media, H.264 or HEVC, 4:2:0, 23-60 frames a second, at most 1920 wide,
3 s to 15 min, at most 300 MB, AAC at 48 kHz or less. Meta's table says 128 kbps for the sound; a 312 kbps reel
passed as a container on 26 November 2026, so this script does not enforce it.
"""
import json, os, subprocess, sys, time, argparse

API = 'https://graph.facebook.com/v27.0'
IG = os.environ.get('IG_USER_ID', '17841480404956389')


def call(method, path, fields=None):
    """One Graph API call through curl (the proxy adds the token). Returns the JSON answer; raises on an error."""
    cmd = ['curl', '-sS', '--max-time', '60', '-X', method, f'{API}/{path}']
    for k, v in (fields or {}).items():
        cmd += ['--data-urlencode', f'{k}={v}']
    if method == 'GET' and fields: cmd.insert(cmd.index('-X') + 2, '-G')
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    if 'error' in j: raise RuntimeError(f"{path}: {j['error'].get('message')} (code {j['error'].get('code')})")
    return j


def check(path):
    """What in the file breaks Meta's Reel rules: an empty list when it passes."""
    p = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate:format=duration,size',
                                   '-of', 'json', path], capture_output=True, text=True, check=True).stdout)
    v = next((s for s in p['streams'] if s['codec_type'] == 'video'), None); a = next((s for s in p['streams'] if s['codec_type'] == 'audio'), None)
    bad = []
    if not v: return ['no video stream']
    if v['codec_name'] not in ('h264', 'hevc'): bad.append(f"video codec {v['codec_name']}")
    if v.get('pix_fmt') not in ('yuv420p', 'yuvj420p'): bad.append(f"pixel format {v.get('pix_fmt')}")
    n, d = (int(x) for x in v['r_frame_rate'].split('/')); fps = n / d if d else 0
    if not 23 <= fps <= 60: bad.append(f'{fps:.2f} frames a second')
    if int(v['width']) > 1920: bad.append(f"{v['width']} wide")
    dur, size = float(p['format']['duration']), int(p['format']['size'])
    if not 3 <= dur <= 900: bad.append(f'{dur:.1f} s long')
    if size > 300e6: bad.append(f'{size / 1e6:.0f} MB')
    if a and (a['codec_name'] != 'aac' or int(a.get('sample_rate', 0)) > 48000): bad.append(f"sound {a['codec_name']} {a.get('sample_rate')} Hz")
    with open(path, 'rb') as f:            # the moov box must come before the media (mdat)
        head = f.read(1 << 20)
    if head.find(b'moov') < 0 or (0 <= head.find(b'mdat') < head.find(b'moov')): bad.append('moov box not at the front (ffmpeg -movflags +faststart)')
    return bad


def post(url, caption, cover=None, dry=False):
    fields = {'media_type': 'REELS', 'video_url': url, 'caption': caption, 'share_to_feed': 'true'}
    if cover: fields['cover_url'] = cover
    if dry: print(json.dumps({'would_create': {k: (v if k != 'video_url' else '<url>') for k, v in fields.items()}})); return None
    cid = call('POST', f'{IG}/media', fields)['id']
    print(json.dumps({'container': cid}), flush=True)
    for _ in range(6):                     # once a minute, five minutes at most (Meta's guidance)
        time.sleep(60)
        st = call('GET', cid, {'fields': 'status_code,status'})
        print(json.dumps({'status': st.get('status_code')}), flush=True)
        if st.get('status_code') == 'FINISHED': break
        if st.get('status_code') in ('ERROR', 'EXPIRED'): raise RuntimeError(f"container {cid}: {st.get('status')}")
    else:
        raise RuntimeError(f'container {cid} not ready after five minutes; it stays valid for 24 hours')
    mid = call('POST', f'{IG}/media_publish', {'creation_id': cid})['id']
    link = call('GET', mid, {'fields': 'permalink'}).get('permalink')
    print(json.dumps({'published': mid, 'permalink': link}))
    return link


def recent(limit=10):
    for m in call('GET', f'{IG}/media', {'fields': 'id,caption,media_product_type,permalink,timestamp', 'limit': str(limit)}).get('data', []):
        print(json.dumps(m))


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('check'); c.add_argument('file')
    p = sub.add_parser('post'); p.add_argument('--url', required=True); p.add_argument('--caption', required=True); p.add_argument('--cover'); p.add_argument('--dry', action='store_true')
    r = sub.add_parser('recent'); r.add_argument('--limit', type=int, default=10)
    a = ap.parse_args()
    if a.cmd == 'check':
        bad = check(a.file); print(json.dumps({'ok': not bad, 'fails': bad})); sys.exit(1 if bad else 0)
    if a.cmd == 'post': post(a.url, a.caption, a.cover, a.dry)
    if a.cmd == 'recent': recent(a.limit)
