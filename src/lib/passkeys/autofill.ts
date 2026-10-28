/**
 * The page's one conditional request for the passkey above the keyboard (the owner, 28 October 2026:
 * "Yes, own name field (Recommended)"), as a small machine with no React, no library and no server in
 * it, so a test drives it with a fake phone and a fake server (tests/passkey-autofill-client.test.ts).
 * `src/components/PasskeyAutofill.tsx` makes the one machine of the app and hands it the library and the
 * two server actions.
 *
 * Every set of options it holds carries its own end (`expiresAt`): the page's own challenge ends ten
 * minutes after the server made it, the options call's five minutes after it came back. Held options
 * that end within `EXPIRY_MARGIN_MS` are never handed to the phone, because a pick over them costs the
 * player a Face ID for an "expired" or an "invalid" (review, 28 October 2026: a tab that iOS kept in
 * memory, a back navigation that brought the old page back, a live page whose fresh challenge every 20
 * seconds was ignored). So:
 *   - a new challenge from the page (a refresh) replaces held options that end within a minute, and the
 *     request starts again over it, with no call;
 *   - a tap in the field with nothing usable held makes the options call, once, however many taps come
 *     while it is out (`arming`);
 *   - the page coming back into view drops stale options, and makes no call;
 *   - a view never makes a call: only a tap does.
 * The server's own "expired" stays the last line, for a pick at the very boundary.
 */

/** Options the phone signs over, with the moment their challenge stops signing in (epoch ms). */
export type HeldOptions<O = unknown> = { optionsJSON: O; expiresAt: number };

/** What the sign-in answered: the action's own result, or null when the call never came back. */
export type SignInAnswer = { ok: true } | { ok: false; error: string } | null;

/** The phone's side: the library's `startAuthentication` with the browser's autofill, and its abort. */
export type Ceremony<O = unknown> = {
  /** Resolves with the phone's answer once the player picks a passkey; rejects when the request ends. */
  start: (optionsJSON: O) => Promise<unknown>;
  /** Ends the waiting request (`WebAuthnAbortService.cancelCeremony`). */
  cancel: () => void;
};

/** The server's side: the options call, and the sign-in. */
export type AutofillServer<O = unknown> = {
  options: () => Promise<HeldOptions<O> | null>;
  signIn: (answer: unknown) => Promise<SignInAnswer>;
};

/**
 * `off`: no request (no page challenge, a browser that cannot, the kill switch); `ready`: a request waits
 * or starts at the next tap; `working`: the sign-in is out; `again`: the page's challenge ran out at the
 * server, and new options come; `no`: the phone or the server said no.
 */
export type Phase = "off" | "ready" | "working" | "again" | "no";

/** Options this close to their end are never handed to the phone: the pick and Face ID take time. */
export const EXPIRY_MARGIN_MS = 30_000;
/** How long the options call's challenge signs in: the cookie's five minutes (`CHALLENGE_TTL_MS` in src/lib/passkeys/webauthn.ts, which a test holds equal). */
export const OPTIONS_TTL_MS = 5 * 60_000;

const challengeOf = (o: unknown): string | null => {
  const c = (o as { challenge?: unknown } | null)?.challenge;
  return typeof c === "string" ? c : null;
};

/** Whether held options may still go to the phone at `now`: present, not answered in this tab already, and more than the margin from their end. */
export function usable<O>(held: HeldOptions<O> | null | undefined, now: number, spent: ReadonlySet<string> = new Set()): held is HeldOptions<O> {
  if (!held || !Number.isFinite(held.expiresAt)) return false;
  const c = challengeOf(held.optionsJSON);
  return c !== null && !spent.has(c) && held.expiresAt - EXPIRY_MARGIN_MS > now;
}

export type AutofillPage<O = unknown> = ReturnType<typeof createAutofillPage<O>>;

export function createAutofillPage<O = unknown>(server: AutofillServer<O>, now: () => number = Date.now) {
  const s = {
    phase: "off" as Phase,
    ceremony: null as Ceremony<O> | null,
    /** Options nobody's answer has spent: the page's own, or the options call's. */
    held: null as HeldOptions<O> | null,
    /** The page's latest challenge, kept also while the machine is off, so `enable` starts over the newest. */
    offered: null as HeldOptions<O> | null,
    /** A request of ours waits. */
    waiting: false,
    /** The options call that is out, shared by every tap while it is (review, 28 October 2026: two calls left a cookie the waiting request never matched). */
    arming: null as Promise<void> | null,
    /** Each start and each stop moves it on, so an answer to a request that was ended, or options that came back after a stop, are dropped. */
    round: 0,
    /** What a sign-in does next: the page renders again, signed in. */
    signedIn: null as (() => void) | null,
  };
  /** Challenges an answer carried in this tab: a page brought back from the router's cache must not offer one again. */
  const spent = new Set<string>();
  const listeners = new Set<() => void>();
  const setPhase = (phase: Phase) => {
    s.phase = phase;
    for (const l of listeners) l();
  };
  const ok = (held: HeldOptions<O> | null, at = now()) => usable(held, at, spent);
  /** The phase read afresh after an await: the page may have gone, or the switch answered, meanwhile. */
  const phaseNow = (): Phase => s.phase;

  /** Ends our request, if one waits: the form's own submit, a stale challenge, the page going. */
  function stop(): void {
    s.round += 1;
    if (!s.waiting) return;
    s.waiting = false;
    s.ceremony?.cancel();
  }

  /** Hands the held options to the phone and waits for a pick. */
  async function listen(): Promise<void> {
    const ceremony = s.ceremony;
    const held = s.held;
    if (!ceremony || !held) return;
    const round = ++s.round;
    s.waiting = true;
    let answer: unknown;
    try {
      answer = await ceremony.start(held.optionsJSON);
    } catch {
      // Ended: the form sent, the page went, the button's own sign-in started, or the browser said no.
      if (round === s.round) s.waiting = false;
      return;
    }
    if (round !== s.round) return;
    s.waiting = false;
    // The answer spends the challenge, whatever the server says.
    const c = challengeOf(held.optionsJSON);
    if (c) spent.add(c);
    if (s.held === held) s.held = null;
    setPhase("working");
    const r = await server.signIn(answer).catch(() => null);
    if (phaseNow() === "off") return;
    if (!r) return setPhase("no");
    if (r.ok) return s.signedIn?.();
    if (r.error === "expired") {
      setPhase("again");
      return arm(true);
    }
    // The kill switch, pulled while this page was open: the token goes, and nothing waits again until a new page.
    if (r.error === "autofill_off") return disable();
    setPhase("no");
  }

  /**
   * Starts the conditional request over usable options. With none held, the options call gives new ones,
   * but only after a tap (`fromTap`), never on a view; and only one call at a time.
   */
  async function arm(fromTap: boolean): Promise<void> {
    if (!s.ceremony || s.phase === "off" || s.phase === "working" || s.waiting) return;
    if (s.arming) return s.arming;
    if (!ok(s.held)) {
      s.held = null;
      if (!fromTap) return;
      const round = s.round;
      const call = (async () => {
        const fresh = await server.options().catch(() => null);
        if (phaseNow() === "off") return;
        if (!fresh) return setPhase("no");
        s.held = fresh;
      })();
      s.arming = call;
      try {
        await call;
      } finally {
        s.arming = null;
      }
      // A stop while the call was out (the form sent), or a request that started meanwhile: the options stay for the next tap.
      if (round !== s.round || s.waiting || phaseNow() === "off" || phaseNow() === "no") return;
    }
    if (ok(s.held)) await listen();
  }

  function disable(): void {
    stop();
    s.ceremony = null;
    s.held = null;
    s.signedIn = null;
    setPhase("off");
  }

  return {
    /** The phase the field's line and token read. */
    phase: () => s.phase,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    /** The browser can: the machine starts over the newest page challenge, with no call. */
    enable(ceremony: Ceremony<O>, signedIn: () => void): void {
      s.ceremony = ceremony;
      s.signedIn = signedIn;
      s.held = ok(s.offered) ? s.offered : null;
      setPhase("ready");
      void arm(false).catch(() => undefined);
    },
    /** The page went (or the kill switch answered): the request ends, and the page's challenge goes with it. */
    leave(): void {
      disable();
      s.offered = null;
    },
    /**
     * A challenge the page rendered, at mount and at every refresh. Held options that still have more than
     * a minute keep their waiting request; otherwise the request starts again over the new challenge, with
     * no call.
     */
    offer(given: HeldOptions<O> | null): void {
      s.offered = given;
      // Off, the sign-in out, or the options call out (its options come next): nothing to restart.
      if (!s.ceremony || s.phase === "off" || s.phase === "working" || s.arming || !ok(given)) return;
      if (ok(s.held, now() + EXPIRY_MARGIN_MS)) return;
      stop();
      s.held = given;
      // After a no, the next tap starts the request: a phone that answered by itself would loop.
      if (s.phase !== "no") void arm(false).catch(() => undefined);
    },
    /** A tap in the field: a new try after a no, and new options if the held ones went stale while the request waited. */
    focus(): void {
      if (s.phase === "off" || s.phase === "working") return;
      if (s.phase === "no") setPhase("ready");
      if (s.waiting && !ok(s.held)) {
        stop();
        s.held = null;
      }
      void arm(true).catch(() => undefined);
    },
    /** The page came back into view (a tab iOS kept, a back navigation): stale options go, and no call is made; the next tap makes it. */
    wake(): void {
      if (s.phase === "off" || s.phase === "working" || s.arming || ok(s.held)) return;
      stop();
      s.held = null;
      if (ok(s.offered)) {
        s.held = s.offered;
        if (s.phase !== "no") void arm(false).catch(() => undefined);
      }
    },
    stop,
  };
}
