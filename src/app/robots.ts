import type { MetadataRoute } from "next";
import { baseUrl } from "@/lib/config";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/p/", "/g/", "/admin", "/unsubscribe", "/me", "/new", "/*/manage/", "/*/i/", "/*/share", "/*/card", "/v/*/poster"] }],
    sitemap: `${baseUrl()}/sitemap.xml`,
  };
}
