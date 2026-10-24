import { apiError, loadWorkspace } from "../../../lib/workspace-store";

export async function GET(request: Request) {
  try { return Response.json(await loadWorkspace(request), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return apiError(error); }
}
