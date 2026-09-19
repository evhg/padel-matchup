import "server-only";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { competitionCategories, competitions } from "@/db/schema";
import { awardCompetitionPodium } from "@/lib/domain/competitionLive";
import { tellPodium } from "./notify";

/** After any result: when the category is done, the podium is awarded (once) and told. */
export async function afterResult(db: Db, categoryId: string): Promise<number> {
  const [category] = await db.select().from(competitionCategories).where(eq(competitionCategories.id, categoryId)).limit(1);
  if (!category || category.drawStatus !== "done") return 0;
  const awards = await awardCompetitionPodium(db, categoryId);
  if (awards.length === 0) return 0;
  const [competition] = await db.select().from(competitions).where(eq(competitions.id, category.competitionId)).limit(1);
  if (competition) await tellPodium(db, competition, category, awards).catch(() => undefined);
  return awards.length;
}
