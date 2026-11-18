"""Bring a match video from a Google Drive link to a Modal volume, and read what kind of video it is.

usage: modal run ingest.py --file-id <Drive file id> --name <folder name on the volume>
The video is public by link ("anyone with the link"). It goes to /vol/<name>/video.mov; the sound goes beside it
as audio.flac (mono, 48 kHz). The job has no graphics card, so it needs no payment method.
"""
import modal, subprocess, json, os, time
app = modal.App('kicksmash-ingest')
vol = modal.Volume.from_name('kicksmash-matches', create_if_missing=True)
image = modal.Image.debian_slim(python_version='3.11').apt_install('ffmpeg', 'curl')

@app.function(image=image, cpu=4, memory=8192, timeout=4 * 3600, volumes={'/vol': vol})
def fetch(file_id: str, name: str):
    d = f'/vol/{name}'; os.makedirs(d, exist_ok=True); f = f'{d}/video.mov'; t = time.time()
    url = f'https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t'
    for k in range(6):           # continue where it stopped, when the line breaks
        r = subprocess.run(['curl', '-sS', '-L', '-C', '-', '--retry', '5', '--retry-delay', '10', '-o', f, url], capture_output=True, text=True)
        if r.returncode == 0: break
        print('download stopped:', r.stderr.strip()[-200:], 'try', k + 1, flush=True); time.sleep(15)
    size = os.path.getsize(f) if os.path.exists(f) else 0
    head = open(f, 'rb').read(600) if size else b''
    if size < 5_000_000 or b'<html' in head.lower():
        return {'ok': False, 'why': 'Drive did not give the video (a page came back: no permission, or too many downloads)', 'bytes': size, 'start': head[:200].decode('utf-8', 'replace')}
    t_dl = time.time() - t
    pr = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,color_transfer,color_primaries,channels,sample_rate,nb_frames:format=duration,bit_rate', '-of', 'json', f], capture_output=True, text=True).stdout)
    t2 = time.time()
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', f, '-map', '0:a:0', '-ac', '1', '-ar', '48000', f'{d}/audio.flac'], check=True)
    meta = {'ok': True, 'bytes': size, 'download_s': round(t_dl), 'mbit_s': round(size * 8 / 1e6 / max(t_dl, 1)), 'audio_s': round(time.time() - t2), 'probe': pr}
    json.dump(meta, open(f'{d}/meta.json', 'w')); vol.commit(); return meta

@app.local_entrypoint()
def main(file_id: str, name: str):
    m = fetch.remote(file_id, name)
    if not m.get('ok'): print(m); return
    v = [s for s in m['probe']['streams'] if s['codec_type'] == 'video'][0]; a = [s for s in m['probe']['streams'] if s['codec_type'] == 'audio']
    print(f"GB {m['bytes'] / 1e9:.2f}  download {m['download_s']} s at {m['mbit_s']} Mbit/s  sound {m['audio_s']} s")
    # a phone can add a second sound stream that ffprobe cannot name (four channels of spatial sound): do not fail on it
    print(f"video {v.get('codec_name')} {v.get('profile')} {v['width']}x{v['height']} {v['avg_frame_rate']} {v.get('pix_fmt')} {v.get('color_transfer')}  minutes {float(m['probe']['format']['duration']) / 60:.1f}  sound streams {[(x.get('codec_name'), x.get('channels')) for x in a]}")
