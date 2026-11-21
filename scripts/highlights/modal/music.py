"""Make a music sample with an open model (MusicGen, licence CC BY-NC 4.0: for a use that earns no money)."""
import modal, json
app = modal.App('kicksmash-music')
image = modal.Image.debian_slim(python_version='3.11').apt_install('ffmpeg').pip_install('torch==2.6.0', 'transformers>=4.45', 'accelerate', 'soundfile', 'scipy')


@app.function(image=image, gpu='L4', cpu=4, memory=16384, timeout=1800)
def make(prompt: str, takes: int = 2, seconds: int = 30):
    import torch, io, soundfile as sf
    from transformers import AutoProcessor, MusicgenForConditionalGeneration
    rid = 'facebook/musicgen-stereo-large'; pr = AutoProcessor.from_pretrained(rid); m = MusicgenForConditionalGeneration.from_pretrained(rid, torch_dtype=torch.float16).to('cuda')
    sr = m.config.audio_encoder.sampling_rate; outs = []
    for k in range(takes):
        torch.manual_seed(11 + k)
        a = m.generate(**pr(text=[prompt], padding=True, return_tensors='pt').to('cuda'), do_sample=True, guidance_scale=3.0, max_new_tokens=min(1503, seconds * 50 + 3))
        b = io.BytesIO(); sf.write(b, a[0].float().cpu().numpy().T, sr, format='WAV', subtype='PCM_16'); outs.append(b.getvalue())
    return outs


@app.local_entrypoint()
def main(prompt: str, out: str = 'take', takes: int = 2):
    for k, b in enumerate(make.remote(prompt, takes)): open(f'{out}-{k + 1}.wav', 'wb').write(b); print('wrote', f'{out}-{k + 1}.wav', len(b))
