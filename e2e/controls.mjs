// Every tappable control, actually tapped.
//
// Why this suite exists: `lo`, `lw` and `rq` — "Take it" on a freed hour, and a coach's yes/no on a
// request outside their hours — were sent to real people and did nothing when tapped, for as long as
// they existed. The webhook's dispatcher kept its own shorter copy of the prefix list and those three
// were never added to it.
//
// A static check does not find that. Both halves were *named* in the code; the prefixes appeared in
// `handleCoachCallback`'s own regex, so "is this prefix mentioned somewhere" answered yes. The bug
// was reachability, and reachability is only answered by sending the thing and seeing what comes
// back. So: post every prefix the source emits, with a well-formed but meaningless id, and require
// an answer that is not "I do not know what this is".
//
// A missing row, a bad id or a not-found record are all fine here — they mean a handler read the tap
// and decided. `callback_unknown` and `ignored` mean nobody read it at all, and that is the bug.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { BASE, finish, makeCheck } from "./lib.mjs";

const results = [];
const check = makeCheck(results);
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "e2e-tg-secret";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
/** The same nothing, packed the way the tap flows pack an id: 22 url-safe characters. */
const PACKED = "AAAAAAAAAAAAAAAAAAAAAA";
const chat = { id: 909090, type: "private" };
const tapper = { id: 909090, is_bot: false, first_name: "Tapper", language_code: "en" };

/**
 * One well-formed payload per prefix. The ids point at nothing on purpose: this asks whether the tap
 * is *read*, not whether the record exists, and a seeded record would make the suite slower and no
 * more truthful.
 */
const CONTROLS = {
  // The coach's book, one thread at a time.
  cu: `cu:${ZERO_UUID}`, // undo a booking
  cp: `cp:${ZERO_UUID}`, // package paid
  cq: `cq:${ZERO_UUID}`, // lesson paid, confirmed by the coach
  cm: `cm:${ZERO_UUID}:29500000`, // move a lesson to an hour
  cs: `cs:${ZERO_UUID}`, // accept a student
  cb: `cb:${ZERO_UUID}:29500000`, // book a candidate at a slot
  cn: "cn:z-phuket", // set a book up, first tap
  lc: `lc:${ZERO_UUID}`, // student cancels
  lx: `lx:${ZERO_UUID}`, // student confirms a late cancel
  lb: `lb:${ZERO_UUID}:29500000`, // student books a slot
  ld: `ld:${ZERO_UUID}:2026-09-15`, // student picks a coach for a day
  lm: `lm:${ZERO_UUID}:29500000`, // student moves a lesson
  lp: `lp:${ZERO_UUID}`, // student says they paid
  lo: `lo:${ZERO_UUID}`, // take a freed hour
  lw: `lw:${ZERO_UUID}`, // decline a freed hour
  rq: `rq:${ZERO_UUID}:y`, // coach answers an out-of-hours request
  wd: `wd:${ZERO_UUID}`, // drop a standing want
  // The assistant as taps (src/lib/telegram/taps.ts): ids packed to 22 characters, dates to six digits.
  kb: `kb:${PACKED}`, // who the lesson is for
  kd: `kd:${PACKED}:60:w0`, // which day
  kt: `kt:${PACKED}:60:260918`, // what time
  kh: `kh:${PACKED}:60:29500000`, // how many, or book
  ky: `ky:${PACKED}:60:29500000:1`, // book
  kn: "kn:", // a new student: the name is asked
  ko: `ko:${PACKED}:60:260918`, // a typed time: asked
  kx: `kx:${PACKED}`, // cancel, asked once first
  kz: "kz:", // keep it
  km: `km:${PACKED}`, // move: which day
  kl: `kl:${PACKED}`, // a lesson's card
  kq: `kq:${PACKED}`, // no-show
  kf: `kf:${PACKED}`, // on me
  ks: "ks:", // the students
  kp: `kp:${PACKED}`, // a package for a student
  ke: "ke:cutoff:12", // a rule
  kv: "kv:p1:80", // a figure on the keypad
  kg: "kg:", // the packages on the page
  kk: "kk:", // block time: which day
  sb: `sb:${PACKED}`, // student picks a coach
  sd: `sd:${PACKED}:60:w0`, // which day
  st: `st:${PACKED}:60:260918`, // what time
  sh: `sh:${PACKED}:60:29500000`, // how many, or book
  sy: `sy:${PACKED}:60:29500000:1`, // book
  sw: `sw:${PACKED}:260918`, // wait for the week
  sa: `sa:${PACKED}:260918`, // ask for another time
  sm: `sm:${PACKED}`, // move: which day
  sk: `sk:${PACKED}`, // take a package
  // A match card in a room.
  j: "j:AAAA", // join
  l: "l:AAAA", // leave
  r: "r:AAAA", // request to join
  w: "w:AAAA", // waitlist
  k: "k:AAAA", // keep / confirm
  c: "c:AAAA", // cancel
  g: "g:AAAA", // group
  // Creating a match in three taps.
  n: "n:z:phuket",
  // The owner's desk.
  la: `la:${ZERO_UUID}`,
  ls: `ls:${ZERO_UUID}`,
  lu: `lu:${ZERO_UUID}`,
  oa: `oa:${ZERO_UUID}`,
  os: `os:${ZERO_UUID}`,
  ca: "ca:abcdefghijklmnop",
  cr: "cr:abcdefghijklmnop",
};

/** Every prefix the source actually sends, so a new control cannot be added without being tapped here. */
function emittedPrefixes() {
  const out = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
        const src = readFileSync(full, "utf8");
        for (const m of src.matchAll(/(?:callback_data|custom_id|data): `([a-z]{1,3}):/g)) out.add(m[1]);
      }
    }
  };
  walk(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src"));
  return out;
}

const tap = async (data) => {
  const res = await fetch(`${BASE}/api/telegram/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), callback_query: { id: `cb-${data}`, from: tapper, message: { message_id: 1, date: 0, chat }, data } }),
  });
  return (await res.json().catch(() => null))?.outcome ?? "no-outcome";
};

const emitted = emittedPrefixes();
const listed = new Set(Object.keys(CONTROLS));
const missing = [...emitted].filter((p) => !listed.has(p));
check(
  `every control the code sends is tapped here (${emitted.size} emitted, ${listed.size} tapped)`,
  missing.length === 0,
  missing.length ? `not tapped by any check: ${missing.join(", ")} — add a row to CONTROLS` : "",
);

const dead = [];
for (const [prefix, data] of Object.entries(CONTROLS)) {
  const outcome = await tap(data);
  if (outcome === "callback_unknown" || outcome === "ignored" || outcome === "no-outcome") dead.push(`${prefix} → ${outcome}`);
}
check("every control is read by a handler rather than falling through", dead.length === 0, dead.join(" | "));

finish(results);
