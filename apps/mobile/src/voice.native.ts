// Native voice (R8): on-device dictation and read-aloud for the native
// apps, via the platform speech modules — expo-speech-recognition for
// dictation (iOS SFSpeechRecognizer / Android SpeechRecognizer) and
// expo-speech for read-aloud (system text-to-speech).
//
// This file is the native half of the voice module: Metro resolves
// "./voice" to this file on iOS/Android and to voice.web.ts on web, so the
// web voice path is untouched. It exports the same surface chat.tsx
// uses (defaultSpeechEnv, voiceSupport, startDictation, speakText,
// stopSpeaking, DictationHandle, SpeechHandle) plus
// resolveNativeVoiceSupport, which chat.tsx calls on mount to learn
// which native controls to show.
//
// Azure is PRIMARY, local is the fallback: startDictation and speakText
// consult selectVoiceProvider() first and delegate to the registered
// Azure provider when one is available; today none is registered (the
// Azure persona-voice build is separate, voice pick pending), so every
// call resolves to local. See voice-selection.ts for what the Azure
// build must provide.
//
// Dev builds vs Expo Go — read this before testing on a device:
// - Read-aloud (expo-speech) is included in Expo Go, so it works in
//   Expo Go and in a dev build.
// - Dictation (expo-speech-recognition) is a native module that is NOT
//   in Expo Go: it needs a development build (expo-dev-client is
//   already a dependency). In Expo Go the module cannot load, so
//   dictation reports unavailable instead of crashing — the mic button
//   simply does not appear.
// - The config plugin (app.json) adds the Android RECORD_AUDIO
//   permission and the iOS microphone / speech-recognition usage
//   descriptions; without a dev build that includes it, dictation
//   cannot start even if the code is present.
//
// Nothing here records, uploads, or sends audio anywhere: recognition
// and synthesis both run on the device (network-based recognition is
// the platform default, as with the browser path — no audio is sent to
// OpenMuse or any OpenMuse server).

import {
  getAzureVoiceProvider,
  getLastSelectedVoiceProvider,
  recordVoiceProvider,
  selectVoiceProvider,
  type VoiceProviderKind,
} from "./voice-selection";

/**
 * Minimal surface of expo-speech-recognition used here, written
 * structurally so tests can pass fakes and the real module (imported
 * lazily, see loadNativeModules) satisfies it. Method shapes mirror
 * expo-speech-recognition@3.1.3 (ExpoSpeechRecognitionModule).
 */
export interface NativeRecognition {
  requestPermissionsAsync(): Promise<{ granted: boolean; status?: string }>;
  /** True when a recognizer service is available on this device. */
  isRecognitionAvailable?: () => boolean;
  start(options: { lang: string; interimResults: boolean; continuous: boolean }): void;
  stop(): void;
  addListener(
    event: "result",
    listener: (event: { isFinal: boolean; results: { transcript: string }[] }) => void,
  ): { remove(): void };
  addListener(
    event: "error",
    listener: (event: { error: string; message: string }) => void,
  ): { remove(): void };
  addListener(event: "end", listener: () => void): { remove(): void };
}

/** Minimal surface of expo-speech used here (expo-speech ~14.0.8). */
export interface NativeSpeech {
  speak(
    text: string,
    options: {
      language?: string;
      rate?: number;
      onDone?: () => void;
      onError?: (error: Error) => void;
    },
  ): void;
  stop(): Promise<void>;
}

/**
 * Native speech environment. The modules are loaded lazily (see
 * loadNativeModules) so importing this file never touches native code:
 * in Expo Go the recognition module is absent, in tests the env is a
 * fake, and on web this file is never loaded at all.
 */
export interface NativeSpeechEnv {
  speech?: NativeSpeech;
  recognition?: NativeRecognition;
  /** BCP 47 language tag for dictation, e.g. "fr-FR". Defaults to en-US. */
  language?: string;
}

let cachedEnv: NativeSpeechEnv | null = null;
let loadPromise: Promise<NativeSpeechEnv> | null = null;

/**
 * Load the native speech modules (dynamic import, each guarded): a
 * module that cannot load — expo-speech-recognition in Expo Go, where
 * the native module does not exist — is recorded as absent instead of
 * throwing. The result is cached; callers that run before the load
 * finishes see an empty env and report unavailable.
 */
async function loadNativeModules(): Promise<NativeSpeechEnv> {
  if (cachedEnv) return cachedEnv;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const env: NativeSpeechEnv = {};
    try {
      const speech = await import("expo-speech");
      env.speech = speech;
    } catch {
      env.speech = undefined;
    }
    try {
      const recognition = await import("expo-speech-recognition");
      // The module's generic addListener does not line up with the
      // narrowed overloads on NativeRecognition, so this one assignment
      // is cast; the surface it exposes is pinned by the tests.
      env.recognition = recognition.ExpoSpeechRecognitionModule as unknown as NativeRecognition;
    } catch {
      env.recognition = undefined;
    }
    cachedEnv = env;
    return env;
  })();
  return loadPromise;
}

/** For tests: install a fake env (or null to clear it). */
export function __setNativeSpeechEnvForTests(env: NativeSpeechEnv | null): void {
  cachedEnv = env;
  loadPromise = null;
}

/** Live native environment; pass a fake env in tests. */
export function defaultSpeechEnv(): NativeSpeechEnv {
  return cachedEnv ?? {};
}

/**
 * Resolve which native voice controls to show. Loads the native
 * modules, so it must run before the mic / read-aloud buttons are
 * shown — chat.tsx calls it on mount (native only). In Expo Go the
 * recognition module cannot load, so dictation is false while
 * read-aloud stays true.
 */
export async function resolveNativeVoiceSupport(): Promise<{
  dictation: boolean;
  readback: boolean;
}> {
  return voiceSupport(await loadNativeModules());
}

export function voiceSupport(env: NativeSpeechEnv = defaultSpeechEnv()): {
  dictation: boolean;
  readback: boolean;
} {
  return {
    dictation: Boolean(env.recognition),
    readback: Boolean(env.speech),
  };
}

/** Which provider the last dictation / read-aloud call used. */
export function getLastVoiceProvider(): VoiceProviderKind | null {
  return getLastSelectedVoiceProvider();
}

export interface DictationHandle {
  stop: () => void;
  /** Which provider produced this handle — the selection, recorded. */
  provider: VoiceProviderKind;
}

export interface SpeechHandle {
  stop: () => void;
  /** Which provider produced this handle — the selection, recorded. */
  provider: VoiceProviderKind;
}

/** Join a finished segment onto the transcript so far, one space apart. */
function appendTranscript(base: string, addition: string): string {
  const tail = addition.trim();
  if (!tail) return base;
  if (!base) return tail;
  return base.endsWith(" ") ? `${base}${tail}` : `${base} ${tail}`;
}

/**
 * Start native dictation. onTranscript receives the full transcript so
 * far on every result (interim and final), matching the web contract:
 * the caller keeps its own base text and replaces the dictated tail.
 * Returns null when dictation is unavailable (no recognition module —
 * e.g. Expo Go — or no recognizer service on the device). Permission
 * is requested when dictation starts; a denial reports through
 * onError and ends dictation instead of throwing. The recognizer is
 * never restarted automatically: when it ends, onEnd fires and
 * dictation is off until the user starts it again.
 */
export function startDictation(
  env: NativeSpeechEnv,
  callbacks: {
    onTranscript: (transcript: string) => void;
    onError: (message: string) => void;
    onEnd: () => void;
  },
): DictationHandle | null {
  // Azure first, local as fallback (see voice-selection.ts).
  if (selectVoiceProvider() === "azure") {
    const azure = getAzureVoiceProvider();
    const handle = azure?.startDictation(callbacks) ?? null;
    if (handle) return handle;
  }
  recordVoiceProvider("local");
  const recognition = env.recognition;
  if (!recognition) return null;
  if (recognition.isRecognitionAvailable && !recognition.isRecognitionAvailable()) {
    callbacks.onError("Speech recognition is not available on this device.");
    return null;
  }
  let stopped = false;
  let finished = false;
  let finalTranscript = "";
  const listeners: { remove(): void }[] = [];
  const finish = (error?: string) => {
    if (finished) return;
    finished = true;
    for (const listener of listeners) {
      try {
        listener.remove();
      } catch {
        // Already removed; nothing to do.
      }
    }
    if (error) callbacks.onError(error);
    callbacks.onEnd();
  };
  // Permission is async: start the recognizer once granted, and report
  // a denial instead of starting. The handle's stop() cancels a start
  // that is still waiting on the permission dialog.
  void recognition
    .requestPermissionsAsync()
    .then((permission) => {
      if (stopped) return;
      if (!permission.granted) {
        finish(
          "Microphone or speech recognition permission was denied. " +
            "Enable it in the device settings to dictate.",
        );
        return;
      }
      try {
        listeners.push(
          recognition.addListener("result", (event) => {
            const current = event.results[0]?.transcript ?? "";
            if (event.isFinal) {
              finalTranscript = appendTranscript(finalTranscript, current);
              callbacks.onTranscript(finalTranscript);
            } else {
              callbacks.onTranscript(
                finalTranscript ? appendTranscript(finalTranscript, current) : current,
              );
            }
          }),
          recognition.addListener("error", (event) => {
            finish(
              event.error
                ? `Speech recognition failed (${event.error}).`
                : "Speech recognition failed.",
            );
          }),
          recognition.addListener("end", () => finish()),
        );
        recognition.start({
          lang: env.language || "en-US",
          interimResults: true,
          continuous: true,
        });
      } catch {
        finish("Speech recognition could not be started on this device.");
      }
    })
    .catch(() => {
      if (!stopped) finish("Speech recognition could not be started on this device.");
    });
  return {
    provider: "local",
    stop: () => {
      stopped = true;
      if (finished) return;
      finished = true;
      for (const listener of listeners) {
        try {
          listener.remove();
        } catch {
          // Already removed; nothing to do.
        }
      }
      try {
        recognition.stop();
      } catch {
        // Already stopped; nothing to do.
      }
    },
  };
}

/**
 * Read text aloud with the device voice. Any speech already in progress
 * is cancelled first. Returns null when unsupported. The voice is the
 * device's default voice — it is not Charlie's persona voice.
 */
export function speakText(
  env: NativeSpeechEnv,
  text: string,
  callbacks: { onEnd: () => void; onError: (message: string) => void },
): SpeechHandle | null {
  // Azure first, local as fallback (see voice-selection.ts).
  if (selectVoiceProvider() === "azure") {
    const azure = getAzureVoiceProvider();
    const handle = azure?.speakText(text, callbacks) ?? null;
    if (handle) return handle;
  }
  recordVoiceProvider("local");
  const speech = env.speech;
  if (!speech) return null;
  try {
    void speech.stop();
    speech.speak(text, {
      language: env.language,
      rate: 1,
      onDone: () => callbacks.onEnd(),
      onError: (error) => {
        callbacks.onError(
          error?.message ? `Read-aloud failed (${error.message}).` : "Read-aloud failed.",
        );
      },
    });
  } catch {
    callbacks.onError("Read-aloud is not available on this device.");
    return null;
  }
  return {
    provider: "local",
    stop: () => {
      try {
        void speech.stop();
      } catch {
        // Nothing speaking; nothing to do.
      }
    },
  };
}

export function stopSpeaking(env: NativeSpeechEnv): void {
  // Stop Azure speech too when a provider is registered: the chat screen
  // calls this on send/stop, and Azure is primary when present, so local
  // alone would leave Azure speech playing. A broken provider must not
  // break stopping local speech.
  const azure = getAzureVoiceProvider();
  if (azure) {
    try {
      azure.stopSpeaking();
    } catch {
      // Fall through to stopping local speech.
    }
  }
  try {
    void env.speech?.stop();
  } catch {
    // Nothing speaking; nothing to do.
  }
}
