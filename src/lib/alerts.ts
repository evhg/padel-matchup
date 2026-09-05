/**
 * Error counters for the read-only /admin health row. Best effort: never
 * throws, never blocks the request path. No external service.
 */
export async function reportError(kind: "server" | "client" | "cron", e?: unknown): Promise<void> {
  if (e) console.error(`[${kind}-error]`, e);
  try {
    const [{ getDb }, { bumpMetric }] = await Promise.all([import("@/db"), import("@/lib/domain/metrics")]);
    await bumpMetric(await getDb(), `errors_${kind}`);
  } catch {
    /* metrics are optional */
  }
}
