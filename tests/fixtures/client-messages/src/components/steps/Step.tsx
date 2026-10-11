"use client";
import { useTranslations } from "next-intl";

export function Step() {
  const t = useTranslations("me");
  return <p>{t("title")}</p>;
}
