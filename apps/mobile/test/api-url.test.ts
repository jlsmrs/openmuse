// The API origin must be configured explicitly; there is no silent localhost
// default. The module itself throws at import when the variable is missing,
// so the tests import it with the variable set and exercise the resolver.
import assert from "node:assert/strict";
import test from "node:test";

process.env.EXPO_PUBLIC_API_URL = "https://api.example.test/";

test("resolveApiUrl returns the configured origin without a trailing slash", async () => {
  const { API_URL, resolveApiUrl } = await import("../src/api.ts");
  assert.equal(API_URL, "https://api.example.test");
  assert.equal(resolveApiUrl("https://api.example.test/"), "https://api.example.test");
  assert.equal(resolveApiUrl("http://10.0.2.2:8787"), "http://10.0.2.2:8787");
});

test("resolveApiUrl fails fast with a clear error when nothing is configured", async () => {
  const { resolveApiUrl } = await import("../src/api.ts");
  assert.throws(() => resolveApiUrl(undefined), /EXPO_PUBLIC_API_URL is not configured/);
  assert.throws(() => resolveApiUrl(""), /EXPO_PUBLIC_API_URL is not configured/);
});
