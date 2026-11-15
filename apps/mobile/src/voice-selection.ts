// Voice provider selection: the Azure persona voice is PRIMARY and the
// on-device (local) voice is the fallback (R8, decided Nov 13, 2026).
// The Azure persona voice itself is a SEPARATE build — its voice pick is
// still pending and no Azure provider exists yet — so today every call
// resolves to "local". This module is the single selection point: the
// native voice module consults it before dictating or reading aloud, and
// the Azure build plugs in by registering a provider, with no rework of
// the local path.
//
// What the Azure build must provide for the primary path:
// - A provider object matching AzureVoiceProvider, registered once at
//   startup via registerAzureVoiceProvider().
// - isAvailable(): true only when the Azure persona voice is configured
//   and usable on this device (server-side speech reachable, voice
//   picked). It must return false — never throw — when unconfigured.
// - startDictation/speakText with the same callback shapes as the local
//   voice module, so the composer wiring does not change.
// - stopSpeaking() to cancel in-progress Azure speech.
// The selection is defensive: a provider that throws from isAvailable(),
// or one that is registered but reports unavailable, falls back to local
// instead of erroring. The choice is recorded per call (the handles the
// voice modules return carry `provider`) and in module state via
// getLastSelectedVoiceProvider(), so the fallback is observable without
// new UI copy.

export type VoiceProviderKind = "azure" | "local";

export interface DictationCallbacks {
  onTranscript: (transcript: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}

export interface ReadAloudCallbacks {
  onEnd: () => void;
  onError: (message: string) => void;
}

export interface VoiceHandle {
  stop: () => void;
  /** Which provider produced this handle — the selection, recorded. */
  provider: VoiceProviderKind;
}

/**
 * The contract the Azure persona-voice build must implement. The
 * callbacks match the local voice module exactly, so the composer wiring
 * (chat.tsx) does not change when the primary path lands.
 */
export interface AzureVoiceProvider {
  /** True only when the Azure persona voice is configured and usable. */
  isAvailable(): boolean;
  /** Start Azure dictation; null when it cannot start. */
  startDictation(callbacks: DictationCallbacks): VoiceHandle | null;
  /** Read text aloud with the Azure persona voice; null when it cannot start. */
  speakText(text: string, callbacks: ReadAloudCallbacks): VoiceHandle | null;
  /** Cancel any in-progress Azure speech. */
  stopSpeaking(): void;
}

let azureProvider: AzureVoiceProvider | null = null;
let lastSelected: VoiceProviderKind | null = null;

/** Register the Azure persona-voice provider (once, at startup). Pass null to unregister. */
export function registerAzureVoiceProvider(provider: AzureVoiceProvider | null): void {
  azureProvider = provider;
}

export function getAzureVoiceProvider(): AzureVoiceProvider | null {
  return azureProvider;
}

/**
 * Choose the voice provider: Azure first when a provider is registered
 * and reports available, local otherwise. Never throws — a provider
 * that fails its availability check falls back to local.
 */
export function selectVoiceProvider(): VoiceProviderKind {
  const provider = azureProvider;
  if (provider) {
    try {
      if (provider.isAvailable()) {
        lastSelected = "azure";
        return "azure";
      }
    } catch {
      // A broken provider must not break local voice: fall through.
    }
  }
  lastSelected = "local";
  return "local";
}

/** Which provider the last selection chose, or null before any selection. */
export function getLastSelectedVoiceProvider(): VoiceProviderKind | null {
  return lastSelected;
}

/**
 * Record the provider a call actually used. The voice modules call this
 * when the primary returns null and the call falls through to local, so
 * the recorded choice matches the handle returned — the selection alone
 * would still say "azure" for a call that ended up local.
 */
export function recordVoiceProvider(kind: VoiceProviderKind): void {
  lastSelected = kind;
}
