import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CityPage } from "@/components/CityPage";
import { baseUrl } from "@/lib/config";
import { cityBySlug } from "@/lib/domain/cities";

export const dynamic = "force-dynamic";
const city = cityBySlug("singapore")!;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  const title = t("city.title", { city: city.name });
  const description = t("city.metaDescription", { city: city.name });
  return { title, description, alternates: { canonical: "/singapore" }, openGraph: { title, description, type: "website", url: `${baseUrl()}/singapore` } };
}

export default function Page() {
  return <CityPage city={city} />;
}
