// Azure Document Intelligence receipt tool: every analysed document is
// returned (not just the first), and the poll loop is bounded by an overall
// deadline that returns the operation URL for resume.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  captureReceiptTool,
  pollReceiptOperation,
  RECEIPT_POLL_DEADLINE_MS,
} from "../apps/server/src/engine/azure-receipt.ts";

const files = {
  get: async () => ({ name: "receipt.jpg" }),
  bytes: async () => Buffer.from("fake-image-bytes"),
} as never;

function stubFetch(t: TestContext, handler: (url: string) => Promise<Response>): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string) => handler(url)) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
}

function setEnv(t: TestContext): void {
  const previous = {
    DOCINTEL_ENDPOINT: process.env.DOCINTEL_ENDPOINT,
    DOCINTEL_KEY: process.env.DOCINTEL_KEY,
  };
  process.env.DOCINTEL_ENDPOINT = "https://example.invalid";
  process.env.DOCINTEL_KEY = "test-key";
  t.after(() => {
    if (previous.DOCINTEL_ENDPOINT === undefined) delete process.env.DOCINTEL_ENDPOINT;
    else process.env.DOCINTEL_ENDPOINT = previous.DOCINTEL_ENDPOINT;
    if (previous.DOCINTEL_KEY === undefined) delete process.env.DOCINTEL_KEY;
    else process.env.DOCINTEL_KEY = previous.DOCINTEL_KEY;
  });
}

function receiptDocument(merchant: string, total: number): Record<string, unknown> {
  return {
    fields: {
      MerchantName: { value: merchant },
      TransactionDate: { value: "2026-11-13" },
      Total: { value: total },
      TotalTax: { value: 1 },
      Items: {
        valueArray: [
          { valueObject: { Description: { value: "item" }, TotalPrice: { value: total } } },
        ],
      },
    },
  };
}

test("the poll returns every analysed document", async (t) => {
  stubFetch(t, async () =>
    Response.json(
      {
        status: "succeeded",
        analyzeResult: {
          documents: [receiptDocument("Shop A", 10), receiptDocument("Shop B", 20)],
        },
      },
      { status: 200 },
    ),
  );
  const result = await pollReceiptOperation("https://example.invalid/op", "key");
  assert.ok(result.ok);
  assert.ok(result.documents);
  assert.equal(result.documents.length, 2);
  assert.equal(result.documents[0]?.merchant, "Shop A");
  assert.equal(result.documents[0]?.total, 10);
  assert.equal(result.documents[1]?.merchant, "Shop B");
  assert.equal(result.documents[1]?.total, 20);
});

test("the poll gives up at the deadline and returns the operation URL", async (t) => {
  stubFetch(t, async () => Response.json({ status: "running" }, { status: 200 }));
  const result = await pollReceiptOperation("https://example.invalid/op", "key", 100);
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out after 0\.1 seconds/);
  assert.equal(result.operationUrl, "https://example.invalid/op");
  assert.equal(RECEIPT_POLL_DEADLINE_MS, 300_000);
});

type ReceiptResult = {
  draft?: boolean;
  file?: string;
  merchant?: unknown;
  total?: unknown;
  documents?: Array<{ merchant?: unknown; total?: unknown }>;
  note?: string;
  error?: string;
};

async function executeReceipt(fileId: string): Promise<ReceiptResult> {
  const tool = captureReceiptTool(files, "owner");
  assert.ok(tool.execute);
  return (await tool.execute({ fileId })) as ReceiptResult;
}

test("the tool returns all documents, with top-level fields from the first", async (t) => {
  setEnv(t);
  stubFetch(t, async (url) =>
    url.includes(":analyze")
      ? new Response("{}", {
          status: 202,
          headers: { "Operation-Location": "https://example.invalid/op" },
        })
      : Response.json(
          {
            status: "succeeded",
            analyzeResult: {
              documents: [receiptDocument("Shop A", 10), receiptDocument("Shop B", 20)],
            },
          },
          { status: 200 },
        ),
  );
  const result = await executeReceipt("f1");
  assert.equal(result.draft, true);
  assert.equal(result.merchant, "Shop A");
  assert.equal(result.total, 10);
  assert.ok(result.documents);
  assert.equal(result.documents.length, 2);
  assert.equal(result.documents[1]?.merchant, "Shop B");
  assert.match(result.note ?? "", /2 documents found/);
});
