import "./config.ts";
import { HttpAgent } from "@ag-ui/client";
import {
  type AgentsFactory,
  type CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { ConversationAgent } from "./engine/conversation.ts";
import type { AgentService } from "./engine/service.ts";
import { createJevAdapter, type JevAdapter } from "./jev/adapter.ts";

export function agentConfigured(config: Config) {
  if (config.agentBackend === "sample") return true;
  if (config.agentBackend === "agui") return Boolean(config.agentUrl);
  // The model string is "provider/model-id" (see the adapter in
  // engine/tanstack-agent.ts): the gate needs the key for THAT provider, not
  // just any provider key. An unset or unparseable model is not configured.
  const provider = config.model?.trim().split(/[/:]/)[0]?.toLowerCase();
  const keyName =
    provider === "openai"
      ? "OPENAI_API_KEY"
      : provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : provider === "google" || provider === "gemini" || provider === "google-gemini"
          ? "GOOGLE_API_KEY"
          : undefined;
  return Boolean(keyName && process.env[keyName]?.trim());
}

/** The agui backend needs a real endpoint; the old dead-local-port fallback failed obscurely. */
export function aguiAgentUrl(config: Config): string {
  if (!config.agentUrl?.trim())
    throw new Error("agent URL not configured: set AGENT_URL to use the agui backend");
  return config.agentUrl;
}
export function makeRuntime(
  config: Config,
  service: AgentService,
  auth: Auth,
  intelligence: CopilotKitIntelligence,
) {
  // Built on first use, then shared so live mode reuses one TypeSafe client across requests.
  let jevAdapter: JevAdapter | undefined;
  const sharedJevAdapter = () => (jevAdapter ??= createJevAdapter(config));
  const agents: AgentsFactory = async ({ request }) => ({
    default:
      config.agentBackend === "sample"
        ? new ConversationAgent(
            config,
            service,
            await auth.owner(request.headers.get("authorization") ?? undefined),
            sharedJevAdapter(),
          )
        : config.agentBackend === "agui"
          ? new HttpAgent({
              url: aguiAgentUrl(config),
              headers: config.agentToken ? { Authorization: `Bearer ${config.agentToken}` } : {},
            })
          : new ConversationAgent(
              config,
              service,
              await auth.owner(request.headers.get("authorization") ?? undefined),
              sharedJevAdapter(),
            ),
  });
  const runtime = new CopilotRuntime({
    agents,
    intelligence,
    // The shared CopilotKit sink carries this tag onto existing PostHog events.
    telemetryProperties: { accessibility_title: "OpenMuse" },
    identifyUser: async (request) => ({
      id: await auth.owner(request.headers.get("authorization") ?? undefined),
      name: "OpenMuse user",
    }),
    generateThreadNames: false,
  });
  return createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" });
}
