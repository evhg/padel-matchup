import { SHOT_LONG_SIDE, SHOT_MAX_BYTES } from "@/lib/domain/bookingShot";

/**
 * The browser's half of "Add screenshot": the picture the person picked, drawn again at 1568 pixels at
 * most on its longest side and saved as a JPEG under `SHOT_MAX_BYTES`, so the upload stays small and the
 * server action's 1 MB limit is never met. A JPEG because every browser's canvas makes one (Safari's
 * makes no WebP and quietly hands back a PNG). Quality steps down, then the size, until it fits; null
 * when the browser cannot open the file as a picture or no step fits. Browser only.
 */
export async function shrinkShot(file: Blob): Promise<Blob | null> {
  const picture = await open(file);
  if (!picture) return null;
  const { width, height } = picture;
  if (!width || !height) return null;
  const fit = Math.min(1, SHOT_LONG_SIDE / Math.max(width, height));
  for (const [scale, quality] of [
    [fit, 0.85],
    [fit, 0.7],
    [fit * 0.8, 0.7],
    [fit * 0.6, 0.6],
  ] as const) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // A transparent picture turns black as a JPEG without a ground under it.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(picture.source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", quality));
    if (blob && blob.type === "image/jpeg" && blob.size <= SHOT_MAX_BYTES) return blob;
  }
  return null;
}

async function open(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height };
  } catch {
    // An older browser without createImageBitmap for this type: an <img> reads it.
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
