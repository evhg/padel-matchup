import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { BACKUP_KEEP_DAYS, BACKUP_MAX_FILES, runBackup, type BackupResult, type TreeEntry } from "@/lib/backup";
import { dayKey } from "@/lib/domain/metrics";
import { freezeClock } from "./helpers/clock";
import { createTestDb } from "./helpers/db";

/**
 * The owner's decision of 10 October 2026: each night the backup repository's history is rebuilt as one
 * commit with no parent, holding only the kept days, so a deleted player leaves the old copies. That
 * throws history away, so every guard in front of the force-update has a test here that sets up the one
 * thing it refuses, and checks that the branch never moved and the night counted as "kept".
 */
const NOW = new Date("2026-10-10T05:00:00Z");
freezeClock(NOW);
const DAY = "2026-10-10";
const REPO = "evhg/kicksmash-backups";
const BASE = `https://api.github.com/repos/${REPO}`;
const sha = (c: string) => c.repeat(40);
const HEAD = sha("a");
const TREE = sha("b");
const FRESH = sha("c");
const MOVED = sha("d");
const TODAY_BLOB = sha("e");

/** Night file entries for the n days up to and including `last`, newest first. */
const nights = (n: number, last = NOW): TreeEntry[] =>
  Array.from({ length: n }, (_, i) => {
    const d = dayKey(new Date(last.getTime() - i * 86_400_000));
    return { path: `backups/${d}.json.gz`, type: "blob", sha: d === DAY ? TODAY_BLOB : sha("f") };
  });
/** The repository after a good night: the folder, the kept days and today (61 files), and GitHub's README. */
const goodTree = (): TreeEntry[] => [{ path: "README.md", type: "blob", sha: sha("1") }, { path: "backups", type: "tree", sha: sha("2") }, ...nights(BACKUP_KEEP_DAYS + 1)];

type Step = "exists" | "put" | "list" | "prune" | "repo" | "ref" | "commit" | "tree" | "new commit" | "ref again" | "update" | "unknown";
const GIT_STEPS: Step[] = ["repo", "ref", "commit", "tree", "new commit", "ref again", "update"];
type Call = { step: Step; method: string; url: string; body: Record<string, unknown> | null; status: number };

/** A GitHub that answers the calls the backup makes, records them in order, and fails where it is told to. */
function fakeGithub(o: { put?: number; putSha?: string | null; entries?: TreeEntry[]; truncated?: boolean; moveTo?: string; fail?: Partial<Record<Step, number>>; throwAt?: Step; newSha?: string } = {}) {
  const calls: Call[] = [];
  let refReads = 0;
  const route = (method: string, url: string): [Step, number, unknown] => {
    if (url === `${BASE}/contents/backups/${DAY}.json.gz` && method === "GET") return ["exists", 404, {}];
    if (url === `${BASE}/contents/backups/${DAY}.json.gz` && method === "PUT") return ["put", o.put ?? 201, o.putSha === null ? {} : { content: { sha: o.putSha ?? TODAY_BLOB }, commit: { sha: sha("9") } }];
    if (url === `${BASE}/contents/backups` && method === "GET") return ["list", 200, [{ name: "2026-08-01.json.gz", sha: "old", path: "backups/2026-08-01.json.gz" }]];
    if (url.startsWith(`${BASE}/contents/backups/`) && method === "DELETE") return ["prune", 200, {}];
    if (url === BASE && method === "GET") return ["repo", 200, { default_branch: "main" }];
    if (url === `${BASE}/git/ref/heads/main` && method === "GET") {
      refReads++;
      return [refReads === 1 ? "ref" : "ref again", 200, { object: { sha: refReads === 1 ? HEAD : (o.moveTo ?? HEAD) } }];
    }
    if (url === `${BASE}/git/commits/${HEAD}` && method === "GET") return ["commit", 200, { sha: HEAD, tree: { sha: TREE }, parents: [{ sha: sha("8") }] }];
    if (url === `${BASE}/git/trees/${TREE}?recursive=1` && method === "GET") return ["tree", 200, { sha: TREE, tree: o.entries ?? goodTree(), truncated: o.truncated ?? false }];
    if (url === `${BASE}/git/commits` && method === "POST") return ["new commit", 201, { sha: o.newSha ?? FRESH }];
    if (url === `${BASE}/git/refs/heads/main` && method === "PATCH") return ["update", 200, { ref: "refs/heads/main", object: { sha: FRESH } }];
    return ["unknown", 404, {}];
  };
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const [step, ok, json] = route(method, String(url));
    const status = o.fail?.[step] ?? ok;
    calls.push({ step, method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, status });
    if (o.throwAt === step) throw new Error("socket hang up");
    return new Response(JSON.stringify(status < 300 ? json : { message: "refused" }), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, steps: () => calls.map((c) => c.step), patches: () => calls.filter((c) => c.method === "PATCH") };
}

describe("the nightly history rebuild", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(async () => {
    process.env.BACKUP_GITHUB_REPO = REPO;
    process.env.BACKUP_GITHUB_TOKEN = "github_pat_test";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BACKUP_GITHUB_REPO;
    delete process.env.BACKUP_GITHUB_TOKEN;
  });

  const metric = async (key: string) => Number((await db.select({ value: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.key, key), eq(metricsDaily.day, DAY))))[0]?.value ?? 0);
  /** One night, from a clean slate: yesterday's run must not make tonight's "already". */
  const night = async (gh: ReturnType<typeof fakeGithub>): Promise<BackupResult> => {
    await db.delete(metricsDaily);
    return runBackup(db, NOW, gh.fetchImpl);
  };
  /** The backup itself is done; the branch never moved; the night counts as kept, for the reason given. */
  const expectKept = async (r: BackupResult, gh: ReturnType<typeof fakeGithub>, reason: RegExp) => {
    expect(r.status).toBe("done");
    expect(r.history).toBe("kept");
    expect(r.historyReason).toMatch(reason);
    expect(gh.patches()).toEqual([]);
    expect(await metric("backup_history_kept")).toBe(1);
    expect(await metric("backup_history_rebuilt")).toBe(0);
  };

  it("after the write and the prune: reads the branch, its commit and tree, makes a commit with no parent, then forces the branch onto it", async () => {
    const gh = fakeGithub();
    const r = await night(gh);
    expect(r).toMatchObject({ status: "done", path: `backups/${DAY}.json.gz`, pruned: 1, history: "rebuilt", historyFrom: HEAD, historyTo: FRESH });
    expect(r.historyReason).toBeUndefined();
    expect(gh.steps()).toEqual(["exists", "put", "list", "prune", "repo", "ref", "commit", "tree", "new commit", "ref again", "update"]);
    const commit = gh.calls.find((c) => c.step === "new commit")!;
    expect(commit.body).toEqual({ message: expect.stringMatching(new RegExp(`^backups as of ${DAY}\\n\\n.*${HEAD}`)), tree: TREE, parents: [] });
    expect(gh.patches().map((c) => [c.url, c.body])).toEqual([[`${BASE}/git/refs/heads/main`, { sha: FRESH, force: true }]]);
    expect(await metric("backup_history_rebuilt")).toBe(1);
    expect(await metric("backup_history_kept")).toBe(0);
    // The way back is in the job's log: where the branch pointed before.
    expect(vi.mocked(console.info).mock.calls.flat().join(" ")).toContain(`moved from ${HEAD} to ${FRESH}`);
  });

  it("never rebuilds when today's file was not written", async () => {
    const gh = fakeGithub({ put: 500 });
    const r = await night(gh);
    expect(r).toMatchObject({ status: "failed", history: "kept", historyReason: "today's file was not written" });
    expect(gh.steps().filter((s) => GIT_STEPS.includes(s))).toEqual([]);
    expect(await metric("backup_history_kept")).toBe(1);
    expect(await metric("backup_history_rebuilt")).toBe(0);
  });

  it("keeps the history when today's file is not in the tree, or is not the file just written", async () => {
    // No blob id from the write, so the name is the only thing standing between this tree and a rebuild.
    const missing = fakeGithub({ putSha: null, entries: [{ path: "backups", type: "tree", sha: sha("2") }, ...nights(BACKUP_KEEP_DAYS + 1, new Date(NOW.getTime() - 86_400_000))] });
    await expectKept(await night(missing), missing, /today's file backups\/2026-10-10\.json\.gz is not in the tree/);
    expect(missing.steps()).not.toContain("new commit");
    const stale = fakeGithub({ entries: goodTree().map((e) => (e.path === `backups/${DAY}.json.gz` ? { ...e, sha: sha("7") } : e)) });
    await expectKept(await night(stale), stale, /not the one just written/);
  });

  it("keeps the history when the folder holds more nights than the prune leaves, and rebuilds at the limit", async () => {
    expect(BACKUP_MAX_FILES).toBe(BACKUP_KEEP_DAYS + 2);
    const over = fakeGithub({ entries: nights(BACKUP_MAX_FILES + 1) });
    await expectKept(await night(over), over, new RegExp(`${BACKUP_MAX_FILES + 1} night files, more than ${BACKUP_MAX_FILES}`));
    const atLimit = fakeGithub({ entries: nights(BACKUP_MAX_FILES) });
    expect((await night(atLimit)).history).toBe("rebuilt");
  });

  it("keeps the history when a file in backups/ is not a night's file", async () => {
    const gh = fakeGithub({ entries: [...goodTree(), { path: "backups/notes.txt", type: "blob", sha: sha("6") }] });
    await expectKept(await night(gh), gh, /backups\/notes\.txt is not a night's file/);
  });

  it("keeps the history of a repository that holds anything else: a token pointed at the wrong one loses nothing", async () => {
    // The app's own repository, say, which tonight's PUT has just given a backups/ folder.
    const code: TreeEntry[] = [{ path: "package.json", type: "blob", sha: sha("3") }, { path: "src", type: "tree", sha: sha("4") }, { path: "src/index.ts", type: "blob", sha: sha("5") }];
    const gh = fakeGithub({ entries: [...goodTree(), ...code] });
    await expectKept(await night(gh), gh, /^blob package\.json does not belong in the backup repository$/);
  });

  it("keeps the history when the tree was too big to read whole", async () => {
    const gh = fakeGithub({ truncated: true });
    await expectKept(await night(gh), gh, /too big to read whole/);
  });

  it("keeps the history when the branch moved between the first read and the update", async () => {
    const gh = fakeGithub({ moveTo: MOVED });
    const r = await night(gh);
    await expectKept(r, gh, new RegExp(`moved from ${HEAD} to ${MOVED}`));
    expect(gh.steps().slice(-2)).toEqual(["new commit", "ref again"]);
    expect(r.historyFrom).toBe(HEAD);
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain(`is at ${HEAD}`);
  });

  it("keeps the history when any step is refused, throws or answers nonsense, and never moves the branch before the last step", async () => {
    const refusals: [Step, number][] = [["repo", 404], ["ref", 403], ["commit", 404], ["tree", 409], ["new commit", 422], ["ref again", 404], ["update", 422]];
    for (const [step, status] of refusals) {
      const gh = fakeGithub({ fail: { [step]: status } });
      const r = await night(gh);
      expect(r.status, step).toBe("done");
      expect(r.history, step).toBe("kept");
      expect(r.historyReason, step).toMatch(new RegExp(`^github ${status} at `));
      // The calls stop at the refused one; only the last step is a PATCH, and it was refused.
      expect(gh.steps().at(-1), step).toBe(step);
      expect(gh.patches().filter((c) => c.status < 300), step).toEqual([]);
      if (step !== "update") expect(gh.patches(), step).toEqual([]);
      expect(await metric("backup_history_kept"), step).toBe(1);
      expect(await metric("backup_history_rebuilt"), step).toBe(0);
    }
    const dropped = fakeGithub({ throwAt: "tree" });
    await expectKept(await night(dropped), dropped, /^read the tree: socket hang up$/);
    const nonsense = fakeGithub({ newSha: "not-a-sha" });
    await expectKept(await night(nonsense), nonsense, /^no commit id from the new commit$/);
  });
});
