// DRAFT — Veritas read-only CRM tools for the jlsmrs/openmuse fork.
// Placement: new file apps/server/src/engine/veritas-readonly.ts, imported by
// apps/server/src/engine/conversation.ts and added to its defineTool list.
//
// Scope (verified Oct 29 from the site code, read-only inspection):
//   GET /api/jobs            — list jobs (status, q, view filters)
//   GET /api/jobs/today      — today's run board (date param)
//   GET /api/jobs/[id]       — one job
//   GET /api/signings        — signings list
// All gated by requireStaffOrBot: staff session OR Bearer bot token.
// This module is GET-ONLY by construction: it contains no POST/PUT/PATCH/
// DELETE call anywhere. It cannot create, change, or cancel anything in
// the CRM, no matter what it is asked.
//
// Env (set on openmuse-api at wiring time):
//   VERITAS_CRM_BASE_URL  — default https://veritas-notary.com (verify at wiring)
//   VERITAS_CRM_BOT_TOKEN — bot bearer token SUPPLIED BY JOSH at wiring time,
//     stored as a secret on openmuse-api. Never log it, never return it.
//     Do NOT extract the site's existing bot secret from its Azure app.

import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";

function crmBase(): string {
  return (process.env.VERITAS_CRM_BASE_URL || "https://veritas-notary.com").replace(/\/$/, "");
}

async function crmGet(path: string): Promise<unknown> {
  const token = process.env.VERITAS_CRM_BOT_TOKEN;
  if (!token)
    return {
      error: "Veritas CRM read tools are not configured: VERITAS_CRM_BOT_TOKEN is missing.",
    };
  const res = await fetch(`${crmBase()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401 || res.status === 403)
    return { error: "CRM token rejected (401/403). Token may be wrong or revoked." };
  if (!res.ok) return { error: `CRM request failed: HTTP ${res.status}.` };
  const payload = await res.json();
  return payload;
}

const truncate = (value: unknown, chars = 8000) => {
  const s = JSON.stringify(value);
  return s.length > chars ? `${s.slice(0, chars)}…[truncated]` : s;
};

export const todaysSigningsTool = defineTool({
  name: "veritas_todays_signings",
  description:
    "Read-only: today's Veritas signing run board (GET /api/jobs/today). Returns scheduled signings and their status. Cannot change anything.",
  parameters: z.object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  }),
  execute: async (args) => {
    const { date } = args as { date?: string };
    const result = await crmGet(`/api/jobs/today${date ? `?date=${date}` : ""}`);
    return { result: truncate(result) };
  },
});

export const searchJobsTool = defineTool({
  name: "veritas_search_jobs",
  description:
    "Read-only: search Veritas CRM jobs (GET /api/jobs, optional status and text filters). Returns matching jobs. Cannot change anything.",
  parameters: z.object({
    status: z.string().trim().max(50).optional(),
    q: z.string().trim().max(200).optional(),
  }),
  execute: async (args) => {
    const { status, q } = args as { status?: string; q?: string };
    const qs = new URLSearchParams({
      ...(status ? { status } : {}),
      ...(q ? { q } : {}),
    }).toString();
    const result = await crmGet(`/api/jobs${qs ? `?${qs}` : ""}`);
    return { result: truncate(result) };
  },
});

export const getJobTool = defineTool({
  name: "veritas_get_job",
  description:
    "Read-only: fetch one Veritas CRM job by id (GET /api/jobs/[id]). Cannot change anything.",
  parameters: z.object({ id: z.string().trim().min(1).max(100) }),
  execute: async (args) => {
    const { id } = args as { id: string };
    const result = await crmGet(`/api/jobs/${encodeURIComponent(id)}`);
    return { result: truncate(result) };
  },
});
