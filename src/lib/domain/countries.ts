/**
 * Where a club is, anywhere in the world. Two cities have pages of their own (`cities.ts`); every
 * other club names its place as a person there would ("Kuala Lumpur", "Москва") and its country.
 * Countries are ISO 3166-1 alpha-2 codes; their names come from `Intl.DisplayNames` in the reader's
 * language, so nothing here is translated by hand. The time zone the browser reports guesses the
 * country once, on the claim form, and the person corrects it.
 */
export const COUNTRIES = [
  "TH", "SG", "MY", "ID", "VN", "PH", "KH", "HK", "TW", "JP", "KR", "CN", "IN", "LK",
  "AE", "QA", "SA", "BH", "KW", "OM", "IL", "TR", "EG", "MA", "ZA", "KE",
  "ES", "PT", "IT", "FR", "GB", "IE", "DE", "NL", "BE", "LU", "CH", "AT", "SE", "NO", "DK", "FI", "PL", "CZ", "HU", "RO", "GR", "HR", "RS", "UA", "RU", "KZ", "GE",
  "US", "CA", "MX", "AR", "BR", "CL", "CO", "PE", "UY", "PY", "EC",
  "AU", "NZ",
] as const;

export const isCountryCode = (v: unknown): v is string => typeof v === "string" && /^[A-Z]{2}$/.test(v);

/** The country a browser's time zone sits in, for the zones the app has seen or expects; null for the rest. */
const TZ_COUNTRY: Record<string, string> = {
  "Asia/Bangkok": "TH", "Asia/Singapore": "SG", "Asia/Kuala_Lumpur": "MY", "Asia/Kuching": "MY", "Asia/Jakarta": "ID", "Asia/Makassar": "ID", "Asia/Jayapura": "ID",
  "Asia/Ho_Chi_Minh": "VN", "Asia/Saigon": "VN", "Asia/Manila": "PH", "Asia/Phnom_Penh": "KH", "Asia/Hong_Kong": "HK", "Asia/Taipei": "TW", "Asia/Tokyo": "JP", "Asia/Seoul": "KR",
  "Asia/Shanghai": "CN", "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Colombo": "LK", "Asia/Dubai": "AE", "Asia/Qatar": "QA", "Asia/Riyadh": "SA", "Asia/Bahrain": "BH", "Asia/Kuwait": "KW", "Asia/Muscat": "OM",
  "Asia/Jerusalem": "IL", "Asia/Tel_Aviv": "IL", "Europe/Istanbul": "TR", "Asia/Istanbul": "TR", "Africa/Cairo": "EG", "Africa/Casablanca": "MA", "Africa/Johannesburg": "ZA", "Africa/Nairobi": "KE",
  "Europe/Madrid": "ES", "Atlantic/Canary": "ES", "Europe/Lisbon": "PT", "Atlantic/Madeira": "PT", "Europe/Rome": "IT", "Europe/Paris": "FR", "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Berlin": "DE",
  "Europe/Amsterdam": "NL", "Europe/Brussels": "BE", "Europe/Luxembourg": "LU", "Europe/Zurich": "CH", "Europe/Vienna": "AT", "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Copenhagen": "DK",
  "Europe/Helsinki": "FI", "Europe/Warsaw": "PL", "Europe/Prague": "CZ", "Europe/Budapest": "HU", "Europe/Bucharest": "RO", "Europe/Athens": "GR", "Europe/Zagreb": "HR", "Europe/Belgrade": "RS", "Europe/Kyiv": "UA", "Europe/Kiev": "UA",
  "Europe/Moscow": "RU", "Europe/Kaliningrad": "RU", "Europe/Samara": "RU", "Europe/Volgograd": "RU", "Europe/Saratov": "RU", "Europe/Ulyanovsk": "RU", "Europe/Astrakhan": "RU", "Europe/Kirov": "RU",
  "Asia/Yekaterinburg": "RU", "Asia/Omsk": "RU", "Asia/Novosibirsk": "RU", "Asia/Barnaul": "RU", "Asia/Tomsk": "RU", "Asia/Novokuznetsk": "RU", "Asia/Krasnoyarsk": "RU", "Asia/Irkutsk": "RU", "Asia/Chita": "RU",
  "Asia/Yakutsk": "RU", "Asia/Khandyga": "RU", "Asia/Vladivostok": "RU", "Asia/Ust-Nera": "RU", "Asia/Magadan": "RU", "Asia/Sakhalin": "RU", "Asia/Srednekolymsk": "RU", "Asia/Kamchatka": "RU", "Asia/Anadyr": "RU",
  "Asia/Almaty": "KZ", "Asia/Qyzylorda": "KZ", "Asia/Aqtobe": "KZ", "Asia/Tbilisi": "GE",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Phoenix": "US", "America/Los_Angeles": "US", "America/Anchorage": "US", "Pacific/Honolulu": "US", "America/Detroit": "US", "America/Boise": "US",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA", "America/Winnipeg": "CA", "America/Halifax": "CA", "America/St_Johns": "CA", "America/Regina": "CA",
  "America/Mexico_City": "MX", "America/Cancun": "MX", "America/Monterrey": "MX", "America/Tijuana": "MX", "America/Merida": "MX", "America/Mazatlan": "MX", "America/Chihuahua": "MX",
  "America/Argentina/Buenos_Aires": "AR", "America/Buenos_Aires": "AR", "America/Argentina/Cordoba": "AR", "America/Argentina/Mendoza": "AR", "America/Sao_Paulo": "BR", "America/Bahia": "BR", "America/Fortaleza": "BR", "America/Manaus": "BR", "America/Recife": "BR",
  "America/Santiago": "CL", "America/Bogota": "CO", "America/Lima": "PE", "America/Montevideo": "UY", "America/Asuncion": "PY", "America/Guayaquil": "EC",
  "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Brisbane": "AU", "Australia/Perth": "AU", "Australia/Adelaide": "AU", "Australia/Hobart": "AU", "Australia/Darwin": "AU", "Pacific/Auckland": "NZ",
};

export const countryOfTz = (tz: string | null | undefined): string | null => (tz ? (TZ_COUNTRY[tz] ?? null) : null);

/** "Malaysia", "Малайзия", "Malasia": the reader's language, from the platform's own list. Falls back to the code. */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Where the reader is, for the sentence that says whether Kicksmash reaches them.
 *
 * Every club on Kicksmash is in Thailand or Singapore and every coach is in Phuket, so a person in
 * Kuala Lumpur, Berlin, Madrid or Moscow reads two city headings and a search that finds nothing,
 * and concludes the product is not for their country. The model was already world-wide; the
 * sentence was missing. The edge names the country from the visitor's address; a time zone answers
 * when the edge says nothing (local development, a bot, a header the platform did not set).
 *
 * The answer stays inside `COUNTRIES`, because that list is what the claim form offers: to tell a
 * person in a country we cannot yet accept that they may be the first there is a promise we break
 * on the next screen.
 */
export function visitorCountry(headerCountry: string | null | undefined, tz: string | null | undefined): string | null {
  const code = (headerCountry ?? "").trim().toUpperCase();
  const known = (c: string | null) => (c && (COUNTRIES as readonly string[]).includes(c) ? c : null);
  return known(isCountryCode(code) ? code : null) ?? known(countryOfTz(tz));
}

/** True when the reader's country holds none of these rows, and so deserves the first-one-here line. */
export const noneInCountry = (rowCountries: readonly (string | null | undefined)[], here: string | null): boolean =>
  Boolean(here) && !rowCountries.some((c) => c === here);

/** The city the edge reports, readable: the header arrives percent-encoded ("Kuala%20Lumpur"). */
export function visitorCity(headerCity: string | null | undefined): string | null {
  const raw = (headerCity ?? "").trim();
  if (!raw) return null;
  try {
    const name = decodeURIComponent(raw).trim();
    return name && name.length <= 60 ? name : null;
  } catch {
    return raw.length <= 60 ? raw : null;
  }
}
