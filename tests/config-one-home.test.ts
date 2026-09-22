import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { TELEGRAM_BOT } from "@/lib/config";
import { listenModel } from "@/lib/ops/anthropic";
import { miniAppUrl, telegramBotUsername } from "@/lib/telegram/api";

/**
 * A value with two homes has none.
 *
 * `LISTEN_MODEL || "claude-sonnet-5"` was written out in eight files, three with `||` and three
 * with `??`, while the variable was set in neither Vercel nor `.env.example`. The bot's public name
 * was a Vercel variable *and* five hard-coded strings in this repository, with nothing keeping the
 * two in step. These checks fail when either happens again.
 */
const root = (...p: string[]) => path.resolve(process.cwd(), ...p);
const src = () => execFileSync("grep", ["-rl", "--include=*.ts", "--include=*.tsx", "-e", "claude-sonnet-5", "-e", "kicksmash_bot", root("src")], { encoding: "utf8" }).split("\n").filter(Boolean);

describe("one home for a value", () => {
  const keep = { ...process.env };
  afterEach(() => {
    process.env = { ...keep };
  });

  it("names the drafting model in one file, and everybody else calls the reader", () => {
    const files = src().filter((f) => readFileSync(f, "utf8").includes("claude-sonnet-5"));
    // The price table, the reader's default and the price fallback all live together on purpose.
    expect(files.map((f) => path.relative(root(), f))).toEqual(["src/lib/ops/anthropic.ts"]);
  });

  it("reads the model from the environment, and falls back to the one that is priced", () => {
    delete process.env.LISTEN_MODEL;
    expect(listenModel()).toBe("claude-sonnet-5");
    process.env.LISTEN_MODEL = "claude-opus-5";
    expect(listenModel()).toBe("claude-opus-5");
  });

  it("keeps every hard-coded copy of the bot's name equal to the one in config.ts", () => {
    const files = src().filter((f) => readFileSync(f, "utf8").includes("kicksmash_bot"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/(?:@|t\.me\/)([a-zA-Z0-9_]{5,32}_bot)/g)) {
        expect(m[1], `${path.relative(root(), f)} names a different bot`).toBe(TELEGRAM_BOT);
      }
    }
  });

  it("gives the bot a name only where a bot exists", () => {
    // The name is public and has a default; the token is what says whether there is a bot at all.
    // Without this gate a deployment with no Telegram shows "open the bot" buttons that lead nowhere.
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_USERNAME;
    expect(telegramBotUsername()).toBeNull();
    expect(miniAppUrl("ABCD")).toBeNull();

    process.env.TELEGRAM_BOT_TOKEN = "123456:test-token";
    expect(telegramBotUsername()).toBe(TELEGRAM_BOT);
    // A bot follows from its token; a Mini App does not. It stays null until somebody makes one.
    expect(miniAppUrl("ABCD")).toBeNull();
    process.env.TELEGRAM_MINIAPP_SLUG = "KickSmash";
    expect(miniAppUrl("ABCD")).toBe(`https://t.me/${TELEGRAM_BOT}/KickSmash?startapp=ABCD`);

    // A variable still wins, with or without the @ a person types.
    process.env.TELEGRAM_BOT_USERNAME = "@other_bot";
    expect(telegramBotUsername()).toBe("other_bot");
  });

  it("keeps the migrate workflow pointing at the script and the secret it needs", () => {
    // A rename here breaks production migrations silently: the workflow still runs, still waits for
    // the owner, and then fails at the last step or, worse, runs with no address at all.
    const wf = readFileSync(root(".github/workflows/migrate.yml"), "utf8");
    expect(wf).toContain("environment: production");
    expect(wf).toContain("pnpm db:migrate");
    expect(wf).toContain("secrets.DIRECT_DATABASE_URL");
    // The script must read the same name the workflow supplies.
    expect(readFileSync(root("src/lib/env.ts"), "utf8")).toContain("DIRECT_DATABASE_URL");
    expect(readFileSync(root("scripts/migrate.ts"), "utf8")).toContain("directDatabaseUrl");
  });

  it("documents every variable the code reads", () => {
    // The check existed and nothing ran it, which is how nine variables reached production with no
    // line to set. The gate runs it now; this keeps it honest in CI too.
    expect(() => execFileSync("node", [root("scripts/gen-docs.mjs"), "--check"], { encoding: "utf8" })).not.toThrow();
  });
});
