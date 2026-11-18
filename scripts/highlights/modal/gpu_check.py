"""Does an L4 machine on Modal start, and can its graphics card decode the match video? One minute of work."""
import modal, subprocess, time
app = modal.App('kicksmash-gpu-check')
vol = modal.Volume.from_name('kicksmash-matches')
image = modal.Image.debian_slim(python_version='3.11').apt_install('ffmpeg')

@app.function(image=image, gpu='L4', cpu=4, memory=8192, timeout=600, volumes={'/vol': vol})
def look():
    def run(c, t=300):
        a = time.time(); r = subprocess.run(c, shell=True, capture_output=True, text=True, timeout=t); return round(time.time() - a, 1), (r.stdout + r.stderr).strip()[-300:]
    f = '/vol/match1/video.mov'; out = {'gpu': run('nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader')[1], 'cpus': run('nproc')[1]}
    out['cpu_decode_120s'] = run(f'ffmpeg -v error -nostdin -ss 600 -t 120 -i {f} -an -f null -')
    out['gpu_decode_120s'] = run(f'ffmpeg -v error -nostdin -hwaccel cuda -c:v hevc_cuvid -ss 600 -t 120 -i {f} -an -f null -')
    out['gpu_decode_to_frames'] = run(f'ffmpeg -v error -nostdin -hwaccel cuda -c:v hevc_cuvid -ss 600 -t 120 -i {f} -an -vf scale=1280:720,format=rgb24 -f rawvideo -y /dev/null')
    return out

@app.local_entrypoint()
def main():
    for k, v in look.remote().items(): print(k, '|', v)
