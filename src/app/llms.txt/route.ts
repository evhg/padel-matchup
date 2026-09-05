import { llmsTxt } from "@/lib/api/docs";
import { CORS_HEADERS } from "@/lib/api/http";
import { baseUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(llmsTxt(baseUrl()), { headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300, s-maxage=3600" } });
}
