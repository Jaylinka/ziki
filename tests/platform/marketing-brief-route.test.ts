import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const isTenantAdmin = vi.hoisted(() => vi.fn());
const requireAgent = vi.hoisted(() => vi.fn());
const projectFindFirst = vi.hoisted(() => vi.fn());
const projectFindUnique = vi.hoisted(() => vi.fn());
const briefFindUnique = vi.hoisted(() => vi.fn());
const briefUpsert = vi.hoisted(() => vi.fn());
const auditCreate = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next-auth", () => ({ default: vi.fn() }));
vi.mock("@/lib/agents/membership", () => ({ isTenantAdmin }));
vi.mock("@/lib/workflow", () => ({
  invalidateWorkflow: vi.fn(),
  workflowFor: vi.fn(async () => ({ revisionLimit: 2 })),
}));
vi.mock("@/lib/agents/require-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/require-agent")>()),
  requireAgent,
}));
vi.mock("@/lib/agents/rate-budget", () => ({
  consumeAgentBudget: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findFirst: projectFindFirst, findUnique: projectFindUnique },
    projectBrief: { findUnique: briefFindUnique, upsert: briefUpsert },
    projectAuditEvent: { create: auditCreate },
    agentAuditEvent: { create: vi.fn() },
    $transaction: transaction,
  },
}));

import { GET, PATCH } from "@/app/api/v1/projects/[id]/marketing/brief/route";

const ROW = { product: "Ziki, an issue tracker where agents do the work.", audience: null, currentFocus: null, outOfScope: null };
const BRIEF = {
  product: "Ziki, an issue tracker where agents do the work.",
  audience: null,
  website: "https://ziki.dev",
  current_focus: null,
  out_of_scope: null,
};

const agent = (over: Record<string, unknown> = {}) => ({
  agentId: "agent-1",
  name: "TestAgent",
  ownerId: "owner-1",
  ownerRole: "admin",
  tenantId: "tenant-1",
  level: "working",
  projectId: null,
  projectSlug: null,
  burst: false,
  keyId: "key-1",
  ...over,
});

const get = (id = "p1") =>
  GET(new NextRequest(`http://localhost/api/v1/projects/${id}/marketing/brief`, { headers: { authorization: "Bearer ziki_test" } }), {
    params: Promise.resolve({ id }),
  });

const patch = (body: unknown, id = "p1") =>
  PATCH(new NextRequest(`http://localhost/api/v1/projects/${id}/marketing/brief`, {
    method: "PATCH",
    headers: { authorization: "Bearer ziki_test", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });

describe("GET /api/v1/projects/{id}/marketing/brief (M-API-8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAgent.mockResolvedValue(agent());
    projectFindFirst.mockResolvedValue({ id: "p1" });
    projectFindUnique.mockResolvedValue({ siteUrl: "https://ziki.dev" });
    briefFindUnique.mockResolvedValue(ROW);
    isTenantAdmin.mockResolvedValue(false);
  });

  it("returns the brief for any agent in the workspace, admin or not", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projectId: "p1", brief: BRIEF });
    // Reading the brief needs no admin rights: agents already read it on agents/me.
    expect(isTenantAdmin).not.toHaveBeenCalled();
  });

  it("returns brief: null when nothing has been filled in", async () => {
    briefFindUnique.mockResolvedValue(null);
    projectFindUnique.mockResolvedValue({ siteUrl: null });
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).brief).toBeNull();
  });

  it("accepts a project slug as well as an id", async () => {
    const res = await get("my-project");
    expect(res.status).toBe(200);
    expect(projectFindFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", archivedAt: null, OR: [{ id: "my-project" }, { slug: "my-project" }] },
      select: { id: true },
    });
    expect((await res.json()).projectId).toBe("p1");
  });

  it("answers 404 for a project outside the tenant", async () => {
    projectFindFirst.mockResolvedValue(null);
    const res = await get("elsewhere");
    expect(res.status).toBe(404);
  });

  it("refuses a key issued for another project", async () => {
    requireAgent.mockResolvedValue(agent({ projectId: "other-project", projectSlug: "other" }));
    const res = await get();
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/v1/projects/{id}/marketing/brief (M-API-8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAgent.mockResolvedValue(agent());
    projectFindFirst.mockResolvedValue({ id: "p1" });
    projectFindUnique.mockResolvedValue({ siteUrl: "https://ziki.dev" });
    briefFindUnique.mockResolvedValue(null);
    isTenantAdmin.mockResolvedValue(true);
    transaction.mockImplementation(async (run: (tx: unknown) => unknown) =>
      run({ projectBrief: { upsert: briefUpsert }, projectAuditEvent: { create: auditCreate } }),
    );
  });

  it("saves the brief for an admin owner and returns it read back", async () => {
    const res = await patch({ product: "Ziki.", currentFocus: "First ten teams." });
    expect(res.status).toBe(200);
    expect(briefUpsert).toHaveBeenCalledWith({
      where: { projectId: "p1" },
      update: { product: "Ziki.", audience: null, currentFocus: "First ten teams.", outOfScope: null },
      create: { projectId: "p1", product: "Ziki.", audience: null, currentFocus: "First ten teams.", outOfScope: null },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        projectId: "p1",
        actorUserId: "owner-1",
        action: "marketing.brief.updated",
      }),
    });
    expect((await res.json()).projectId).toBe("p1");
  });

  it("clears a field the caller leaves out, because the brief is saved whole", async () => {
    briefFindUnique.mockResolvedValueOnce({ product: "Old.", audience: "Teams.", currentFocus: "Launch.", outOfScope: "Ads." });
    await patch({ product: "New." });
    expect(briefUpsert).toHaveBeenCalledWith({
      where: { projectId: "p1" },
      update: { product: "New.", audience: null, currentFocus: null, outOfScope: null },
      create: { projectId: "p1", product: "New.", audience: null, currentFocus: null, outOfScope: null },
    });
  });

  it("is a no-op when nothing changed", async () => {
    briefFindUnique.mockResolvedValue({ product: "Ziki.", audience: null, currentFocus: null, outOfScope: null });
    const res = await patch({ product: "Ziki." });
    expect(res.status).toBe(200);
    expect(briefUpsert).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("refuses an owner who is not a workspace admin with 403", async () => {
    isTenantAdmin.mockResolvedValue(false);
    const res = await patch({ product: "Ziki." });
    expect(res.status).toBe(403);
    expect(briefUpsert).not.toHaveBeenCalled();
  });

  it("refuses website, which belongs to project settings", async () => {
    const res = await patch({ product: "Ziki.", website: "https://elsewhere.example" });
    expect(res.status).toBe(422);
    expect(briefUpsert).not.toHaveBeenCalled();
  });

  it("refuses an over-long field", async () => {
    const res = await patch({ product: "x".repeat(601) });
    expect(res.status).toBe(422);
    expect(briefUpsert).not.toHaveBeenCalled();
  });

  it("answers 404 for a project outside the tenant", async () => {
    projectFindFirst.mockResolvedValue(null);
    const res = await patch({ product: "Ziki." }, "elsewhere");
    expect(res.status).toBe(404);
    expect(briefUpsert).not.toHaveBeenCalled();
  });
});
