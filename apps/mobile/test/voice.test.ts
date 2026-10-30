// Voice v1: browser speech recognition for input and device-voice readback
// for replies, web only. Helpers take an injected speech environment so they
// can be tested without a live microphone or browser.
import assert from "node:assert/strict";
import test from "node:test";
import {
  joinTranscript,
  type RecognitionConstructor,
  type RecognitionInstance,
  type RecognitionResultEvent,
  type SpeechEnv,
  type SynthesisInstance,
  speakText,
  startDictation,
  type UtteranceConstructor,
  type UtteranceInstance,
  voiceSupport,
} from "../src/voice.ts";

class FakeRecognition implements RecognitionInstance {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: RecognitionInstance["onresult"] = null;
  onerror: RecognitionInstance["onerror"] = null;
  onend: RecognitionInstance["onend"] = null;
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeUtterance implements UtteranceInstance {
  text: string;
  rate = 1;
  onend: UtteranceInstance["onend"] = null;
  onerror: UtteranceInstance["onerror"] = null;
  constructor(text: string) {
    this.text = text;
  }
}

class FakeSynthesis implements SynthesisInstance {
  spoken: UtteranceInstance[] = [];
  cancelled = 0;
  speak(utterance: UtteranceInstance): void {
    this.spoken.push(utterance);
  }
  cancel(): void {
    this.cancelled += 1;
  }
}

test("voice support is detected from the injected environment", () => {
  assert.deepEqual(voiceSupport({}), { dictation: false, readback: false });
  assert.deepEqual(
    voiceSupport({ SpeechRecognition: FakeRecognition as unknown as RecognitionConstructor }),
    { dictation: true, readback: false },
  );
  const synthesis = new FakeSynthesis();
  assert.deepEqual(
    voiceSupport({
      SpeechRecognition: FakeRecognition as unknown as RecognitionConstructor,
      speechSynthesis: synthesis,
      SpeechSynthesisUtterance: FakeUtterance as unknown as UtteranceConstructor,
    }),
    { dictation: true, readback: true },
  );
});

test("transcripts join every result alternative in order", () => {
  const event = {
    results: [
      { isFinal: true, 0: { transcript: "hello " }, length: 1 },
      { isFinal: false, 0: { transcript: "world" }, length: 1 },
    ],
  } as unknown as RecognitionResultEvent;
  assert.equal(joinTranscript(event), "hello world");
});

test("dictation streams transcripts, ends cleanly, and stop suppresses onEnd", () => {
  const holder: { current: FakeRecognition | null } = { current: null };
  class CapturingRecognition extends FakeRecognition {
    constructor() {
      super();
      holder.current = this;
    }
  }
  const env: SpeechEnv = {
    SpeechRecognition: CapturingRecognition as unknown as RecognitionConstructor,
  };
  const transcripts: string[] = [];
  let ended = 0;
  const errors: string[] = [];
  const handle = startDictation(env, {
    onTranscript: (text) => transcripts.push(text),
    onError: (message) => {
      errors.push(message);
    },
    onEnd: () => {
      ended += 1;
    },
  });
  assert.ok(handle);
  const created = holder.current;
  assert.ok(created);
  assert.equal(created.started, true);
  assert.equal(created.continuous, true);
  assert.equal(created.interimResults, true);
  created.onresult?.({
    results: [
      { isFinal: true, 0: { transcript: "hello " }, length: 1 },
      { isFinal: false, 0: { transcript: "world" }, length: 1 },
    ],
  } as unknown as RecognitionResultEvent);
  assert.deepEqual(transcripts, ["hello world"]);
  created.onend?.();
  assert.equal(ended, 1);
  assert.deepEqual(errors, []);

  const handle2 = startDictation(env, {
    onTranscript: () => {},
    onError: () => {},
    onEnd: () => {
      ended += 1;
    },
  });
  assert.ok(handle2);
  const created2 = holder.current;
  assert.ok(created2);
  handle2.stop();
  assert.equal(created2.stopped, true);
  created2.onend?.();
  assert.equal(ended, 1);
});

test("dictation reports recognition errors", () => {
  const holder: { current: FakeRecognition | null } = { current: null };
  class CapturingRecognition extends FakeRecognition {
    constructor() {
      super();
      holder.current = this;
    }
  }
  const errors: string[] = [];
  const handle = startDictation(
    { SpeechRecognition: CapturingRecognition as unknown as RecognitionConstructor },
    {
      onTranscript: () => {},
      onError: (message) => {
        errors.push(message);
      },
      onEnd: () => {},
    },
  );
  assert.ok(handle);
  const created = holder.current;
  assert.ok(created);
  created.onerror?.({ error: "no-speech" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no-speech/);
});

test("readback cancels prior speech, speaks the text, and stop cancels", () => {
  const synthesis = new FakeSynthesis();
  const env: SpeechEnv = {
    speechSynthesis: synthesis,
    SpeechSynthesisUtterance: FakeUtterance as unknown as UtteranceConstructor,
  };
  let ended = 0;
  const handle = speakText(env, "Hello Charlie", {
    onEnd: () => {
      ended += 1;
    },
    onError: () => {},
  });
  assert.ok(handle);
  assert.equal(synthesis.cancelled, 1);
  assert.equal(synthesis.spoken.length, 1);
  assert.equal(synthesis.spoken[0].text, "Hello Charlie");
  synthesis.spoken[0].onend?.();
  assert.equal(ended, 1);
  handle.stop();
  assert.equal(synthesis.cancelled, 2);
});

test("dictation and readback return null when unsupported", () => {
  assert.equal(
    startDictation({}, { onTranscript: () => {}, onError: () => {}, onEnd: () => {} }),
    null,
  );
  assert.equal(speakText({}, "hi", { onEnd: () => {}, onError: () => {} }), null);
});
