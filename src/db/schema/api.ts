// The public API: the keys, the webhooks and what became of each delivery.
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Public API: keys are optional (reads are open, writes are rate-limited per IP
// without one); a key raises limits and unlocks webhooks. Keys are stored hashed.
// ---------------------------------------------------------------------------
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyHash: text("key_hash").notNull(),
    /** First characters of the key, for display ("ks_live_ab12…"). */
    prefix: text("prefix").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    /** Free-form: which assistant or product uses the key ("claude", "chatgpt", "my-club-bot"). */
    agent: text("agent"),
    calls: bigint("calls", { mode: "number" }).notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.keyHash)],
);

export type ApiKey = typeof apiKeys.$inferSelect;

export type WebhookFilter = { venueSlug?: string | null; groupCode?: string | null; codes?: string[] | null };

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyId: uuid("key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** Subscribed event names ("match.created", …). */
    events: jsonb("events").$type<string[]>().notNull(),
    filter: jsonb("filter").$type<WebhookFilter>(),
    /** Shared secret for the HMAC signature header. */
    secret: text("secret").notNull(),
    failures: integer("failures").notNull().default(0),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhooks_key_idx").on(t.keyId)],
);

export type Webhook = typeof webhooks.$inferSelect;

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_deliveries_due_idx").on(t.nextAttemptAt), index("webhook_deliveries_webhook_idx").on(t.webhookId)],
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
