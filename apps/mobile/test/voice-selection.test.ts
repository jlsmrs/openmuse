// Voice provider selection (R8): Azure persona voice is PRIMARY and the
// on-device voice is the fallback. The Azure provider does not exist
// yet — these tests pin the selection rules so the Azure build plugs in
// without reworking the local path.
import assert from "node:assert/strict";
import test from "node:test";
import {
  type AzureVoiceProvider,
  getAzureVoiceProvider,
  getLastSelectedVoiceProvider,
  registerAzureVoiceProvider,
  selectVoiceProvider,
} from "../src/voice-selection.ts";

function fakeAzure(available: boolean): AzureVoiceProvider {
  return {
    isAvailable: () => available,
    startDictation: () => null,
    speakText: () => null,
    stopSpeaking: () => {},
  };
}

test("no provider registered: local is selected and recorded", () => {
  registerAzureVoiceProvider(null);
  assert.equal(selectVoiceProvider(), "local");
  assert.equal(getLastSelectedVoiceProvider(), "local");
  assert.equal(getAzureVoiceProvider(), null);
});

test("registered and available Azure provider: azure is selected", () => {
  const provider = fakeAzure(true);
  registerAzureVoiceProvider(provider);
  try {
    assert.equal(selectVoiceProvider(), "azure");
    assert.equal(getLastSelectedVoiceProvider(), "azure");
    assert.equal(getAzureVoiceProvider(), provider);
  } finally {
    registerAzureVoiceProvider(null);
  }
});

test("registered but unavailable Azure provider: local is selected", () => {
  registerAzureVoiceProvider(fakeAzure(false));
  try {
    assert.equal(selectVoiceProvider(), "local");
    assert.equal(getLastSelectedVoiceProvider(), "local");
  } finally {
    registerAzureVoiceProvider(null);
  }
});

test("provider whose availability check throws: local is selected, no throw", () => {
  registerAzureVoiceProvider({
    isAvailable: () => {
      throw new Error("boom");
    },
    startDictation: () => null,
    speakText: () => null,
    stopSpeaking: () => {},
  });
  try {
    assert.equal(selectVoiceProvider(), "local");
    assert.equal(getLastSelectedVoiceProvider(), "local");
  } finally {
    registerAzureVoiceProvider(null);
  }
});

test("registering null clears the provider", () => {
  registerAzureVoiceProvider(fakeAzure(true));
  assert.equal(selectVoiceProvider(), "azure");
  registerAzureVoiceProvider(null);
  assert.equal(selectVoiceProvider(), "local");
  assert.equal(getAzureVoiceProvider(), null);
});
