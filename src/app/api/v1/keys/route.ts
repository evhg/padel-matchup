import { json, options, readJson } from "@/lib/api/http";
import { createApiKey } from "@/lib/api/keys";
import { withApi } from "@/lib/api/route";
import { LIMITS } from "@/lib/domain/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return withApi(req, "keys", async ({ db }) => {
    const body = (await readJson(req)) as { name?: string; email?: string; agent?: string };
    const { key, record } = await createApiKey(db, { name: body.name ?? "", email: body.email, agent: body.agent });
    return json(
      {
        key,
        prefix: record.prefix,
        name: record.name,
        limits: { writesPerDay: LIMITS.apiWritesPerKeyPerDay, readsPerHour: LIMITS.apiReadsPerIpPerHour * 5, webhooks: LIMITS.webhooksPerKey },
        next: "Store the key; it is shown once. Send it as Authorization: Bearer <key>.",
      },
      { status: 201 },
    );
  });
}

export async function OPTIONS() {
  return options();
}
