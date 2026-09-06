import { describe, expect, it } from "vitest";
import { guessLanguage, looksRelevant, parseFeed, parseHn, stripHtml } from "@/lib/listen/parse";

const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <author><name>/u/padelfan</name><uri>https://www.reddit.com/user/padelfan</uri></author>
    <category term="padel" label="r/padel"/>
    <content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;Is there an app to organise padel matches with my WhatsApp group without everyone installing something?&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt;</content>
    <id>t3_1abc23</id>
    <link href="https://www.reddit.com/r/padel/comments/1abc23/app_to_organise/" />
    <updated>2026-09-05T08:15:00+00:00</updated>
    <published>2026-09-05T08:15:00+00:00</published>
    <title>App to organise padel matches?</title>
  </entry>
  <entry>
    <author><name>/u/other</name></author>
    <content type="html">&lt;p&gt;Nice rally&lt;/p&gt;</content>
    <id>t3_zzz</id>
    <link href="https://www.reddit.com/r/padel/comments/zzz/nice_rally/" />
    <updated>2026-09-05T09:00:00+00:00</updated>
    <title>Look at this rally</title>
  </entry>
</feed>`;

const rss = `<rss version="2.0"><channel><title>Forum</title>
<item><title>Americano schedule for 12 players?</title><link>https://forum.example/t/123</link><guid>https://forum.example/t/123</guid>
<description><![CDATA[<p>We are 12 people, 3 courts, how do we build an americano schedule &amp; keep score?</p>]]></description>
<pubDate>Fri, 05 Sep 2026 10:00:00 GMT</pubDate><dc:creator>maria</dc:creator></item>
<item><title>No date</title><link>https://forum.example/t/124</link><description>x</description></item>
</channel></rss>`;

describe("listen: feeds", () => {
  it("parses Atom (Reddit) with thing ids and stripped bodies", () => {
    const items = parseFeed(atom, "reddit");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ source: "reddit", externalId: "t3_1abc23", threadId: "t3_1abc23", author: "/u/padelfan", url: "https://www.reddit.com/r/padel/comments/1abc23/app_to_organise/", title: "App to organise padel matches?" });
    expect(items[0].body).toBe("Is there an app to organise padel matches with my WhatsApp group without everyone installing something?");
    expect(items[0].postedAt.toISOString()).toBe("2026-09-05T08:15:00.000Z");
  });
  it("parses RSS 2.0 and drops entries without a date", () => {
    const items = parseFeed(rss);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "rss", externalId: "https://forum.example/t/123", author: "maria", threadId: null });
    expect(items[0].body).toBe("We are 12 people, 3 courts, how do we build an americano schedule & keep score?");
  });
  it("parses Hacker News hits (stories and comments)", () => {
    const items = parseHn({
      hits: [
        { objectID: "1", title: "Show HN: padel matchmaking", url: "https://x", author: "a", created_at: "2026-09-05T10:00:00Z", story_text: "<p>We built an app to find padel players</p>" },
        { objectID: "2", title: null, story_title: "Ask HN: tools for organising sports?", comment_text: "For padel we use a spreadsheet to schedule matches", author: "b", created_at: "2026-09-05T11:00:00Z", story_id: 3 },
        { objectID: "3", title: null, story_title: null, created_at: "2026-09-05T11:00:00Z" },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ source: "hn", externalId: "1", url: "https://news.ycombinator.com/item?id=1", body: "We built an app to find padel players" });
    expect(items[1].title).toBe("Ask HN: tools for organising sports?");
  });
});

describe("listen: relevance and language", () => {
  it("gates on padel plus an organising intent", () => {
    expect(looksRelevant({ title: "App to organise padel matches?", body: "" })).toBe(true);
    expect(looksRelevant({ title: "Look at this rally", body: "padel highlights" })).toBe(false);
    expect(looksRelevant({ title: "Best app to find tennis players", body: "" })).toBe(false);
    expect(looksRelevant({ title: "Как найти игроков в падел на Пхукете?", body: "Какое приложение?" })).toBe(true);
  });
  it("guesses the reply language", () => {
    expect(guessLanguage("Какое приложение для падела?")).toBe("ru");
    expect(guessLanguage("¿Qué app usáis para organizar partidos de pádel?")).toBe("es");
    expect(guessLanguage("Which app do you use for padel?")).toBe("en");
  });
  it("strips html and entities", () => {
    expect(stripHtml("<p>a &amp; b</p><p>c&#39;d</p>")).toBe("a & b\nc'd");
  });
});
