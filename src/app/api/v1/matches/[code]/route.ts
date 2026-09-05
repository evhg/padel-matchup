import { ApiError, json, options } from "@/lib/api/http";
import { READ_CACHE, withApi } from "@/lib/api/route";
import { matchToPublic } from "@/lib/api/serialize";
import { baseUrl } from "@/lib/config";
import { getGroupById } from "@/lib/domain/groups";
import { getEventByCode } from "@/lib/domain/queries";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return withApi(req, "read", async ({ db }) => {
    const detail = await getEventByCode(db, code);
    if (!detail) throw new ApiError(404, "not_found", `No match with code ${code}.`, "Codes are 4 characters, case-sensitive, from a kicksma.sh link.");
    const group = detail.event.groupId ? await getGroupById(db, detail.event.groupId) : null;
    return json(matchToPublic(detail, baseUrl(), group ? { code: group.code, name: group.name } : null), { cache: READ_CACHE });
  });
}

export async function OPTIONS() {
  return options();
}
