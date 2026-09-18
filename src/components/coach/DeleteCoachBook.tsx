"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { deleteCoachBookAction } from "@/actions/coach";

/**
 * Faint, at the very bottom of the settings, like the player's own "delete my account". A coach who
 * set one up to see what it was must be able to put it back, and a coach testing the walk must be able
 * to take it again. One confirm that names what goes, then the setup walk from its first step.
 */
export function DeleteCoachBook({ students, lessons }: { students: number; lessons: number }) {
  const t = useTranslations("coach");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <p className="mt-6 text-center text-sm text-muted">
      <button
        type="button"
        className="underline hover:text-muted"
        disabled={pending}
        data-testid="delete-book"
        onClick={() => {
          if (!confirm(t("settings.deleteConfirm", { students, lessons }))) return;
          start(async () => {
            const r = await deleteCoachBookAction();
            if (r.ok) router.push("/coach");
            else alert(t(r.error === "has_lessons" ? "settings.deleteHasLessons" : "settings.deleteFailed"));
          });
        }}
      >
        {pending ? t("settings.deleting") : t("settings.delete")}
      </button>
    </p>
  );
}
