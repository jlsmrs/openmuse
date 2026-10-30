// DRAFT — Knowledge Desk search tool for the jlsmrs/openmuse fork.
// Placement: new file apps/server/src/engine/knowledge-desk.ts, imported by
// apps/server/src/engine/conversation.ts and added to its defineTool list.
//
// How it works: the agent searches a local JSON index, NOT the live Drive.
// Index file: <DATA_DIR>/knowledge-desk/index.json — an array of
//   { id, source, title, text, embedding?: number[] }
// built by the indexer script (knowledge-desk-index.py, same folder) from
// the desk documents once they are readable (Drive connect tap still pending).
//
// Env (set on openmuse-api at wiring time):
//   FOUNDRY_EMBEDDINGS_ENDPOINT — VERIFIED Oct 29:
//     https://veritas-webops-resource.services.ai.azure.com/embeddings
//     (OpenAI-style payload {input, model: "text-embedding-3-large"}, NOT /openai/v1/*)
//   FOUNDRY_EMBEDDINGS_KEY — Foundry resource key (falls back to OPENAI_API_KEY).
//
// Method honesty: if no embeddings key is configured, the tool falls back
// to keyword overlap scoring and says so in its result — it never pretends
// a keyword match is a semantic match. Every hit returns its source so the
// agent can cite it; the agent must never state Texas law from memory when
// the desk has an entry.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";

const params = z.object({
  query: z.string().trim().min(1).max(500),
  topK: z.number().int().min(1).max(10).optional(),
});

type Entry = { id: string; source: string; title: string; text: string; embedding?: number[] };

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function keywordScore(query: string, text: string): number {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
  const hay = text.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return terms.length ? hits / terms.length : 0;
}

export const searchKnowledgeDeskTool = defineTool({
  name: "search_knowledge_desk",
  description:
    "Search the Veritas Knowledge Desk index (SOPs, Texas notary law desk, curriculum). Returns matching passages with their sources. Cite the source in the answer. If no desk entry matches, say so — never answer Texas law from memory when the desk is silent. Falls back to keyword matching when no embeddings key is configured, and says which method it used.",
  parameters: params,
  execute: async (args) => {
    const { query, topK = 5 } = params.parse(args);
    const dataDir = process.env.DATA_DIR ?? ".openmuse";
    let entries: Entry[];
    try {
      entries = JSON.parse(await readFile(join(dataDir, "knowledge-desk", "index.json"), "utf8"));
    } catch {
      return {
        error:
          "Knowledge Desk index is not built yet (DATA_DIR/knowledge-desk/index.json missing).",
      };
    }
    const endpoint = process.env.FOUNDRY_EMBEDDINGS_ENDPOINT;
    const key = process.env.FOUNDRY_EMBEDDINGS_KEY || process.env.OPENAI_API_KEY;
    let method = "keyword";
    let queryEmbedding: number[] | undefined;
    if (endpoint && key) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ input: [query], model: "text-embedding-3-large" }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
          const payload = await res.json();
          queryEmbedding = payload?.data?.[0]?.embedding;
          if (queryEmbedding) method = "embeddings";
        }
      } catch {
        /* fall through to keyword */
      }
    }
    const scored = entries.map((e) => ({
      entry: e,
      score:
        queryEmbedding && e.embedding
          ? cosine(queryEmbedding, e.embedding)
          : keywordScore(query, `${e.title} ${e.text}`),
    }));
    scored.sort((a, b) => b.score - a.score);
    const hits = scored
      .slice(0, topK)
      .filter((s) => s.score > 0)
      .map((s) => ({
        source: s.entry.source,
        title: s.entry.title,
        score: Number(s.score.toFixed(4)),
        excerpt: s.entry.text.slice(0, 600),
      }));
    return {
      method,
      query,
      hits,
      note: hits.length ? undefined : "No desk entry matched. Do not answer from memory.",
    };
  },
});
