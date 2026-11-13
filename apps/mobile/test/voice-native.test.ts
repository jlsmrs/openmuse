// Native voice (R8): on-device dictation via expo-speech-recognition and
// read-aloud via expo-speech, with permission handling and graceful
// degradation. Fakes implement the minimal module surfaces so the tests
// run without a device, a dev build, or Expo Go.
import assert from "node:assert/strict";
import test from "node:test";
import {
  __setNativeSpeechEnvForTests,
  defaultSpeechEnv,
  getLastVoiceProvider,
  type NativeRecognition,
  type NativeSpeech,
  type NativeSpeechEnv,
  resolveNativeVoiceSupport,
  speakText,
  startDictation,
  stopSpeaking,
  voiceSupport,
} from "../src/voice.native.ts";
import { type AzureVoiceProvider, registerAzureVoiceProvider } from "../src/voice-selection.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type ResultListener = (event: { isFinal: boolean; results: { transcript: string }[] }) => void;
type ErrorListener = (event: { error: string; message: string }) => void;
type EndListener = () => void;

class FakeRecognition implements NativeRecognition {
  permissionGranted = true;
  available = true;
  started = false;
  stopped = false;
  startOptions: { lang: string; interimResults: boolean; continuous: boolean } | null = null;
  private resultListeners: ResultListener[] = [];
  private errorListeners: ErrorListener[] = [];
  private endListeners: EndListener[] = [];

  requestPermissionsAsync = async () => ({
    granted: this.permissionGranted,
    status: this.permissionGranted ? "granted" : "denied",
  });

  isRecognitionAvailable = () => this.available;

  start = (options: { lang: string; interimResults: boolean; continuous: boolean }) => {
    this.started = true;
    this.startOptions = options;
  };

  stop = () => {
    this.stopped = true;
  };

  addListener(event: "result", listener: ResultListener): { remove(): void };
  addListener(event: "error", listener: ErrorListener): { remove(): void };
  addListener(event: "end", listener: EndListener): { remove(): void };
  addListener(
    event: "result" | "error" | "end",
    listener: (...args: never[]) => void,
  ): { remove(): void } {
    const list =
      event === "result"
        ? this.resultListeners
        : event === "error"
          ? this.errorListeners
          : this.endListeners;
    list.push(listener as never);
    return {
      remove: () => {
        const index = list.indexOf(listener as never);
        if (index >= 0) list.splice(index, 1);
      },
    };
  }

  emitResult = (isFinal: boolean, transcript: string) => {
    for (const listener of [...this.resultListeners]) {
      listener({ isFinal, results: [{ transcript }] });
    }
  };

  emitError = (error: string, message: string) => {
    for (const listener of [...this.errorListeners]) {
      listener({ error, message });
    }
  };

  emitEnd = () => {
    for (const listener of [...this.endListeners]) listener();
  };
}

class FakeSpeech implements NativeSpeech {
  spoken: { text: string; rate?: number; language?: string }[] = [];
  stopCalls = 0;
  private done: (() => void) | null = null;
  private failed: ((error: Error) => void) | null = null;

  speak = (
    text: string,
    options: {
      language?: string;
      rate?: number;
      onDone?: () => void;
      onError?: (error: Error) => void;
    },
  ) => {
    this.spoken.push({ text, rate: options.rate, language: options.language });
    this.done = options.onDone ?? null;
    this.failed = options.onError ?? null;
  };

  stop = async () => {
    this.stopCalls += 1;
  };

  emitDone = () => {
    this.done?.();
  };

  emitError = (message: string) => {
    this.failed?.(new Error(message));
  };
}

class FakeAzure implements AzureVoiceProvider {
  available = true;
  returnNull = false;
  dictationCalls = 0;
  speakCalls = 0;
  stopSpeakingCalls = 0;

  isAvailable = () => this.available;

  startDictation = () => {
    this.dictationCalls += 1;
    if (this.returnNull) return null;
    return { provider: "azure" as const, stop: () => {} };
  };

  speakText = () => {
    this.speakCalls += 1;
    if (this.returnNull) return null;
    return { provider: "azure" as const, stop: () => {} };
  };

  stopSpeaking = () => {
    this.stopSpeakingCalls += 1;
  };
}

test("voiceSupport: matrix over speech and recognition presence", () => {
  const speech = new FakeSpeech();
  const recognition = new FakeRecognition();
  assert.deepEqual(voiceSupport({ speech, recognition }), { dictation: true, readback: true });
  assert.deepEqual(voiceSupport({ speech }), { dictation: false, readback: true });
  assert.deepEqual(voiceSupport({ recognition }), { dictation: true, readback: false });
  assert.deepEqual(voiceSupport({}), { dictation: false, readback: false });
});

test("dictation streams interim and final transcripts, accumulating finals", async () => {
  const recognition = new FakeRecognition();
  const transcripts: string[] = [];
  const errors: string[] = [];
  let ended = 0;
  const handle = startDictation(
    { recognition },
    {
      onTranscript: (text) => transcripts.push(text),
      onError: (message) => errors.push(message),
      onEnd: () => {
        ended += 1;
      },
    },
  );
  assert.ok(handle);
  assert.equal(handle.provider, "local");
  await tick();
  assert.equal(recognition.started, true);
  assert.deepEqual(recognition.startOptions, {
    lang: "en-US",
    interimResults: true,
    continuous: true,
  });
  recognition.emitResult(false, "hello");
  assert.deepEqual(transcripts, ["hello"]);
  recognition.emitResult(true, "hello world");
  assert.deepEqual(transcripts, ["hello", "hello world"]);
  recognition.emitResult(true, "again");
  assert.deepEqual(transcripts, ["hello", "hello world", "hello world again"]);
  assert.deepEqual(errors, []);
  assert.equal(ended, 0);
});

test("dictation permission denied: onError and onEnd, recognizer never starts", async () => {
  const recognition = new FakeRecognition();
  recognition.permissionGranted = false;
  const errors: string[] = [];
  let ended = 0;
  const handle = startDictation(
    { recognition },
    {
      onTranscript: () => {
        throw new Error("must not be called");
      },
      onError: (message) => errors.push(message),
      onEnd: () => {
        ended += 1;
      },
    },
  );
  assert.ok(handle);
  await tick();
  assert.equal(recognition.started, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /permission was denied/);
  assert.equal(ended, 1);
});

test("dictation with no recognizer service: onError, returns null", () => {
  const recognition = new FakeRecognition();
  recognition.available = false;
  const errors: string[] = [];
  const handle = startDictation(
    { recognition },
    {
      onTranscript: () => {
        throw new Error("must not be called");
      },
      onError: (message) => errors.push(message),
      onEnd: () => {
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(handle, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not available on this device/);
});

test("dictation with no recognition module (e.g. Expo Go): returns null, no error", () => {
  const handle = startDictation(
    {},
    {
      onTranscript: () => {
        throw new Error("must not be called");
      },
      onError: () => {
        throw new Error("must not be called");
      },
      onEnd: () => {
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(handle, null);
});

test("dictation error event: onError and onEnd exactly once", async () => {
  const recognition = new FakeRecognition();
  const errors: string[] = [];
  let ended = 0;
  startDictation(
    { recognition },
    {
      onTranscript: () => {},
      onError: (message) => errors.push(message),
      onEnd: () => {
        ended += 1;
      },
    },
  );
  await tick();
  recognition.emitError("no-speech", "No speech detected");
  recognition.emitError("no-speech", "No speech detected");
  recognition.emitEnd();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no-speech/);
  assert.equal(ended, 1);
});

test("dictation end event: onEnd fires once, no error", async () => {
  const recognition = new FakeRecognition();
  const errors: string[] = [];
  let ended = 0;
  startDictation(
    { recognition },
    {
      onTranscript: () => {},
      onError: (message) => errors.push(message),
      onEnd: () => {
        ended += 1;
      },
    },
  );
  await tick();
  recognition.emitEnd();
  recognition.emitEnd();
  assert.deepEqual(errors, []);
  assert.equal(ended, 1);
});

test("dictation stop: removes listeners and stops the recognizer, no onEnd", async () => {
  const recognition = new FakeRecognition();
  const transcripts: string[] = [];
  let ended = 0;
  const handle = startDictation(
    { recognition },
    {
      onTranscript: (text) => transcripts.push(text),
      onError: () => {},
      onEnd: () => {
        ended += 1;
      },
    },
  );
  assert.ok(handle);
  await tick();
  handle.stop();
  assert.equal(recognition.stopped, true);
  recognition.emitResult(true, "too late");
  assert.deepEqual(transcripts, []);
  assert.equal(ended, 0);
});

test("read-aloud speaks the reply at rate 1 and reports done", () => {
  const speech = new FakeSpeech();
  let ended = 0;
  const errors: string[] = [];
  const handle = speakText({ speech }, "Hello, this is Charlie.", {
    onEnd: () => {
      ended += 1;
    },
    onError: (message) => errors.push(message),
  });
  assert.ok(handle);
  assert.equal(handle.provider, "local");
  assert.equal(speech.spoken.length, 1);
  assert.equal(speech.spoken[0].text, "Hello, this is Charlie.");
  assert.equal(speech.spoken[0].rate, 1);
  speech.emitDone();
  assert.equal(ended, 1);
  assert.deepEqual(errors, []);
});

test("read-aloud error: message passed through", () => {
  const speech = new FakeSpeech();
  const errors: string[] = [];
  speakText({ speech }, "Hello.", {
    onEnd: () => {},
    onError: (message) => errors.push(message),
  });
  speech.emitError("synthesis failed");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /synthesis failed/);
});

test("read-aloud with no speech module: returns null", () => {
  const handle = speakText({}, "Hello.", {
    onEnd: () => {
      throw new Error("must not be called");
    },
    onError: () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(handle, null);
});

test("read-aloud handle stop cancels speech; stopSpeaking tolerates no module", () => {
  const speech = new FakeSpeech();
  const handle = speakText({ speech }, "Hello.", {
    onEnd: () => {},
    onError: () => {},
  });
  assert.ok(handle);
  const stopsBefore = speech.stopCalls;
  handle.stop();
  assert.equal(speech.stopCalls, stopsBefore + 1);
  stopSpeaking({});
  stopSpeaking({ speech });
});

test("resolveNativeVoiceSupport: no native modules in node resolves all-false without throwing", async () => {
  __setNativeSpeechEnvForTests(null);
  try {
    const support = await resolveNativeVoiceSupport();
    assert.deepEqual(support, { dictation: false, readback: false });
  } finally {
    __setNativeSpeechEnvForTests(null);
  }
});

test("resolveNativeVoiceSupport: installed test env reports both available", async () => {
  const env: NativeSpeechEnv = { speech: new FakeSpeech(), recognition: new FakeRecognition() };
  __setNativeSpeechEnvForTests(env);
  try {
    assert.deepEqual(await resolveNativeVoiceSupport(), { dictation: true, readback: true });
    assert.equal(defaultSpeechEnv(), env);
  } finally {
    __setNativeSpeechEnvForTests(null);
  }
});

test("Azure available: dictation and read-aloud use Azure, local not invoked", async () => {
  const azure = new FakeAzure();
  const recognition = new FakeRecognition();
  const speech = new FakeSpeech();
  registerAzureVoiceProvider(azure);
  try {
    const dictation = startDictation(
      { recognition, speech },
      { onTranscript: () => {}, onError: () => {}, onEnd: () => {} },
    );
    assert.ok(dictation);
    assert.equal(dictation.provider, "azure");
    assert.equal(azure.dictationCalls, 1);
    assert.equal(recognition.started, false);
    assert.equal(getLastVoiceProvider(), "azure");

    const readback = speakText({ recognition, speech }, "Hello.", {
      onEnd: () => {},
      onError: () => {},
    });
    assert.ok(readback);
    assert.equal(readback.provider, "azure");
    assert.equal(azure.speakCalls, 1);
    assert.equal(speech.spoken.length, 0);
  } finally {
    registerAzureVoiceProvider(null);
  }
});

test("Azure unavailable: local voice is used", async () => {
  const azure = new FakeAzure();
  azure.available = false;
  const recognition = new FakeRecognition();
  registerAzureVoiceProvider(azure);
  try {
    const handle = startDictation(
      { recognition },
      { onTranscript: () => {}, onError: () => {}, onEnd: () => {} },
    );
    assert.ok(handle);
    assert.equal(handle.provider, "local");
    assert.equal(azure.dictationCalls, 0);
    await tick();
    assert.equal(recognition.started, true);
    assert.equal(getLastVoiceProvider(), "local");
  } finally {
    registerAzureVoiceProvider(null);
  }
});

test("Azure returns null: local voice is used as fallback", async () => {
  const azure = new FakeAzure();
  azure.returnNull = true;
  const recognition = new FakeRecognition();
  registerAzureVoiceProvider(azure);
  try {
    const handle = startDictation(
      { recognition },
      { onTranscript: () => {}, onError: () => {}, onEnd: () => {} },
    );
    assert.ok(handle);
    assert.equal(handle.provider, "local");
    assert.equal(azure.dictationCalls, 1);
    await tick();
    assert.equal(recognition.started, true);
    assert.equal(getLastVoiceProvider(), "local");
  } finally {
    registerAzureVoiceProvider(null);
  }
});

test("Azure speakText returns null: local voice is used as fallback", () => {
  const azure = new FakeAzure();
  azure.returnNull = true;
  const speech = new FakeSpeech();
  registerAzureVoiceProvider(azure);
  try {
    const handle = speakText({ speech }, "Hello.", {
      onEnd: () => {},
      onError: () => {},
    });
    assert.ok(handle);
    assert.equal(handle.provider, "local");
    assert.equal(azure.speakCalls, 1);
    assert.equal(speech.spoken.length, 1);
    assert.equal(getLastVoiceProvider(), "local");
  } finally {
    registerAzureVoiceProvider(null);
  }
});

test("stopSpeaking stops a registered Azure provider and local speech", () => {
  const azure = new FakeAzure();
  const speech = new FakeSpeech();
  registerAzureVoiceProvider(azure);
  try {
    stopSpeaking({ speech });
    assert.equal(azure.stopSpeakingCalls, 1);
    assert.equal(speech.stopCalls, 1);
  } finally {
    registerAzureVoiceProvider(null);
  }
});
