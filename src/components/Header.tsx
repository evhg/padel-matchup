import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { APP_NAME } from "@/lib/config";
import { LocaleToggle } from "./LocaleToggle";

export async function Header({ minimal = false }: { minimal?: boolean }) {
  const t = await getTranslations();
  return (
    <header className="mx-auto flex w-full max-w-xl items-center justify-between px-4 pt-4 pb-2">
      <Link href="/" prefetch={false} className="flex items-center gap-2 font-extrabold tracking-tight text-lg" aria-label={APP_NAME}>
        <span className="inline-grid h-8 w-8 place-items-center rounded-xl bg-ink">
          <span className="h-4 w-4 rounded-full bg-accent" />
        </span>
        <span>{APP_NAME}</span>
      </Link>
      <div className="flex items-center gap-2">
        {!minimal && (
          <Link href="/me" prefetch={false} className="btn-ghost btn-xs">
            {t("common.myMatches")}
          </Link>
        )}
        <LocaleToggle />
      </div>
    </header>
  );
}

/** Brand line only. `spacious` leaves room below so a phone can scroll the CTA to mid-screen. */
export function Footer({ spacious = false }: { spacious?: boolean }) {
  return (
    <footer className={`mx-auto mt-10 flex w-full max-w-xl items-center justify-end px-4 text-sm text-faint ${spacious ? "pb-[45vh]" : "pb-16"}`}>
      <span>{APP_NAME}</span>
    </footer>
  );
}
