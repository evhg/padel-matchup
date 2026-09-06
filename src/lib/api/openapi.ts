import { z } from "zod";
import { APP_NAME } from "@/lib/config";
import { VALUE_PROP } from "./docs";
import { createMatchSchema, joinMatchSchema, scheduleSchema } from "./operations";
import { WEBHOOK_EVENTS } from "./webhooks";

const schema = (s: z.ZodType) => {
  const j = z.toJSONSchema(s, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
  delete j.$schema;
  return j;
};

const errorSchema = {
  type: "object",
  properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, hint: { type: "string" }, status: { type: "integer" }, docs: { type: "string" } }, required: ["code", "message", "status"] } },
  required: ["error"],
};

const level = { type: ["object", "null"], properties: { min: { type: ["number", "null"] }, max: { type: ["number", "null"] }, preset: { type: ["string", "null"], description: "bronze, silver, gold, platinum or custom" } } };

const publicMatch = {
  type: "object",
  description: "Exactly what the public match page shows. First names and levels only; never emails, phones, tokens or manage links.",
  properties: {
    code: { type: "string" },
    url: { type: "string" },
    type: { type: "string", enum: ["match", "tournament"] },
    title: { type: ["string", "null"] },
    status: { type: "string", enum: ["open", "full", "cancelled", "past"] },
    startsAt: { type: "string", format: "date-time" },
    endsAt: { type: "string", format: "date-time" },
    tz: { type: "string" },
    venue: { type: ["object", "null"], properties: { name: { type: "string" }, slug: { type: ["string", "null"] }, mapUrl: { type: ["string", "null"] }, court: { type: ["string", "null"] }, boardUrl: { type: ["string", "null"] } } },
    capacity: { type: "integer" },
    players: { type: "array", items: { type: "object", properties: { name: { type: "string" }, level: { type: ["number", "null"] }, organizer: { type: "boolean" }, status: { type: "string", enum: ["joined", "confirmed", "invited"] } } } },
    spotsLeft: { type: "integer" },
    waitlist: { type: "integer" },
    whenFull: { type: "string", enum: ["waitlist", "closed"] },
    level,
    group: { type: ["object", "null"], properties: { code: { type: "string" }, name: { type: "string" }, url: { type: "string" } } },
    listed: { type: "boolean" },
    bookingUrl: { type: ["string", "null"] },
    cost: { type: ["string", "null"], description: "What each player pays, free text." },
    note: { type: ["string", "null"] },
    result: { type: ["object", "null"], properties: { sets: { type: "array", items: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } } } }, teamA: { type: "array", items: { type: "string" } }, teamB: { type: "array", items: { type: "string" } }, confirmed: { type: "boolean" } } },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["code", "url", "type", "status", "startsAt", "tz", "capacity", "players", "spotsLeft"],
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (s: unknown, required = true) => ({ required, content: { "application/json": { schema: s } } });
const jsonResponse = (description: string, s: unknown) => ({ description, content: { "application/json": { schema: s } } });
const errors = { "422": jsonResponse("Invalid request; the message names the field", ref("Error")), "429": jsonResponse("Rate limited; the hint says how to get more room", ref("Error")) };

export function openapiDocument(base: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: `${APP_NAME} API`,
      version: "1.0.0",
      summary: VALUE_PROP,
      description:
        "Reads need no key. Writes work without a key with a daily allowance per address; a free key (POST /api/v1/keys, issued instantly to people and assistants alike) raises it and unlocks webhooks. Public data is CC BY 4.0; the code is Apache-2.0. An MCP server with the same capabilities lives at /mcp.",
      license: { name: "CC BY 4.0 (data), Apache-2.0 (code)", url: "https://github.com/evhg/padel-matchup/blob/main/LICENSE" },
      contact: { url: `${base}/developers` },
    },
    servers: [{ url: base }],
    externalDocs: { description: "Developer guide, MCP server and agent charter", url: `${base}/developers` },
    tags: [
      { name: "matches", description: "Create, read and join matches and tournaments" },
      { name: "venues", description: "Public venue boards" },
      { name: "clubs", description: "Club pages: booking links, free courts, founding clubs" },
      { name: "groups", description: "Crews that play together" },
      { name: "schedules", description: "Americano rotations, no data stored" },
      { name: "keys", description: "Optional keys for roomier limits and webhooks" },
      { name: "webhooks", description: "Signed callbacks on match events" },
    ],
    paths: {
      "/api/v1/matches/{code}": {
        get: { tags: ["matches"], operationId: "getMatch", summary: "A match by its 4-character code", parameters: [{ name: "code", in: "path", required: true, schema: { type: "string", minLength: 4, maxLength: 4 } }], responses: { "200": jsonResponse("The match", ref("Match")), "404": jsonResponse("No such match", ref("Error")) } },
      },
      "/api/v1/matches": {
        post: {
          tags: ["matches"],
          operationId: "createMatch",
          summary: "Create a match or an americano tournament",
          description: "Returns the public match plus the organizer's personal token, personal link and private manage link. Give those to the person you act for; never publish them.",
          security: [{}, { bearer: [] }],
          requestBody: jsonBody(ref("CreateMatch")),
          responses: { "201": jsonResponse("Created", ref("CreateMatchResult")), ...errors },
        },
      },
      "/api/v1/matches/{code}/join": {
        post: {
          tags: ["matches"],
          operationId: "joinMatch",
          summary: "Join a match by name (or by an existing personal token)",
          description: "Outcomes: joined, waitlisted, already_in, full, or requested when the player's level is outside the match's range (the organizer approves on the match page).",
          security: [{}, { bearer: [] }],
          parameters: [{ name: "code", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody(ref("JoinMatch")),
          responses: { "200": jsonResponse("Result", ref("JoinMatchResult")), "404": jsonResponse("No such match", ref("Error")), ...errors },
        },
      },
      "/api/v1/boards/{slug}": {
        get: { tags: ["venues"], operationId: "getBoard", summary: "Open, organizer-listed matches at a venue", parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" }, description: "Lower-case venue name with dashes, e.g. padel-indoor-bcn" }], responses: { "200": jsonResponse("The board", ref("Board")), "404": jsonResponse("Unknown venue", ref("Error")) } },
      },
      "/api/v1/clubs": {
        get: { tags: ["clubs"], operationId: "listClubs", summary: "Live club pages, optionally for one city", parameters: [{ name: "city", in: "query", schema: { type: "string" }, description: "phuket or singapore" }], responses: { "200": jsonResponse("Clubs", { type: "object", properties: { city: { type: ["string", "null"] }, clubs: { type: "array", items: ref("Club") }, cities: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, name: { type: "string" }, url: { type: "string" } } } } } }) } },
      },
      "/api/v1/clubs/{slug}": {
        get: { tags: ["clubs"], operationId: "getClub", summary: "A club page: booking link, courts, today's free courts when the club shares a feed", parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }], responses: { "200": jsonResponse("The club", ref("Club")), "404": jsonResponse("No live club page", ref("Error")) } },
      },
      "/api/v1/groups/{code}": {
        get: { tags: ["groups"], operationId: "getGroup", summary: "A group: members, weekly slot, upcoming matches", parameters: [{ name: "code", in: "path", required: true, schema: { type: "string", minLength: 6, maxLength: 6 } }], responses: { "200": jsonResponse("The group", ref("Group")), "404": jsonResponse("No such group", ref("Error")) } },
      },
      "/api/v1/schedule": {
        get: {
          tags: ["schedules"],
          operationId: "getSchedule",
          summary: "An americano rotation (exact when the field is in fours)",
          parameters: [
            { name: "players", in: "query", schema: { type: "integer", minimum: 4, maximum: 64 } },
            { name: "names", in: "query", description: "Comma-separated names; overrides players", schema: { type: "string" } },
            { name: "courts", in: "query", schema: { type: "integer", minimum: 1, maximum: 16 } },
            { name: "rounds", in: "query", schema: { type: "integer", minimum: 1, maximum: 40 } },
            { name: "seed", in: "query", schema: { type: "integer" } },
          ],
          responses: { "200": jsonResponse("The schedule", ref("Schedule")), ...errors },
        },
        post: { tags: ["schedules"], operationId: "postSchedule", summary: "Same as GET, with a JSON body", requestBody: jsonBody(ref("ScheduleInput")), responses: { "200": jsonResponse("The schedule", ref("Schedule")), ...errors } },
      },
      "/api/v1/keys": {
        post: {
          tags: ["keys"],
          operationId: "createKey",
          summary: "Get an API key instantly",
          description: "No approval, no email verification. The key is shown once. Say who or what will use it; an assistant may name itself.",
          requestBody: jsonBody({ type: "object", properties: { name: { type: "string", maxLength: 80 }, email: { type: "string", format: "email" }, agent: { type: "string", maxLength: 80, description: 'e.g. "claude", "chatgpt", "my-club-bot"' } }, required: ["name"] }),
          responses: { "201": jsonResponse("The key, once", { type: "object", properties: { key: { type: "string" }, prefix: { type: "string" }, name: { type: "string" }, limits: { type: "object" }, next: { type: "string" } } }), ...errors },
        },
      },
      "/api/v1/webhooks": {
        get: { tags: ["webhooks"], operationId: "listWebhooks", summary: "Your webhooks", security: [{ bearer: [] }], responses: { "200": jsonResponse("Webhooks", { type: "object", properties: { webhooks: { type: "array", items: ref("Webhook") } } }), "401": jsonResponse("Key required", ref("Error")) } },
        post: {
          tags: ["webhooks"],
          operationId: "createWebhook",
          summary: "Subscribe to match events",
          security: [{ bearer: [] }],
          requestBody: jsonBody({ type: "object", properties: { url: { type: "string", format: "uri" }, events: { type: "array", items: { type: "string", enum: [...WEBHOOK_EVENTS] } }, filter: { type: "object", properties: { venueSlug: { type: "string" }, groupCode: { type: "string" }, codes: { type: "array", items: { type: "string" } } } } }, required: ["url"] }),
          responses: { "201": jsonResponse("Created; the secret is shown once", { type: "object", properties: { webhook: ref("Webhook"), secret: { type: "string" }, signing: { type: "string" } } }), "401": jsonResponse("Key required", ref("Error")), ...errors },
        },
      },
      "/api/v1/webhooks/{id}": {
        delete: { tags: ["webhooks"], operationId: "deleteWebhook", summary: "Remove a webhook", security: [{ bearer: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "204": { description: "Removed" }, "404": jsonResponse("Not yours or already gone", ref("Error")) } },
      },
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Optional for writes, required for webhooks. Keys start with ks_live_." } },
      schemas: {
        Error: errorSchema,
        Match: publicMatch,
        CreateMatch: schema(createMatchSchema),
        JoinMatch: schema(joinMatchSchema),
        ScheduleInput: schema(scheduleSchema),
        CreateMatchResult: { type: "object", properties: { match: ref("Match"), organizer: { type: "object", properties: { name: { type: "string" }, personalToken: { type: "string" }, personalUrl: { type: "string" }, manageUrl: { type: "string" } } }, shareUrl: { type: "string" }, next: { type: "string" } } },
        JoinMatchResult: { type: "object", properties: { outcome: { type: "string", enum: ["joined", "waitlisted", "already_in", "full", "requested"] }, match: ref("Match"), player: { type: "object", properties: { name: { type: "string" }, personalToken: { type: "string" }, personalUrl: { type: "string" } } }, next: { type: "string" } } },
        Club: { type: "object", properties: { slug: { type: "string" }, name: { type: "string" }, url: { type: "string" }, city: { type: ["string", "null"] }, mapUrl: { type: ["string", "null"] }, website: { type: ["string", "null"] }, booking: { type: ["object", "null"], properties: { url: { type: "string" }, platform: { type: ["string", "null"], description: "playtomic, matchi, playbypoint, … or null for the club's own page" }, platformName: { type: ["string", "null"] } } }, courts: { type: ["integer", "null"] }, about: { type: ["string", "null"] }, founding: { type: "boolean" }, freeCourts: { type: ["object", "null"], description: "Today's free court-hours from the club's own feed; null when the club shares none", properties: { day: { type: "string" }, tz: { type: "string" }, fetchedAt: { type: "string" }, slots: { type: "array", items: { type: "object", properties: { start: { type: "string" }, end: { type: "string" }, free: { type: "integer" } } } } } }, boardUrl: { type: "string" }, rankingUrl: { type: "string" }, calendarUrl: { type: "string" } } },
        Board: { type: "object", properties: { slug: { type: "string" }, name: { type: "string" }, url: { type: "string" }, mapUrl: { type: ["string", "null"] }, calendarUrl: { type: "string" }, matches: { type: "array", items: { type: "object", properties: { code: { type: "string" }, url: { type: "string" }, type: { type: "string" }, title: { type: ["string", "null"] }, startsAt: { type: "string" }, tz: { type: "string" }, capacity: { type: "integer" }, players: { type: "integer" }, spotsLeft: { type: "integer" }, level } } } } },
        Group: { type: "object", properties: { code: { type: "string" }, name: { type: "string" }, url: { type: "string" }, calendarUrl: { type: "string" }, venue: { type: "object" }, tz: { type: "string" }, type: { type: "string" }, capacity: { type: "integer" }, level, weekly: { type: ["object", "null"], properties: { weekday: { type: "integer", description: "0 = Sunday" }, time: { type: "string" }, leadDays: { type: "integer" } } }, members: { type: "array", items: { type: "object", properties: { name: { type: "string" }, level: { type: ["number", "null"] }, admin: { type: "boolean" } } } }, upcoming: { type: "array", items: { type: "object", properties: { code: { type: "string" }, url: { type: "string" }, startsAt: { type: "string" }, title: { type: ["string", "null"] } } } } } },
        Schedule: { type: "object", properties: { format: { type: "string" }, players: { type: "integer" }, courts: { type: "integer" }, exact: { type: "boolean" }, rounds: { type: "array", items: { type: "object", properties: { round: { type: "integer" }, matches: { type: "array", items: { type: "object", properties: { court: { type: "integer" }, a: { type: "array", items: { type: "string" } }, b: { type: "array", items: { type: "string" } } } } }, resting: { type: "array", items: { type: "string" } } } } }, note: { type: "string" } } },
        Webhook: { type: "object", properties: { id: { type: "string" }, url: { type: "string" }, events: { type: "array", items: { type: "string" } }, filter: { type: ["object", "null"] }, createdAt: { type: "string" } } },
      },
    },
  };
}
