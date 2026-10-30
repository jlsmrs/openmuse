// Voice v1: a speech front end to Charlie's existing chat, for the web app
// only. Input uses the browser's built-in speech recognition; replies are
// read back with the device voice. This is deliberately NOT a persona voice:
// the device voice is whatever the browser provides, and it cannot be made
// to sound like Charlie. Native mobile apps have no browser speech APIs, so
// these controls only appear on web. Nothing here records, uploads, or
// sends audio anywhere — recognition and synthesis both run in the browser.

export interface RecognitionAlternative {
  transcript: string;
}

export interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
  length: number;
}

export interface RecognitionResultEvent {
  results: ArrayLike<RecognitionResult>;
}

export interface RecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

export interface RecognitionConstructor {
  new (): RecognitionInstance;
}

export interface UtteranceInstance {
  text: string;
  rate: number;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

export interface UtteranceConstructor {
  new (text: string): UtteranceInstance;
}

export interface SynthesisInstance {
  speak: (utterance: UtteranceInstance) => void;
  cancel: () => void;
}

export interface SpeechEnv {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
  speechSynthesis?: SynthesisInstance;
  SpeechSynthesisUtterance?: UtteranceConstructor;
}

function windowEnv(): SpeechEnv {
  if (typeof globalThis === "undefined") return {};
  const w = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (!w || typeof w !== "object") return {};
  return {
    SpeechRecognition: w.SpeechRecognition as RecognitionConstructor | undefined,
    webkitSpeechRecognition: w.webkitSpeechRecognition as RecognitionConstructor | undefined,
    speechSynthesis: w.speechSynthesis as SynthesisInstance | undefined,
    SpeechSynthesisUtterance: w.SpeechSynthesisUtterance as UtteranceConstructor | undefined,
  };
}

/** Live browser environment; pass a fake env in tests. */
export function defaultSpeechEnv(): SpeechEnv {
  return windowEnv();
}

export function voiceSupport(env: SpeechEnv = defaultSpeechEnv()): {
  dictation: boolean;
  readback: boolean;
} {
  return {
    dictation: Boolean(env.SpeechRecognition ?? env.webkitSpeechRecognition),
    readback: Boolean(env.speechSynthesis && env.SpeechSynthesisUtterance),
  };
}

export function joinTranscript(event: RecognitionResultEvent): string {
  return Array.from(event.results, (result) => result[0]?.transcript ?? "").join("");
}

export interface DictationHandle {
  stop: () => void;
}

/**
 * Start browser dictation. onTranscript receives the full transcript so far
 * on every result (interim and final); the caller keeps its own base text
 * and replaces the dictated tail. Returns null when unsupported. The
 * recognizer is never restarted automatically: when it ends, onEnd fires and
 * dictation is off until the user starts it again.
 */
export function startDictation(
  env: SpeechEnv,
  callbacks: {
    onTranscript: (transcript: string) => void;
    onError: (message: string) => void;
    onEnd: () => void;
  },
): DictationHandle | null {
  const Constructor = env.SpeechRecognition ?? env.webkitSpeechRecognition;
  if (!Constructor) return null;
  let recognition: RecognitionInstance;
  try {
    recognition = new Constructor();
  } catch {
    callbacks.onError("Speech recognition could not be started in this browser.");
    return null;
  }
  let stopped = false;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  recognition.onresult = (event) => {
    callbacks.onTranscript(joinTranscript(event));
  };
  recognition.onerror = (event) => {
    callbacks.onError(
      event.error ? `Speech recognition failed (${event.error}).` : "Speech recognition failed.",
    );
  };
  recognition.onend = () => {
    if (!stopped) callbacks.onEnd();
  };
  try {
    recognition.start();
  } catch {
    callbacks.onError("Speech recognition could not be started in this browser.");
    return null;
  }
  return {
    stop: () => {
      stopped = true;
      try {
        recognition.stop();
      } catch {
        // Already stopped; nothing to do.
      }
    },
  };
}

export interface SpeechHandle {
  stop: () => void;
}

/**
 * Read text aloud with the device voice. Any speech already in progress is
 * cancelled first. Returns null when unsupported. The voice is the browser's
 * default voice — it is not Charlie's persona voice.
 */
export function speakText(
  env: SpeechEnv,
  text: string,
  callbacks: { onEnd: () => void; onError: (message: string) => void },
): SpeechHandle | null {
  if (!env.speechSynthesis || !env.SpeechSynthesisUtterance) return null;
  const synthesis = env.speechSynthesis;
  try {
    synthesis.cancel();
    const utterance = new env.SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.onend = () => callbacks.onEnd();
    utterance.onerror = (event) => {
      callbacks.onError(event.error ? `Read-aloud failed (${event.error}).` : "Read-aloud failed.");
    };
    synthesis.speak(utterance);
  } catch {
    callbacks.onError("Read-aloud is not available in this browser.");
    return null;
  }
  return {
    stop: () => {
      try {
        synthesis.cancel();
      } catch {
        // Nothing speaking; nothing to do.
      }
    },
  };
}

export function stopSpeaking(env: SpeechEnv): void {
  try {
    env.speechSynthesis?.cancel();
  } catch {
    // Nothing speaking; nothing to do.
  }
}
