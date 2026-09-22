import { describe, expect, it } from "vitest";

import { banner, connectionHint } from "../scripts/connection-hint";

// Four Migrate runs failed for four different reasons, so the words this file produces are the only
// thing a reader of the log gets. This is the error shape drizzle-orm really throws: its own error,
// with the driver's error underneath it as `cause`. Both shapes are copied from real run logs.
const drizzleError = (cause: unknown) => Object.assign(new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"'), { cause });
const socketError = (code: string, address: string) =>
  Object.assign(new Error(`connect ${code} ${address}:5432`), { code, address, syscall: "connect" });
const refused = () => Object.assign(new Error('password authentication failed for user "postgres"'), { code: "28P01", severity_local: "FATAL" });

describe("connectionHint", () => {
  it("names the address, the reason and the address to use instead", () => {
    const hint = connectionHint(drizzleError(socketError("ENETUNREACH", "2406:da18:1691:a200::9aac")));
    expect(hint).toContain("2406:da18:1691:a200::9aac");
    expect(hint).toContain("ENETUNREACH");
    expect(hint).toContain("no IPv6 route");
    expect(hint).toContain("Session pooler");
    expect(hint).toContain("DIRECT_DATABASE_URL");
  });

  it("leaves out the IPv6 line when the address is IPv4", () => {
    const hint = connectionHint(drizzleError(socketError("EHOSTUNREACH", "10.0.0.7")));
    expect(hint).toContain("10.0.0.7");
    expect(hint).not.toContain("IPv6 route");
  });

  // A refused password is the one failure where the obvious remedy is the dangerous one: the live
  // site holds the same password, so a reset stops the site. The hint has to say so.
  it("explains a refused password, and warns against resetting it", () => {
    const hint = connectionHint(drizzleError(refused()));
    expect(hint).toContain("refused the password");
    expect(hint).toContain("postgres.<project-ref>");
    expect(hint).toContain("Do NOT reset");
    expect(hint).toContain("DATABASE_URL");
  });

  // A name that does not resolve is a different problem with a different remedy. Saying "use the
  // Session pooler" there would send the reader the wrong way.
  it("says nothing about a failure it does not recognise", () => {
    expect(connectionHint(drizzleError(socketError("ENOTFOUND", "db.example.com")))).toBeNull();
    expect(connectionHint(new Error("relation does not exist"))).toBeNull();
    expect(connectionHint(null)).toBeNull();
  });
});

describe("banner", () => {
  const url = "postgresql://postgres.abcdefghijklmnop:s3cr3t-P%40ss@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres";

  it("says where the run points and who it claims to be", () => {
    const line = banner(url);
    expect(line).toContain("aws-0-ap-southeast-1.pooler.supabase.com:5432");
    expect(line).toContain("postgres.abcdefghijklmnop");
    expect(line).toContain("database postgres");
  });

  // The banner goes into a public log. It exists to identify a wrong address, never to reveal one.
  it("never prints the password", () => {
    expect(banner(url)).not.toContain("s3cr3t");
    expect(banner(url)).not.toContain("P%40ss");
    expect(banner("this is not a url at all")).not.toContain("this is not a url");
  });
});
