"""Make full-length music with ACE-Step 1.5 (open model, MIT licence): 48 kHz stereo, up to ten minutes in one piece."""
import modal, json
app = modal.App('kicksmash-music-long')
image = (modal.Image.debian_slim(python_version='3.11').apt_install('ffmpeg', 'git')
         .pip_install('torch==2.6.0', 'torchaudio==2.6.0', 'transformers', 'accelerate', 'soundfile', 'sentencepiece', 'git+https://github.com/huggingface/diffusers.git'))


@app.function(image=image, gpu='L4', cpu=4, memory=24576, timeout=3000)
def make(jobs: list, seconds: float = 235.0, bpm: int = 100):
    import torch, io, soundfile as sf, traceback
    from diffusers import AceStepPipeline
    pipe = AceStepPipeline.from_pretrained('ACE-Step/acestep-v15-xl-turbo-diffusers', torch_dtype=torch.bfloat16).to('cuda'); pipe.vae.enable_tiling(); outs = []
    for name, prompt, lyrics, seed in jobs:
        try:
            a = pipe(prompt=prompt, lyrics=lyrics, audio_duration=seconds, bpm=bpm, timesignature='4', generator=torch.Generator(device='cuda').manual_seed(seed)).audios[0]
            b = io.BytesIO(); sf.write(b, a.T.cpu().float().numpy(), pipe.sample_rate, format='FLAC', subtype='PCM_24'); outs.append((name, b.getvalue(), pipe.sample_rate))
        except Exception: outs.append((name, traceback.format_exc()[-900:].encode(), 0))
    return outs


@app.local_entrypoint()
def main(jobs: str, out: str = '.', seconds: float = 235.0):
    for name, b, sr in make.remote(json.load(open(jobs)), seconds):
        if sr: open(f'{out}/{name}.flac', 'wb').write(b); print('wrote', name, len(b), sr)
        else: print('FAILED', name, b.decode())
