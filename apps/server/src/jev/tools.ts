import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { type JevToolResult, jevOptionSchema } from "../../../../packages/domain/src/jev.ts";
import type { JevService } from "./service.ts";

const optionInput = jevOptionSchema
  .omit({ id: true })
  .extend({ id: z.string().trim().min(1).max(200).optional() });
export const presentChoicesParameters = z
  .object({
    message: z.string().trim().min(1).max(2000),
    context: z.string().trim().min(1).max(8000),
    title: z.string().trim().min(1).max(200),
    control: z.enum(["clarification", "comparison"]),
    options: z.array(optionInput).max(12),
    mailThreadId: z.string().trim().min(1).max(500).optional(),
    refinementPanelId: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (!input.refinementPanelId && input.options.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "New choices need at least one option",
      });
    if (input.refinementPanelId && input.options.length > 0)
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message:
          "Refining a panel reuses the original options; leave options empty and supply only refinementPanelId",
      });
  });
export function presentChoicesTool(
  jev: JevService,
  owner: string,
  threadId: string,
  turnId: string,
  signal: AbortSignal,
  mode: "sample" | "live",
  userMessage?: string,
) {
  return defineTool({
    name: "present_choices",
    description:
      "Present prepared clarification buttons or a sourced comparison after reading evidence. For choices based on a read email, include its mailThreadId; generic choices need no mail. Give 1–12 factual options for a new panel. Each comparison option needs at least one detail; its label, source titles, and details must be exact excerpts from the read source page text. To refine an earlier panel, supply refinementPanelId and leave options empty; the server reuses the full original candidate set. This only asks the user for a preference and performs no external action.",
    parameters: presentChoicesParameters,
    execute: async (input): Promise<JevToolResult> => {
      try {
        signal.throwIfAborted();
        if (
          mode === "live" &&
          input.mailThreadId &&
          !(await jev.hasEvidence(owner, threadId, turnId, "mail", input.mailThreadId))
        )
          throw new Error("Read the referenced email before presenting choices.");
        if (mode === "live" && input.control === "comparison") {
          if (input.refinementPanelId) {
            await jev.candidateSources(owner, threadId, turnId, input.refinementPanelId);
          } else {
            for (const option of input.options) {
              const texts: string[] = [];
              for (const source of option.sources) {
                const observed = await jev.evidenceText(owner, threadId, turnId, "web", source.url);
                if (!observed)
                  throw new Error(`Read the source page before comparing: ${source.url}`);
                // The tool description promises exact excerpts, so the
                // check is an exact substring match on the read text —
                // not a normalised one. A label, title, or detail that
                // differs in case or spacing is not the excerpt it claims.
                if (!observed.includes(source.title))
                  throw new Error(
                    `Comparison source title is not present in source text: ${source.url}`,
                  );
                texts.push(observed);
              }
              // The label is grounded in every source the option cites,
              // not just any one of them: a source that never mentions
              // the label cannot evidence it.
              for (const text of texts)
                if (!text.includes(option.label))
                  throw new Error(
                    `Comparison label is not present in source text: ${option.label}`,
                  );
              if (!option.details.length)
                throw new Error(`Comparison needs at least one grounded detail: ${option.label}`);
              for (const detail of option.details)
                if (!texts.some((observed) => observed.includes(detail)))
                  throw new Error(
                    `Comparison detail is not present in source text: ${option.label}`,
                  );
            }
          }
        }
        return await jev.createPanel(owner, threadId, turnId, { ...input, userMessage }, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const message =
          error instanceof Error ? error.message : "Could not prepare choices. Please retry.";
        return {
          panel: null,
          error: message.length < 300 ? message : "Could not prepare choices. Please retry.",
        };
      }
    },
  });
}
