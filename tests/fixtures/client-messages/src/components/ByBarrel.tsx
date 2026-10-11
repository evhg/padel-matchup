"use client";
import { useTranslations } from "../i18n/client";

export function ByBarrel() {
  const t = useTranslations("me");
  return <p>{t("title")}</p>;
}
