// A fake Playtomic for the browser suites' server, loaded before Next.js starts (`--import` in
// NODE_OPTIONS, set by e2e/run.mjs). It answers only the three kinds of address the reader of free court
// times asks for a club whose slug starts with "e2e-" (DECIDING rule 35): the club page, the day's
// availability for the fake tenant, and nothing else. Every other request goes to the real fetch, as
// before. So no suite ever calls Playtomic for these clubs, and no suite opens a checkout: the match
// page only builds Playtomic's checkout link from what this fake listed (DECIDING rule 36).
//
// The club lists two courts, free on every half hour of every day it is asked for, for 60, 90 and 120
// minutes, and its page loads the script known to build the checkout link, so the reader's check of that
// script says "same" and the checkout stays on.
const TENANT = "e2e0e2e0-0000-4000-8000-000000000001";
const COURTS = [
  { resourceId: "e2e0c0c1-0000-4000-8000-000000000001", name: "Court 1", sport: "PADEL" },
  { resourceId: "e2e0c0c2-0000-4000-8000-000000000002", name: "Court 2", sport: "PADEL" },
];
const BUILDER = "/_next/static/chunks/7105-b679921c03870a3f.js";

function clubPage(slug) {
  const tenant = { tenant_id: TENANT, tenant_name: "E2E Padel", slug, address: { timezone: "Europe/Madrid" }, resources: COURTS };
  const payload = `1d:["$","$L1d",null,{"tenant":${JSON.stringify(tenant)}}]\n`;
  return `<!DOCTYPE html><html><head><title>E2E Padel | Playtomic</title></head><body><script src="${BUILDER}" async=""></script><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`;
}

function day(date) {
  const slots = [];
  for (let m = 0; m < 24 * 60; m += 30) {
    const start_time = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
    for (const duration of [60, 90, 120]) slots.push({ start_time, duration, price: "24 EUR" });
  }
  return COURTS.map((c) => ({ resource_id: c.resourceId, start_date: date, slots }));
}

const realFetch = globalThis.fetch;
globalThis.fetch = async function fakePlaytomic(input, init) {
  let url;
  try {
    url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  } catch {
    return realFetch(input, init);
  }
  if (url.hostname === "playtomic.com") {
    const club = /^\/clubs\/(e2e-[a-z0-9-]{1,60})$/.exec(url.pathname);
    if (club) return new Response(clubPage(club[1]), { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/clubs/availability" && url.searchParams.get("tenant_id") === TENANT && /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") ?? "")) {
      return new Response(JSON.stringify(day(url.searchParams.get("date"))), { status: 200, headers: { "content-type": "application/json" } });
    }
  }
  return realFetch(input, init);
};
