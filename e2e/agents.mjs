// Agent-native surfaces: developer page and key form, REST reads and writes, the MCP server,
// discovery files, calendar feed, booking link, and the simplified create screen.
import { BASE, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);
const tomorrow = () => {
  const d = new Date(Date.now() + 26 * 3600 * 1000);
  return `${d.toISOString().slice(0, 10)}T19:00`;
};

try {
  const ctx = await browser.newContext(iphone);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  const api = p.request;
  const j = async (r) => JSON.parse(await r.text());

  // ---- Developer page and instant key ----
  await p.goto(`${BASE}/developers`);
  await shot(p, "a1-developers");
  check("developer page opens with the value proposition", (await p.getByRole("heading", { name: /open, agent-native way to organise padel/ }).count()) === 1);
  await p.getByPlaceholder(/Who or what uses it/).fill("e2e bot");
  await p.getByRole("button", { name: "Get a key" }).click();
  await p.getByText("Your key, shown once").waitFor({ timeout: 15000 });
  const keyText = await p.locator("code").filter({ hasText: /^ks_live_/ }).first().innerText();
  check("key issued instantly, shown once", keyText.startsWith("ks_live_") && keyText.length > 30);

  // ---- Reads without a key ----
  const play = await api.get(`${BASE}/api/v1/matches/PLAY`);
  const playJ = await j(play);
  check("GET match returns public shape", play.status() === 200 && playJ.code === "PLAY" && Array.isArray(playJ.players) && playJ.players.length === 3 && playJ.spotsLeft === 1);
  const raw = await play.text();
  check("public shape carries no emails, tokens or manage links", !raw.includes("@") && !raw.includes("manage") && !raw.includes("personalToken"));
  check("CORS open for reads", play.headers()["access-control-allow-origin"] === "*");
  const missing = await api.get(`${BASE}/api/v1/matches/ZZZZ`);
  const missingJ = await j(missing);
  check("404 carries a hint", missing.status() === 404 && typeof missingJ.error.hint === "string");

  // ---- Create and join through REST ----
  const created = await api.post(`${BASE}/api/v1/matches`, { data: { startsAt: tomorrow(), tz: "Asia/Singapore", venue: "Club Nine", court: "2", bookingUrl: "https://example.com/book/123", listOnVenueBoard: true, levelMin: 3, levelMax: 4.5, organizer: { name: "Ana", level: 3.5 } } });
  const createdJ = await j(created);
  check("POST match creates and returns the three links", created.status() === 201 && /^[A-Za-z0-9]{4}$/.test(createdJ.match.code) && createdJ.organizer.manageUrl.includes("/manage/") && createdJ.organizer.personalUrl.includes("/p/") && createdJ.shareUrl.endsWith(createdJ.match.code));
  const code = createdJ.match.code;
  check("created match has the organizer seated with her level", createdJ.match.players.length === 1 && createdJ.match.players[0].level === 3.5 && createdJ.match.level.preset === "gold" && createdJ.match.listed === true);
  const joined = await api.post(`${BASE}/api/v1/matches/${code}/join`, { data: { name: "Bo", level: 3.25 } });
  const joinedJ = await j(joined);
  check("POST join seats an in-range player", joined.status() === 200 && joinedJ.outcome === "joined" && joinedJ.match.players.length === 2 && joinedJ.player.personalUrl.includes("/p/"));
  const needsLevel = await api.post(`${BASE}/api/v1/matches/${code}/join`, { data: { name: "Cy" } });
  check("join without a level on a ranged match explains what to pass", needsLevel.status() === 422 && (await j(needsLevel)).error.code === "level_required");
  const requested = await api.post(`${BASE}/api/v1/matches/${code}/join`, { data: { name: "Dee", level: 5.5 } });
  check("out-of-range join becomes a request", (await j(requested)).outcome === "requested");
  const again = await api.post(`${BASE}/api/v1/matches/${code}/join`, { data: { token: joinedJ.player.personalToken } });
  check("same token → already_in", (await j(again)).outcome === "already_in");

  // The web page reflects it.
  await p.goto(`${BASE}/${code}`);
  await shot(p, "a2-api-match");
  check("web page shows API-created match with booking button and players", (await p.getByText("Ana").count()) > 0 && (await p.getByText("Bo").count()) > 0 && (await p.getByRole("link", { name: /Booking/ }).count()) === 1);
  const board = await api.get(`${BASE}/api/v1/boards/club-nine`);
  check("venue board lists the listed match", board.status() === 200 && (await j(board)).matches.some((m) => m.code === code));
  const feed = await api.get(`${BASE}/v/club-nine/calendar.ics`);
  const feedText = await feed.text();
  check("venue calendar feed is a VCALENDAR with the match", feed.status() === 200 && feed.headers()["content-type"].startsWith("text/calendar") && feedText.includes("BEGIN:VEVENT") && feedText.includes(`/${code}`));

  // ---- Keys and webhooks ----
  const key = await j(await api.post(`${BASE}/api/v1/keys`, { data: { name: "e2e", agent: "playwright" } }));
  const noKey = await api.post(`${BASE}/api/v1/webhooks`, { data: { url: "https://example.com/hook" } });
  check("webhooks need a key, and say so", noKey.status() === 401 && (await j(noKey)).error.code === "key_required");
  const hook = await api.post(`${BASE}/api/v1/webhooks`, { headers: { Authorization: `Bearer ${key.key}` }, data: { url: "https://example.com/hook", events: ["match.created"] } });
  const hookJ = await j(hook);
  check("webhook created with a one-time secret", hook.status() === 201 && hookJ.secret.startsWith("whsec_") && hookJ.webhook.events[0] === "match.created");
  const list = await j(await api.get(`${BASE}/api/v1/webhooks`, { headers: { Authorization: `Bearer ${key.key}` } }));
  check("webhook listed for the key", list.webhooks.length === 1);
  const del = await api.delete(`${BASE}/api/v1/webhooks/${hookJ.webhook.id}`, { headers: { Authorization: `Bearer ${key.key}` } });
  check("webhook deleted", del.status() === 204);

  // ---- MCP ----
  const rpc = (body, headers = {}) => api.post(`${BASE}/mcp`, { headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, data: body });
  const init = await j(await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } }));
  check("MCP initialize negotiates the protocol and names the server", init.result.protocolVersion === "2025-06-18" && init.result.serverInfo.name === "kicksmash" && typeof init.result.instructions === "string");
  const notif = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  check("notifications are accepted with 202", notif.status() === 202);
  const tools = await j(await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  check("MCP lists the nine tools with schemas", tools.result.tools.length === 9 && tools.result.tools.every((t) => t.inputSchema && t.inputSchema.type === "object") && tools.result.tools.some((t) => t.name === "create_match"));
  const sched = await j(await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "generate_schedule", arguments: { players: 8 } } }));
  check("MCP generate_schedule returns 7 exact rounds", sched.result.structuredContent.rounds.length === 7 && sched.result.structuredContent.exact === true);
  const got = await j(await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_match", arguments: { code } } }));
  check("MCP get_match reads the API-created match", got.result.structuredContent.code === code && got.result.structuredContent.players.length === 2);
  const bad = await j(await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_match", arguments: { code: "ZZZZ" } } }));
  check("MCP tool errors are isError with a readable sentence", bad.result.isError === true && /No match/.test(bad.result.content[0].text));
  const mcpCreate = await j(await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "create_match", arguments: { startsAt: tomorrow(), tz: "Asia/Bangkok", venue: "Phuket Padel", organizer: { name: "Ivan" } } } }));
  check("MCP create_match works without a key", /^[A-Za-z0-9]{4}$/.test(mcpCreate.result.structuredContent.match.code) && mcpCreate.result.structuredContent.next.includes("shareUrl"));
  const unknown = await j(await rpc({ jsonrpc: "2.0", id: 7, method: "nope/nothing" }));
  check("unknown method → -32601", unknown.error.code === -32601);
  const getMcp = await api.get(`${BASE}/mcp`);
  check("GET /mcp says POST only", getMcp.status() === 405);
  const res = await j(await rpc({ jsonrpc: "2.0", id: 8, method: "resources/read", params: { uri: "kicksmash://docs/reference" } }));
  check("MCP resource carries the model reference", res.result.contents[0].text.includes("## Levels"));

  // ---- Discovery ----
  const llms = await api.get(`${BASE}/llms.txt`);
  check("llms.txt points to the MCP server and the API", llms.status() === 200 && (await llms.text()).includes("/mcp") && (await llms.text()).includes("/api/openapi.json"));
  const wk = await j(await api.get(`${BASE}/.well-known/mcp.json`));
  check("well-known mcp.json names the server URL", wk.servers[0].url.endsWith("/mcp") && wk.servers[0].transport === "streamable-http");
  const oa = await j(await api.get(`${BASE}/api/openapi.json`));
  check("OpenAPI 3.1 document with the match paths", oa.openapi === "3.1.0" && oa.paths["/api/v1/matches/{code}"] && oa.components.schemas.CreateMatch);
  const robots = await (await api.get(`${BASE}/robots.txt`)).text();
  check("robots.txt welcomes AI crawlers", robots.includes("GPTBot") && robots.includes("ClaudeBot") && robots.includes("PerplexityBot"));
  await p.goto(`${BASE}/agents`);
  check("agents page renders the charter", (await p.getByText("You may act for a person").count()) === 1);

  // ---- Simplified create screen ----
  await p.goto(`${BASE}/`);
  check("create screen is quiet: presets, listing and booking link behind More options", (await p.getByRole("button", { name: "Gold", exact: true }).count()) === 0 && (await p.getByText("Court booking link").count()) === 0 && (await p.getByText(/Any level · Waitlist/).count()) === 1);
  await p.getByRole("button", { name: /More options/ }).click();
  check("More options reveals them", (await p.getByRole("button", { name: "Gold", exact: true }).count()) === 1 && (await p.getByText("Court booking link").count()) === 1);
  await shot(p, "a3-create-more");
} catch (e) {
  console.error("✗ crashed:", e);
  results.push({ name: "crash", ok: false });
} finally {
  await browser.close();
}
finish(results);
