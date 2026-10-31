// Built-in PDF full-text extraction for read_workspace_file, so PDFs are
// readable in chat without relying on the Foundry analyze_document
// configuration. Uses pdf.js (pdfjs-dist) in-process — no new service, no
// key, no native code. Text extraction only: nothing is rendered.
//
// Limits mirror the existing PDF inspection: files are already capped at
// 10 MB on import, and extraction reads at most 500 pages (the same cap
// inspectPdf uses). If extraction fails for any reason, the caller falls
// back to the old metadata reply (page count + fields + the
// analyze_document note) instead of inventing text.

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export const PDF_MAX_PAGES = 500;

export type PdfTextExtraction =
  | { ok: true; text: string; pageCount: number; truncatedPages: boolean }
  | { ok: false; error: string };

export async function extractPdfText(bytes: Uint8Array): Promise<PdfTextExtraction> {
  try {
    const loading = pdfjs.getDocument({ data: bytes });
    const doc = await loading.promise;
    const pageCount = doc.numPages;
    const pagesToRead = Math.min(pageCount, PDF_MAX_PAGES);
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        pageText += item.str;
        if (item.hasEOL) pageText += "\n";
      }
      pages.push(pageText);
    }
    return {
      ok: true,
      text: pages.join("\n\n"),
      pageCount,
      truncatedPages: pageCount > pagesToRead,
    };
  } catch {
    return { ok: false, error: "This PDF could not be read as text." };
  }
}
