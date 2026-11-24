"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { TEAM_NAME_MAX, type ReelChoices, type ReelMusic } from "@/lib/domain/reelChoices";

/**
 * "While you wait: make it yours" (the agreed screens 4 and 6): while the phone reads the film and sends
 * it, the player sets the team names, the crowd's cheers, the card of numbers and the music. Rows in one
 * card, as in Settings: a switch for each option, and the tracks as a list with one mark on the chosen
 * one. "Hear" plays ten seconds of a track from the reel host. Nothing here is a step: every option has a
 * default, so a player who does nothing still gets the whole reel.
 */
export function ReelChoicesCard({ value, onChange, musicBase }: { value: ReelChoices; onChange: (next: ReelChoices) => void; /** The reel host that plays the ten seconds; none: no "Hear". */ musicBase: string | null }) {
  const t = useTranslations("reel");
  const [naming, setNaming] = useState(false);
  const [playing, setPlaying] = useState<ReelMusic | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);

  const tracks: { id: ReelMusic; title: string; sub: string }[] = [
    { id: "bounce", title: t("musicBounce"), sub: t("musicBounceSub") },
    { id: "dnb", title: t("musicDnb"), sub: t("musicDnbSub") },
    { id: "bigscreen", title: t("musicBigscreen"), sub: t("musicBigscreenSub") },
    { id: "sunrise", title: t("musicSunrise"), sub: t("musicSunriseSub") },
    { id: "none", title: t("musicNone"), sub: t("musicNoneSub") },
  ];

  const hear = (id: ReelMusic) => {
    audio.current?.pause();
    if (playing === id || !musicBase) return setPlaying(null);
    const a = new Audio(`${musicBase}/music/${id}`);
    a.onended = () => setPlaying(null);
    a.onerror = () => setPlaying(null);
    audio.current = a;
    setPlaying(id);
    void a.play().catch(() => setPlaying(null));
  };

  const row = "flex min-h-11 items-center justify-between gap-3 py-2";
  const toggle = (on: boolean, label: string, flip: () => void, id: string) => (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={flip} data-testid={id} className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${on ? "bg-ink" : "bg-line-strong"}`}>
      {/* The app's switch (`EmailField`): the knob off is `knob-off`, 3:1 on its track in both themes. */}
      <span className={`inline-block h-5 w-5 rounded-full shadow transition ${on ? "translate-x-6 bg-on-ink" : "translate-x-1 bg-knob-off"}`} />
    </button>
  );

  return (
    <div className="mt-4 border-t border-line pt-3" data-testid="reel-choices">
      <h3 className="font-bold">{t("mineTitle")}</h3>
      <div className="mt-1 divide-y divide-line text-[0.9375rem]">
        <div className="py-2">
          <div className={row}>
            <div className="min-w-0">
              <p className="font-semibold">{t("teamsLabel")}</p>
              {!naming && <p className="truncate text-muted" data-testid="reel-teams-line">{`${value.teams[0]} · ${value.teams[1]}`}</p>}
            </div>
            <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => setNaming(!naming)} data-testid="reel-teams-change">
              {naming ? t("teamsDone") : t("teamsChange")}
            </button>
          </div>
          {naming && (
            <div className="mt-1 flex flex-col gap-2">
              {([0, 1] as const).map((i) => (
                <input
                  key={i}
                  id={`reel-team-${i}`}
                  className="input"
                  maxLength={TEAM_NAME_MAX}
                  aria-label={t(i === 0 ? "teamOne" : "teamTwo")}
                  value={value.teams[i]}
                  data-testid={`reel-team-${i}`}
                  onChange={(e) => {
                    const teams: [string, string] = [...value.teams];
                    teams[i] = e.target.value;
                    onChange({ ...value, teams });
                  }}
                />
              ))}
            </div>
          )}
        </div>
        <div className={row}>
          <div>
            <p className="font-semibold">{t("crowdLabel")}</p>
            <p className="text-muted">{t("crowdSub")}</p>
          </div>
          {toggle(value.crowd, t("crowdLabel"), () => onChange({ ...value, crowd: !value.crowd }), "reel-crowd")}
        </div>
        <div className={row}>
          <div>
            <p className="font-semibold">{t("numbersLabel")}</p>
            <p className="text-muted">{t("numbersSub")}</p>
          </div>
          {toggle(value.numbers, t("numbersLabel"), () => onChange({ ...value, numbers: !value.numbers }), "reel-numbers")}
        </div>
      </div>
      <h3 className="mt-4 font-bold">{t("musicTitle")}</h3>
      <div className="mt-1 divide-y divide-line text-[0.9375rem]" role="radiogroup" aria-label={t("musicTitle")} data-testid="reel-music">
        {tracks.map((m) => (
          <div key={m.id} className={row}>
            <button type="button" role="radio" aria-checked={value.music === m.id} className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => onChange({ ...value, music: m.id })} data-testid={`reel-music-${m.id}`}>
              <span aria-hidden="true" className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-extrabold ${value.music === m.id ? "bg-ink text-on-ink" : "border border-line-strong"}`}>
                {value.music === m.id ? "✓" : ""}
              </span>
              <span className="min-w-0">
                <span className="block font-semibold">{m.title}</span>
                <span className="block text-muted">{m.sub}</span>
              </span>
            </button>
            {m.id !== "none" && musicBase && (
              <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => hear(m.id)} aria-pressed={playing === m.id}>
                {playing === m.id ? t("hearStop") : t("hear")}
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-faint">{t("musicHelp")}</p>
    </div>
  );
}
