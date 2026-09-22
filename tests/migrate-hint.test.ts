import { describe, expect, it } from "vitest";

import { unreachableHint } from "../scripts/unreachable";

// The Migrate workflow failed twice, and the second failure was a network one whose remedy appeared
// nowhere in its forty lines of stack. This is the shape drizzle-orm really throws: its own error,
// with the Node socket error underneath it as `cause`. The shape is copied from run 2's log.
const drizzleError = (cause: unknown) => Object.assign(new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"'), { cause });
const socketError = (code: string, address: string) =>
  Object.assign(new Error(`connect ${code} ${address}:5432`), { code, address, syscall: "connect" });

describe("unreachableHint", () => {
  it("names the address, the reason and the address to use instead", () => {
    const hint = unreachableHint(drizzleError(socketError("ENETUNREACH", "2406:da18:1691:a200::9aac")));
    expect(hint).toContain("2406:da18:1691:a200::9aac");
    expect(hint).toContain("ENETUNREACH");
    expect(hint).toContain("no IPv6 route");
    expect(hint).toContain("Session pooler");
    expect(hint).toContain("DIRECT_DATABASE_URL");
  });

  it("leaves out the IPv6 line when the address is IPv4", () => {
    const hint = unreachableHint(drizzleError(socketError("EHOSTUNREACH", "10.0.0.7")));
    expect(hint).toContain("10.0.0.7");
    expect(hint).not.toContain("IPv6 route");
    expect(hint).toContain("Session pooler");
  });

  // A name that does not resolve, or a refused connection, is a different problem with a different
  // remedy. Saying "use the Session pooler" there would send the reader the wrong way.
  it("says nothing about a failure it does not recognise", () => {
    expect(unreachableHint(drizzleError(socketError("ENOTFOUND", "db.example.com")))).toBeNull();
    expect(unreachableHint(new Error("password authentication failed"))).toBeNull();
    expect(unreachableHint(null)).toBeNull();
  });
});
