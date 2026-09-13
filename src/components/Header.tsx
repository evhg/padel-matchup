import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getDb } from "@/db";
import { APP_NAME } from "@/lib/config";
import { NO_ROLES, rolesFor } from "@/lib/domain/roles";
import { getSessionPlayerId } from "@/lib/session";
import { HeaderNav } from "./AssistantLink";
import { LocaleToggle } from "./LocaleToggle";

/**
 * `minimal` drops the doors, for the few screens that are their own destination. `current` marks
 * the door you are standing in, so a person can see where they are without reading the URL.
 */
export async function Header({ minimal = false, current }: { minimal?: boolean; current?: "play" | "coach" | "club" | "series" }) {
  const t = await getTranslations();
  // The id comes out of the signed cookie without touching the database, so the header costs one
  // round trip on a render, and none at all for a visitor we have never met or on a minimal header.
  const playerId = minimal ? null : await getSessionPlayerId();
  const roles = playerId ? await rolesFor(await getDb(), playerId) : NO_ROLES;
  return (
    <header className="mx-auto flex w-full max-w-xl items-center justify-between px-4 pt-4 pb-2">
      <Link href="/" prefetch={false} className="flex items-center gap-2 font-extrabold tracking-tight text-lg" aria-label={APP_NAME}>
        <span className="inline-grid h-8 w-8 place-items-center rounded-xl bg-ink">
          <span className="h-4 w-4 rounded-full bg-accent" />
        </span>
        <span>{APP_NAME}</span>
      </Link>
      <div className="flex items-center gap-2">
        {!minimal && <HeaderNav roles={roles} current={current} labels={{ myMatches: t("common.myMatches"), assistant: t("common.assistant"), club: t("common.club"), series: t("common.series"), more: t("common.more") }} />}
        <LocaleToggle />
      </div>
    </header>
  );
}

/** Brand + the fine print, quietly. `spacious` leaves room below so a phone can scroll the CTA to mid-screen. */
export async function Footer({ spacious = false }: { spacious?: boolean }) {
  const t = await getTranslations();
  return (
    <footer className={`mx-auto mt-10 flex w-full max-w-xl items-center justify-between px-4 text-xs text-faint ${spacious ? "pb-[45vh]" : "pb-16"}`}>
      <Link href="/about" prefetch={false} className="hover:text-muted">
        {t("about.footerLink")}
      </Link>
      <span>{APP_NAME}</span>
    </footer>
  );
}
