import type { MetadataRoute } from "next";
import { getDb, type Db } from "@/db";
import { buildSitemap } from "@/lib/sitemap";

// Rendered on request: answer pages and club pages appear as soon as they exist (a build-time sitemap would freeze them).
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let db: Db | null = null;
  try {
    db = await getDb();
  } catch {
    db = null;
  }
  return buildSitemap(db, new Date());
}
