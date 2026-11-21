/**
 * What one call of a route costs on the machine that serves it, in one line of the runtime log.
 *
 * Vercel's free plan counts active CPU (4 hours a month for the whole account) and does not say which
 * route used it: the observability query answers 402 there. So the routes that run with no person behind
 * them measure themselves. `cpu_ms` is the processor time of the process during the call, `wall_ms` the
 * time on the clock, `up_s` the age of the process when the call came in. A young process is a cold
 * start, and `boot_cpu_ms` is then what the process had used before the call: the cost of loading the
 * code. Measured on a build machine on 21 November 2026, a warm `/mcp` call costs 3 to 5 ms and the
 * first call of a new process about 2 s, so one cold start costs as much as 400 warm calls or more.
 *
 * The process serves other calls at the same time, so a line can hold a part of a neighbour's work. Over
 * an hour of lines that evens out. The work a route hands to `after()` is not in its line.
 */
export function measured<A extends unknown[]>(route: string, fn: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    const before = process.cpuUsage();
    const t0 = Date.now();
    const up = process.uptime();
    try {
      return await fn(...args);
    } finally {
      const used = process.cpuUsage(before);
      console.info("cpu", {
        route,
        cpu_ms: Math.round((used.user + used.system) / 1000),
        wall_ms: Date.now() - t0,
        up_s: Math.round(up),
        ...(up < 30 ? { boot_cpu_ms: Math.round((before.user + before.system) / 1000) } : {}),
      });
    }
  };
}
