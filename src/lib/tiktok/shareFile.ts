import "server-only";
import { shareFileOf, type ShareFile } from "@/lib/domain/tiktok";

/** The reel host answers a HEAD from its store in well under a second; past this, the page says to try later. */
export const SHARE_CHECK_MS = 3000;

/**
 * Whether the reel host holds the reel's public version (`share.mp4`), which is the only file that goes to TikTok.
 * Reels made before TikTok sharing have none. One HEAD to the reel host, no body, `SHARE_CHECK_MS` at most, made
 * once by each request of "Share to TikTok" that needs it (the start, the posting page, Post) and by nothing else:
 * no column and no migration, and the match page and the reel page never ask. The rule is `shareFileOf`.
 */
export async function shareFileThere(shareUrl: string, fetchImpl: typeof fetch = fetch): Promise<ShareFile> {
  try {
    const res = await fetchImpl(shareUrl, { method: "HEAD", cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(SHARE_CHECK_MS) });
    await res.body?.cancel().catch(() => undefined);
    return shareFileOf(res.status);
  } catch {
    return shareFileOf(null);
  }
}
