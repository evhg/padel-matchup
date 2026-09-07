import type { Metadata } from "next";
import { localeAlternates } from "@/lib/seo";
import { getLocale, getTranslations } from "next-intl/server";
import { CityPage } from "@/components/CityPage";
import { baseUrl } from "@/lib/config";
import { cityBySlug } from "@/lib/domain/cities";

export const dynamic = "force-dynamic";
const city = cityBySlug("phuket")!;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  const locale = await getLocale();
  const title = t("city.title", { city: city.name });
  const description = t("city.metaDescription", { city: city.name });
  return { title, description, alternates: localeAlternates("/phuket", locale), openGraph: { title, description, type: "website", url: `${baseUrl()}/phuket` } };
}

export default function Page() {
  return <CityPage city={city} />;
}
