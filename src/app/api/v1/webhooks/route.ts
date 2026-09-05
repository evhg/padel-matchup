import { ApiError, json, options, readJson } from "@/lib/api/http";
import { withApi } from "@/lib/api/route";
import { createWebhook, listWebhooks, WEBHOOK_EVENTS } from "@/lib/api/webhooks";

export const dynamic = "force-dynamic";

const requireKey = (key: { id: string } | null) => {
  if (!key) throw new ApiError(401, "key_required", "Webhooks need an API key.", "Get one instantly with POST /api/v1/keys and send it as Authorization: Bearer <key>.");
  return key;
};

export async function GET(req: Request) {
  return withApi(req, "read", async ({ db, caller }) => {
    const key = requireKey(caller.key);
    const rows = await listWebhooks(db, key.id);
    return json({ webhooks: rows.map((w) => ({ id: w.id, url: w.url, events: w.events, filter: w.filter, failures: w.failures, createdAt: w.createdAt.toISOString() })), events: WEBHOOK_EVENTS });
  });
}

export async function POST(req: Request) {
  return withApi(req, "write", async ({ db, caller }) => {
    const key = requireKey(caller.key);
    const body = (await readJson(req)) as { url?: string; events?: string[]; filter?: { venueSlug?: string; groupCode?: string; codes?: string[] } };
    const { webhook, secret } = await createWebhook(db, key.id, { url: body.url ?? "", events: body.events, filter: body.filter ?? null });
    return json(
      {
        webhook: { id: webhook.id, url: webhook.url, events: webhook.events, filter: webhook.filter, createdAt: webhook.createdAt.toISOString() },
        secret,
        signing: 'Each delivery carries X-Kicksmash-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<unix>.<raw body>"> using this secret. Reject anything older than five minutes.',
      },
      { status: 201 },
    );
  });
}

export async function OPTIONS() {
  return options();
}
