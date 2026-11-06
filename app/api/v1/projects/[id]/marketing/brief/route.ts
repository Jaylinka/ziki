import { NextResponse, type NextRequest } from "next/server";
import { IssueApiError, agentIssueRequest, issueJson } from "@/lib/agent-api/issues";
import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { assertKeyProject } from "@/lib/agents/require-agent";
import { prisma } from "@/lib/prisma";
import { assertMarketingSettingsAccess } from "@/lib/marketing/settings";
import { readProjectBrief, saveProjectBrief } from "@/lib/marketing/brief";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The project's id from an id or a slug, inside the caller's own tenant. A
 * project id never grants access by itself, and an archived project reads as
 * missing, the same as the other project routes.
 */
async function projectInTenant(tenantId: string, projectIdOrSlug: string): Promise<string> {
  const project = await prisma.project.findFirst({
    where: { tenantId, archivedAt: null, OR: [{ id: projectIdOrSlug }, { slug: projectIdOrSlug }] },
    select: { id: true },
  });
  if (!project) throw new IssueApiError(404, "Project not found.");
  return project.id;
}

/**
 * GET /api/v1/projects/{id}/marketing/brief: the project brief for agents
 * (M-API-8). The same brief `GET /api/v1/agents/me` and the marketing work feed
 * return, for one named project — so an unscoped key, which has no single brief
 * of its own, can read the brief of the project it is working on.
 *
 * Reading needs no admin rights: every agent in the workspace reads the brief.
 * Charged to the read budget.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  return agentIssueRequest(request, "marketing.brief.read", "read", id, async (agent) => {
    const projectId = await projectInTenant(agent.tenantId, id);
    // A key issued for one project cannot read another's brief (#742).
    assertKeyProject(agent, projectId);
    return NextResponse.json({ projectId, brief: await readProjectBrief(projectId) });
  });
}

/**
 * PATCH /api/v1/projects/{id}/marketing/brief: write the brief (M-API-8).
 * Workspace owners and admins only, the same rule as the marketing settings
 * (M-API-6), so an agent can keep the brief current without a person opening
 * the settings form.
 *
 * The brief is saved whole, like the settings form does: send every field you
 * want to keep, because a field left out is cleared. `website` is not written
 * here — it is the project's Site URL, set in project settings.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  return agentIssueRequest(request, "marketing.brief.update", "working", id, async (agent) => {
    const projectId = await projectInTenant(agent.tenantId, id);
    assertKeyProject(agent, projectId);
    await assertMarketingSettingsAccess(
      { id: agent.ownerId, role: agent.ownerRole },
      agent.tenantId,
      "change",
    );
    const body = await issueJson(request);
    await saveProjectBrief(agent.tenantId, projectId, agent.ownerId, body);
    return NextResponse.json({ projectId, brief: await readProjectBrief(projectId) });
  });
}

const apiMethodNotAllowed = createMethodNotAllowed(["GET", "HEAD", "PATCH", "OPTIONS"]);
export const PUT = apiMethodNotAllowed;
export const POST = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const OPTIONS = createOptions(["GET", "HEAD", "PATCH", "OPTIONS"]);
