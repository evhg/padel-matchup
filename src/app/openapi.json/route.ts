import { json, options } from "@/lib/api/http";
import { openapiDocument } from "@/lib/api/openapi";
import { baseUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  return json(openapiDocument(baseUrl()), { cache: "public, max-age=300, s-maxage=3600" });
}

export async function OPTIONS() {
  return options();
}
