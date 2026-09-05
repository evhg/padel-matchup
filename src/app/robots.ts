import type { MetadataRoute } from "next";
import { baseUrl } from "@/lib/config";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/p/", "/admin", "/unsubscribe", "/me", "/new", "/*/manage/", "/*/i/", "/*/share", "/*/card"] }],
    sitemap: `${baseUrl()}/sitemap.xml`,
  };
}
