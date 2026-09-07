import { indexNowKey } from "@/lib/indexnow";

export const dynamic = "force-dynamic";

/** The IndexNow key file: /indexnow/<key>.txt answers with the key, nothing else answers at all. */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const mine = indexNowKey();
  if (!mine || key !== `${mine}.txt`) return new Response("Not found", { status: 404 });
  return new Response(mine, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
