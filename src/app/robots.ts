import type { MetadataRoute } from "next";
import { baseUrl } from "@/lib/config";

/** Private-by-link pages stay out of every index; everything else is open, including to AI crawlers. */
const PRIVATE = ["/api/", "/p/", "/g/", "/admin", "/unsubscribe", "/me", "/new", "/*/manage/", "/*/i/", "/*/share", "/*/card", "/v/*/poster"];

/**
 * Most sites block these. We invite them: an assistant can only recommend and
 * operate what it can read. Retrieval, search and training crawlers alike.
 */
export const AI_USER_AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "GoogleOther",
  "Applebot-Extended",
  "Amazonbot",
  "Bytespider",
  "CCBot",
  "cohere-ai",
  "DuckAssistBot",
  "Meta-ExternalAgent",
  "MistralAI-User",
  "YandexBot",
  "YouBot",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE },
      ...AI_USER_AGENTS.map((userAgent) => ({ userAgent, allow: ["/", "/llms.txt", "/llms-full.txt", "/api/openapi.json", "/.well-known/mcp.json", "/developers", "/agents"], disallow: PRIVATE })),
    ],
    sitemap: `${baseUrl()}/sitemap.xml`,
  };
}
