import { json, options, readJson } from "@/lib/api/http";
import { generateSchedule } from "@/lib/api/operations";
import { READ_CACHE, withApi } from "@/lib/api/route";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withApi(req, "read", async () => {
    const q = new URL(req.url).searchParams;
    const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
    const names = q.get("names")?.split(",").map((s) => s.trim()).filter(Boolean);
    return json(generateSchedule({ players: num("players"), names: names && names.length ? names : undefined, courts: num("courts"), rounds: num("rounds"), seed: num("seed"), format: "americano" }), { cache: READ_CACHE });
  });
}

export async function POST(req: Request) {
  return withApi(req, "read", async () => json(generateSchedule(await readJson(req))));
}

export async function OPTIONS() {
  return options();
}
