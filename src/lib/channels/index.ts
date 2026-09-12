import { discordChannel } from "./discord";
import { telegramChannel } from "./telegram";
import type { CardChannel } from "./types";

/** Every card channel the code knows, in the order they post. A new channel is one adapter and one line here. */
export const ALL_CHANNELS: CardChannel<never, never, never>[] = [telegramChannel as CardChannel<never, never, never>, discordChannel as CardChannel<never, never, never>];

/** The channels configured in this deployment. */
export const channels = (): CardChannel<never, never, never>[] => ALL_CHANNELS.filter((c) => c.enabled());

export { materialKey, postCard, postCardsForGroup, postResult, resultSummary, sendReminders, syncCards } from "./cards";
export type { Card, CardChannel, ChannelName, MessageId, PostOptions, Rendered, ResultSummary, Room, Sent } from "./types";
