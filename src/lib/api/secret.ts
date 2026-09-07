/** Operator endpoints: only the bearer CRON_SECRET, and only when one is set. */
export function operatorAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
