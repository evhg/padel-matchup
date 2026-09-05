import { ApiError, json, options } from "@/lib/api/http";
import { READ_CACHE, withApi } from "@/lib/api/route";
import { groupToPublic } from "@/lib/api/serialize";
import { baseUrl } from "@/lib/config";
import { getGroupByCode, getGroupDetail } from "@/lib/domain/groups";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return withApi(req, "read", async ({ db }) => {
    const g = await getGroupByCode(db, code);
    if (!g) throw new ApiError(404, "not_found", `No group with code ${code}.`, "Group codes are 6 characters, from a kicksma.sh/g/ link.");
    return json(groupToPublic(await getGroupDetail(db, g), baseUrl()), { cache: READ_CACHE });
  });
}

export async function OPTIONS() {
  return options();
}
