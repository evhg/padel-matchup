import { baseUrl, ownerTelegramId } from "@/lib/config";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";

/**
 * A player sent the video of a match: the owner hears it once, on Telegram. `started`: the reel's job started by
 * itself (`fastReelStart`); otherwise a person starts the reel, and a video that nobody knows about is a reel that
 * never comes. No address of the video and no token is in the message: the match's own link is enough.
 */
export async function tellOwnerVideoHere(code: string, source: "upload" | "clips" | "link", started = false): Promise<void> {
  const owner = ownerTelegramId();
  if (!owner || !telegramEnabled()) return;
  const what = source === "clips" ? "The clips of a fast reel are here (the phone's own cut, no score)" : `A match video is here (${source === "upload" ? "an upload to the store" : "a link to a drive"})`;
  await sendMessage(owner, esc(`🎬 ${what}: ${baseUrl()}/${code}\n${started ? "The reel started by itself." : "The reel is not started yet."}`));
}
