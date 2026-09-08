import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { googleAccessToken, localeOfPath, searchConsoleEnabled, searchWeek } from "@/lib/search/console";

describe("Search Console for the digest", () => {
  afterEach(() => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  });

  it("is off without the service account, and paths map to languages", async () => {
    expect(searchConsoleEnabled()).toBe(false);
    expect(await searchWeek()).toBeNull();
    expect(localeOfPath("https://kicksma.sh/ru/phuket")).toBe("ru");
    expect(localeOfPath("https://kicksma.sh/es")).toBe("es");
    expect(localeOfPath("https://kicksma.sh/rules")).toBe("en");
  });

  it("signs a JWT for the token, queries seven days ending three days ago, and sums by language", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "kicksmash-search@example.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    const seen: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "ya29.test" }), { headers: { "content-type": "application/json" } });
      return new Response(
        JSON.stringify({
          rows: [
            { keys: ["https://kicksma.sh/phuket"], clicks: 3, impressions: 40 },
            { keys: ["https://kicksma.sh/ru/phuket"], clicks: 2, impressions: 25 },
            { keys: ["https://kicksma.sh/es/americano"], clicks: 0, impressions: 5 },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    expect(await googleAccessToken(["https://www.googleapis.com/auth/webmasters.readonly"], fetchImpl)).toBe("ya29.test");
    const assertion = new URLSearchParams(seen[0].body).get("assertion")!;
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ iss: "kicksmash-search@example.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/webmasters.readonly" });
    const week = await searchWeek(fetchImpl, new Date("2026-09-14T07:00:00Z"));
    expect(week).toMatchObject({ from: "2026-09-05", to: "2026-09-11", impressions: 70, clicks: 5, byLocale: { en: 40, ru: 25, es: 5 } });
    expect(week?.topPages[0].page).toBe("https://kicksma.sh/phuket");
    const q = JSON.parse(seen.at(-1)!.body);
    expect(q).toMatchObject({ startDate: "2026-09-05", endDate: "2026-09-11", dimensions: ["page"] });
    expect(seen.at(-1)!.url).toContain(encodeURIComponent("sc-domain:"));
  });
});
