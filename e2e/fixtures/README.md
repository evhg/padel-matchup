# Fixtures

`film-aac.mp4`: 100 seconds, a plain blue picture of 160 × 90 at 10 pictures a second (H.264) with AAC
sound at 48 kHz. The sound is the Rally Finder's own synthetic match (`RF.synthMatch(100, 48000, 7)`):
three rallies, a quieter court next door, talk and noise. No person and no real match is in it. The
viral suite gives it to "Make a fast reel", and the page must find the rallies and cut them out.

Made with:

```bash
node -e '/* the core of public/lab/rally-finder.html */ ...synthMatch(100, 48000, 7) -> synth.wav'
ffmpeg -f lavfi -i "color=c=0x1f4fd0:s=160x90:r=10" -i synth.wav -t 100 \
  -c:v libx264 -preset veryslow -crf 30 -g 10 -pix_fmt yuv420p -c:a aac -b:a 48k -ac 2 film-aac.mp4
```
