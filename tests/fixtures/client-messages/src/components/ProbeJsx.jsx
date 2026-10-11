"use client";
import { useTranslations } from "next-intl";

export function ProbeJsx() {
  const t = useTranslations("me");
  return <p>{t("title")}</p>;
}
