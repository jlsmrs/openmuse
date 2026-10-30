// Text extraction for office documents, used by read_workspace_file so Charlie
// can read attached documents in chat. Extraction is best-effort and honest:
// when a format cannot be extracted, the caller reports that plainly instead
// of inventing contents. Binary legacy Office formats (.doc, .xls, .ppt) are
// not extracted — only the modern XML formats below.
import JSZip from "jszip";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

export type DocumentExtraction = { ok: true; text: string } | { ok: false; error: string };

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export function isExtractableDocumentMime(mime: string): boolean {
  return mime === DOCX_MIME || mime === XLSX_MIME || mime === PPTX_MIME;
}

/** Plain-language note for a document format extraction cannot read. */
export function documentExtractionNote(mime: string): string {
  if (
    mime === "application/msword" ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.ms-powerpoint"
  )
    return "legacy binary Office format — text extraction is not available in chat";
  return "stored but not readable as text in chat";
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

async function extractDocx(bytes: Uint8Array): Promise<DocumentExtraction> {
  try {
    const result = await mammoth.extractRawText({ buffer: toBuffer(bytes) });
    return { ok: true, text: result.value };
  } catch {
    return { ok: false, error: "This Word document could not be read as text." };
  }
}

async function extractXlsx(bytes: Uint8Array): Promise<DocumentExtraction> {
  try {
    const workbook = XLSX.read(toBuffer(bytes), { type: "buffer" });
    const sections: string[] = [];
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet);
      sections.push(`Sheet: ${name}\n${csv}`);
    }
    return { ok: true, text: sections.join("\n\n") };
  } catch {
    return { ok: false, error: "This spreadsheet could not be read as text." };
  }
}

async function extractPptx(bytes: Uint8Array): Promise<DocumentExtraction> {
  try {
    const zip = await JSZip.loadAsync(toBuffer(bytes));
    const slides: string[] = [];
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const na = Number(/slide(\d+)\.xml/.exec(a)?.[1] ?? 0);
        const nb = Number(/slide(\d+)\.xml/.exec(b)?.[1] ?? 0);
        return na - nb;
      });
    for (const name of slideNames) {
      const xml = await zip.files[name]?.async("string");
      if (xml === undefined) continue;
      const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
      slides.push(`Slide: ${runs.join(" ")}`);
    }
    if (!slides.length) return { ok: false, error: "This presentation has no readable text." };
    return { ok: true, text: slides.join("\n\n") };
  } catch {
    return { ok: false, error: "This presentation could not be read as text." };
  }
}

export async function extractDocumentText(
  bytes: Uint8Array,
  mimeType: string,
): Promise<DocumentExtraction> {
  if (mimeType === DOCX_MIME) return extractDocx(bytes);
  if (mimeType === XLSX_MIME) return extractXlsx(bytes);
  if (mimeType === PPTX_MIME) return extractPptx(bytes);
  return { ok: false, error: documentExtractionNote(mimeType) };
}
