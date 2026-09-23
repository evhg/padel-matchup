import { getDb } from "@/db";
import { photoByCode } from "@/lib/domain/photos";

/**
 * A match's court photo, as an image. The first page draws the viewer's last one behind the card
 * they are typing (src/components/MatchCardPreview.tsx). Nothing here is newly public: the result
 * card anybody with the match's link can open already carries the same photo. The URL carries a
 * version, so a photo can be cached for a day and a replaced one still shows at once.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!/^[A-Za-z0-9]{3,12}$/.test(code)) return new Response("not found", { status: 404 });
  const photo = await photoByCode(await getDb(), code).catch(() => null);
  if (!photo) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(Buffer.from(photo.dataBase64, "base64")), {
    headers: { "content-type": photo.mime, "cache-control": "public, max-age=86400", "x-robots-tag": "noindex" },
  });
}
