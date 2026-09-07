import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Operator endpoints (/api/admin/*): the bearer CRON_SECRET, or a Vercel token
 * that can read this project (the credential the operator sessions already
 * hold). Set OPERATOR_VERCEL_PROJECT and OPERATOR_VERCEL_TEAM to enable the
 * second path; a token is checked against Vercel once and remembered briefly.
 */
const remembered = new Map<string, { ok: boolean; until: number }>();
const TTL = { ok: 15 * 60 * 1000, bad: 60 * 1000 };

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function operatorAuthorized(req: Request, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return false;
  const secret = process.env.CRON_SECRET;
  if (secret && same(token, secret)) return true;
  const project = process.env.OPERATOR_VERCEL_PROJECT;
  const team = process.env.OPERATOR_VERCEL_TEAM;
  if (!project || !team || token.length < 20) return false;
  const key = createHash("sha256").update(token).digest("hex");
  const seen = remembered.get(key);
  if (seen && seen.until > now) return seen.ok;
  let ok = false;
  try {
    const res = await fetchImpl(`https://api.vercel.com/v9/projects/${encodeURIComponent(project)}?teamId=${encodeURIComponent(team)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    ok = res.status === 200;
  } catch {
    ok = false;
  }
  remembered.set(key, { ok, until: now + (ok ? TTL.ok : TTL.bad) });
  return ok;
}

/** Tests only. */
export const forgetOperators = () => remembered.clear();
