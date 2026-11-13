import { readApiPayload } from "./api-response";

/**
 * Resolve the API origin. There is deliberately no silent localhost default:
 * when no API URL is configured, fail fast with a clear dev-time error
 * instead of pointing the app at a localhost server that does not exist in
 * production (or on a real device). The live web build inlines
 * EXPO_PUBLIC_API_URL, so this bites local dev and native runs only.
 */
export function resolveApiUrl(envUrl: string | undefined): string {
  if (envUrl) return envUrl.replace(/\/$/, "");
  throw new Error(
    "EXPO_PUBLIC_API_URL is not configured. Set it to your API origin — for local development, EXPO_PUBLIC_API_URL=http://localhost:8787 (or http://10.0.2.2:8787 on the Android emulator).",
  );
}

export const API_URL = resolveApiUrl(process.env.EXPO_PUBLIC_API_URL);

export class MuseApi {
  constructor(readonly token: string) {}
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await fetch(`${API_URL}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const payload = await readApiPayload<T>(response);
    return payload;
  }
  url(path: string) {
    return path.startsWith("http") ? path : `${API_URL}${path}`;
  }
}

export async function createSession(
  accessKey?: string,
): Promise<{ token: string; mode: "sample" | "live" }> {
  const response = await fetch(`${API_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey }),
  });
  const payload = await readApiPayload<{ token: string; mode: "sample" | "live" }>(
    response,
    "Could not open your workspace.",
  );
  return payload;
}
