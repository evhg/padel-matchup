import { baseUrl, ownerTelegramId } from "@/lib/config";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";

/**
 * A player sent the video of a match: the owner hears it once, on Telegram. Until the engine starts by
 * itself, a person starts the reel, and a video that nobody knows about is a reel that never comes.
 * No address of the video and no token is in the message: the match's own link is enough.
 */
export async function tellOwnerVideoHere(code: string, source: "upload" | "link"): Promise<void> {
  const owner = ownerTelegramId();
  if (!owner || !telegramEnabled()) return;
  const how = source === "upload" ? "an upload to the store" : "a link to a drive";
  await sendMessage(owner, esc(`🎬 A match video is here (${how}): ${baseUrl()}/${code}\nThe reel is not started yet.`));
}
