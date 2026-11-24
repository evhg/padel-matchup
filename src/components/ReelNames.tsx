"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { namesTicketAction } from "@/actions/reel";

type Question = {
  players: { id: string; name: string }[];
  tracks: { track: number; face: string; guess: string | null; ask: boolean }[];
};

/** The question as the reel's maker wrote it, each part checked: a page never trusts a file it fetched. Pure. */
export function questionOf(raw: unknown): Question | null {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!o || !Array.isArray(o.players) || !Array.isArray(o.tracks)) return null;
  const players = o.players.flatMap((p) => (p && typeof p === "object" && typeof (p as { id?: unknown }).id === "string" && typeof (p as { name?: unknown }).name === "string" ? [{ id: (p as { id: string }).id, name: (p as { name: string }).name.slice(0, 40) }] : []));
  const ids = new Set(players.map((p) => p.id));
  const tracks = o.tracks.flatMap((x) => {
    const t = x as { track?: unknown; face?: unknown; guess?: unknown; ask?: unknown };
    if (!Number.isInteger(t.track) || typeof t.face !== "string" || !/^face-\d{1,2}\.jpg$/.test(t.face)) return [];
    return [{ track: t.track as number, face: t.face, guess: typeof t.guess === "string" && ids.has(t.guess) ? t.guess : null, ask: t.ask !== false }];
  });
  return players.length && tracks.length ? { players, tracks } : null;
}

/**
 * "Who is who?" (the agreed screen 5): the fast reel's job saw the four players and is not sure of every name. It
 * shows each face it saw; a name it knows is quiet and grey, and a face it does not know has dashed buttons, one
 * for each player of the match. A tap on a known name changes it. The lime button stays off until each face has a
 * name and no name is on two faces; then the answer goes to the reel host and the job goes on. The answer does not
 * teach the face gallery (yet), so the screen promises nothing about the next match.
 */
export function ReelNames({ code, host, upload }: { code: string; host: string; upload: string }) {
  const t = useTranslations("reel");
  const router = useRouter();
  const [q, setQ] = useState<Question | null>(null);
  const [failed, setFailed] = useState(false);
  const [answer, setAnswer] = useState<Record<number, string>>({});
  const [open, setOpen] = useState<number | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const base = `${host}/r/${upload}`;

  useEffect(() => {
    let gone = false;
    fetch(`${base}/names.json`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (gone) return;
        const got = questionOf(j);
        if (!got) return setFailed(true);
        setQ(got);
        setAnswer(Object.fromEntries(got.tracks.flatMap((x) => (!x.ask && x.guess ? [[x.track, x.guess]] : []))));
      })
      .catch(() => !gone && setFailed(true));
    return () => {
      gone = true;
    };
  }, [base]);

  if (failed) return null;
  if (!q)
    return (
      <section className="card" data-testid="reel-names">
        <p className="text-sm text-muted">{t("namesLoading")}</p>
      </section>
    );

  const nameOf = (id: string | undefined) => q.players.find((p) => p.id === id)?.name ?? "";
  const taken = Object.values(answer);
  const twice = taken.length !== new Set(taken).size;
  const left = q.tracks.filter((x) => !answer[x.track]).length;
  const ready = left === 0 && !twice;

  const send = async () => {
    setState("sending");
    const r = await namesTicketAction(code);
    if (!r.ok) return setState("error");
    const res = await fetch(`${r.data.url}/u/${r.data.upload}/names`, {
      method: "POST",
      headers: { Authorization: `Bearer ${r.data.ticket}`, "Content-Type": "application/json" },
      body: JSON.stringify({ names: Object.fromEntries(Object.entries(answer).map(([k, v]) => [k, v])) }),
    }).catch(() => null);
    if (!res?.ok) return setState("error");
    setState("sent");
    setTimeout(() => router.refresh(), 4000);
  };

  if (state === "sent")
    return (
      <section className="card" data-testid="reel-names-sent">
        <h2 className="text-lg font-extrabold">{t("namesSentTitle")}</h2>
        <p className="mt-1 text-sm text-muted">{t("namesSent")}</p>
      </section>
    );

  return (
    <section className="card" data-testid="reel-names">
      <h2 className="text-lg font-extrabold">{t("namesTitle")}</h2>
      <p className="mt-1 text-sm text-muted">{t("namesBody")}</p>
      <ul className="mt-4 grid grid-cols-2 gap-x-3 gap-y-4">
        {q.tracks.map((x) => {
          const chosen = answer[x.track];
          const choosing = open === x.track || !chosen;
          return (
            <li key={x.track} className="flex flex-col items-center gap-2" data-testid={`reel-face-${x.track}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a face from the reel host, by its token */}
              <img src={`${base}/${x.face}`} alt={chosen ? nameOf(chosen) : t("namesNewFace")} className="h-28 w-28 rounded-full bg-fill object-cover" />
              {!choosing ? (
                <button type="button" className="btn-secondary btn-sm min-w-24" onClick={() => setOpen(x.track)} data-testid={`reel-face-${x.track}-name`}>
                  {nameOf(chosen)}
                </button>
              ) : (
                <div className="flex flex-wrap justify-center gap-1.5">
                  {q.players.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={chosen === p.id}
                      onClick={() => {
                        setAnswer({ ...answer, [x.track]: p.id });
                        setOpen(null);
                      }}
                      className={`min-h-11 rounded-full border border-dashed px-3 text-sm font-semibold ${chosen === p.id ? "border-ink bg-fill" : "border-line-strong"} ${taken.includes(p.id) && chosen !== p.id ? "text-faint" : ""}`}
                      data-testid={`reel-face-${x.track}-pick-${p.name}`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {twice && <p className="mt-3 text-sm font-semibold text-danger">{t("namesTwice")}</p>}
      {state === "error" && <p className="mt-3 text-sm font-semibold text-danger">{t("namesFailed")}</p>}
      <button type="button" className="btn-primary mt-4 w-full" disabled={!ready || state === "sending"} onClick={() => void send()} data-testid="reel-names-go">
        {state === "sending" ? "…" : left > 0 ? t("namesLeft", { count: left }) : t("namesGo")}
      </button>
      <p className="mt-2 text-xs text-faint">{t("namesNext")}</p>
    </section>
  );
}
