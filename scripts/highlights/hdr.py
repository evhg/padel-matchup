"""A phone often records HDR (10 bits, HLG or PQ, wide colours). Read as normal video it looks grey and flat.
This turns it into normal video (BT.709) with a tone curve. The first two reels did not, and looked washed out."""
import subprocess, numpy as np
_TAIL = "format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv"
def kind(video):
    """-> the transfer curve of the source when it is HDR ('arib-std-b67' = HLG, 'smpte2084' = PQ), else None."""
    t = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer', '-of', 'csv=p=0', video], capture_output=True, text=True).stdout.strip()
    return t if t in ('arib-std-b67', 'smpte2084') else None
def vf(trc):
    """The ffmpeg filter for frames read straight from the source."""
    return f"zscale=tin={trc}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,{_TAIL},format=yuv420p"
def sdr(frames, trc):
    """Frames that were already read without the conversion (BGR, uint8, [n, h, w, 3] or [h, w, 3]) -> converted."""
    one = frames.ndim == 3; a = frames[None] if one else frames; n, h, w, _ = a.shape
    f = (f"scale=out_color_matrix=bt2020:out_range=tv,format=yuv444p10le,setparams=color_primaries=bt2020:color_trc={trc}:colorspace=bt2020nc:range=tv,"
         f"zscale=tin={trc}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,{_TAIL},format=yuv444p")
    r = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{w}x{h}', '-i', '-', '-vf', f, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                       input=np.ascontiguousarray(a).tobytes(), capture_output=True, check=True)
    b = np.frombuffer(r.stdout, np.uint8).reshape(n, h, w, 3)
    return b[0].copy() if one else b
