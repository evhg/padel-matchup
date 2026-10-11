"use client";
import * as i18n from "../i18n/client";

export function ByNamespace() {
  const t = i18n.useTranslations("me");
  return <p>{t("title")}</p>;
}
