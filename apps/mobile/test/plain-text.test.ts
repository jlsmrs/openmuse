// Read-aloud speaks words, not Markdown syntax.
import assert from "node:assert/strict";
import test from "node:test";
import { stripMarkdown } from "../src/plain-text.ts";

test("stripMarkdown removes formatting markers but keeps the words", () => {
  assert.equal(stripMarkdown("# Hello **world**"), "Hello world");
  assert.equal(
    stripMarkdown("See [the docs](https://example.com) for *details*."),
    "See the docs for details.",
  );
  assert.equal(stripMarkdown("![A cat](https://example.com/cat.png) sat down."), "A cat sat down.");
  assert.equal(stripMarkdown("Run `pnpm install` first."), "Run pnpm install first.");
  assert.equal(stripMarkdown("~~struck~~ and __underlined__"), "struck and underlined");
});

test("stripMarkdown flattens structure into plain sentences", () => {
  assert.equal(
    stripMarkdown(
      "## Plan\n\n- First step\n- Second step\n\n> A quoted note\n\n```\ncode here\n```",
    ),
    "Plan\nFirst step\nSecond step\nA quoted note\ncode here",
  );
  assert.equal(stripMarkdown("1. One\n2. Two\n\n---\n\nDone."), "One\nTwo\nDone.");
  assert.equal(stripMarkdown("Hello <b>there</b>."), "Hello there.");
  assert.equal(stripMarkdown(""), "");
});
