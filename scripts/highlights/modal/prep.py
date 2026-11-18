"""Prepare a match video that is on the Modal volume: cut its spatial sound track, and make a small working copy.

usage: modal run prep.py::spatial_main --name <folder>          (processor only)
       modal run prep.py::proxy_main --name <folder> [--seconds N]   (L4 graphics card)
spatial: /vol/<name>/spatial.mov, about 3 MB a minute, for Apple's decoder.
proxy:   /vol/<name>/proxy.mov, 1920x1080 at 30 frames a second, 10-bit HEVC with the colours of the source.
         The decode, the resize and the encode all stay on the graphics card.
         A key frame each second, so a clip can start at any second without a long decode.
"""
import modal, subprocess, time, os, json
app = modal.App('kicksmash-prep')
vol = modal.Volume.from_name('kicksmash-matches')
here = os.path.dirname(os.path.abspath(__file__))
cut_tool = os.path.join(here, '..', 'apac_cut.py') if os.path.exists(os.path.join(here, '..', 'apac_cut.py')) else os.path.join(here, '..', 'hl', 'apac_cut.py')
image = modal.Image.debian_slim(python_version='3.11').apt_install('ffmpeg').add_local_file(cut_tool, '/root/apac_cut.py')


def run(c, t=3 * 3600):
    a = time.time(); r = subprocess.run(c, shell=True, capture_output=True, text=True, timeout=t)
    return round(time.time() - a, 1), r.returncode, (r.stdout + r.stderr).strip()[-600:]


@app.function(image=image, cpu=2, memory=4096, timeout=3600, volumes={'/vol': vol})
def spatial(name: str):
    out = run(f'python /root/apac_cut.py /vol/{name}/video.mov /vol/{name}/spatial.mov')
    vol.commit(); return out


@app.function(image=image, gpu='L4', cpu=4, memory=8192, timeout=3 * 3600, volumes={'/vol': vol})
def proxy(name: str, seconds: int = 0):
    f, o = f'/vol/{name}/video.mov', f'/vol/{name}/proxy.mov' if not seconds else f'/tmp/proxy-test.mov'
    cut = f'-t {seconds}' if seconds else ''
    res = {}
    if seconds:
        res['decode_only'] = run(f'ffmpeg -v error -nostdin -hwaccel cuda -c:v hevc_cuvid -ss 600 {cut} -i {f} -an -f null -')
    res['proxy'] = run(f'ffmpeg -v error -nostdin -y -hwaccel cuda -hwaccel_output_format cuda -c:v hevc_cuvid -resize 1920x1080 '
                       f'{"-ss 600" if seconds else ""} {cut} -i {f} -map 0:v:0 -map 0:a:0 -r 30000/1001 -c:v hevc_nvenc -g 30 -preset p5 -rc vbr -cq 24 -b:v 0 -maxrate 9M -bufsize 18M '
                       f'-profile:v main10 -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -tag:v hvc1 -c:a aac -b:a 160k {o}')
    res['size_mb'] = round(os.path.getsize(o) / 1e6, 1) if os.path.exists(o) else 0
    res['probe'] = run(f'ffprobe -v error -show_entries stream=codec_name,width,height,avg_frame_rate,pix_fmt,color_transfer,nb_frames:format=duration -of json {o}')[2]
    if not seconds: vol.commit()
    return res


@app.local_entrypoint()
def spatial_main(name: str):
    print(spatial.remote(name))


@app.local_entrypoint()
def proxy_main(name: str, seconds: int = 0):
    for k, v in proxy.remote(name, seconds).items(): print(k, '|', v)
