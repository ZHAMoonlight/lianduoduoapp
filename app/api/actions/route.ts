import { apiError, mutateWorkspace } from "../../../lib/workspace-store";

export async function POST(request: Request) {
  try { return Response.json(await mutateWorkspace(request), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return apiError(error); }
}
