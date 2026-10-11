"use client";
import { useTranslations } from "next-intl";

export function TemplateKey({ code }: { code: string }) {
  const t = useTranslations();
  // Its DYNAMIC entry in the test says "feedback.*": the browser would get feedback and no errors.* key.
  const line = t(`errors.${code}` as "errors.generic");
  // The same, where only the type says what the key starts with.
  const key = `errors.${code}` as const;
  const again = t(key as "errors.generic");
  return (
    <p>
      {line} {again}
    </p>
  );
}
