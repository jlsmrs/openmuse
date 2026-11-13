import { z } from "zod";

const resultSchema = z
  .object({
    action: z.string().optional(),
    receiptId: z.string().optional(),
    error: z.string().optional(),
  })
  // An object with none of the known fields is not a tool result: it must
  // fall through to the raw-result fallback instead of parsing to {}.
  .refine(
    (value) =>
      value.action !== undefined || value.receiptId !== undefined || value.error !== undefined,
  );
export type DesktopToolResult = z.infer<typeof resultSchema>;

/** Parse a desktop tool result: a JSON string, or an already-parsed object. */
export function parseDesktopResult(result: unknown): DesktopToolResult | undefined {
  if (typeof result === "string") {
    try {
      const parsed = resultSchema.safeParse(JSON.parse(result));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  const parsed = resultSchema.safeParse(result);
  return parsed.success ? parsed.data : undefined;
}

/** The raw result for the fallback line: the string itself, or the JSON of an
 * object the schema does not understand — never a bare "Desktop step". */
export function rawDesktopResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result;
  if (result instanceof Error) return result.message;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
