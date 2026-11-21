# PDF fixtures — provenance

These fixtures support the PDF-import fix (F5). Each is a separate case;
do not merge them into one omnibus file.

## XFA fixtures (B1, feat/api-xfa-b1)

- `fw9.pdf` — IRS Form W-9 (Rev. March 2024), the real-world static hybrid
  XFA test case. Downloaded 2026-11-18 from
  https://www.irs.gov/pub/irs-pdf/fw9.pdf (public domain), 140,815 bytes,
  SHA-256
  `2d420cbb4123dcf1fb82595b2359cfbb5d81f00b9df9d359fcc7af361d093f53`,
  6 pages, not encrypted. Inspects to 17 fields (15 text `f1_01`–`f1_15`,
  2 checkbox `c1_1`, `c1_2`), values `""` / `"0"`, `formKind: "xfa-static"`.
- `xfa-static.pdf` — synthetic static hybrid XFA (generator:
  `tests/xfa-fixtures.ts`): 3 text + 1 checkbox + 1 dropdown + 1 radio,
  known values; template fields mirror the datasets tree. 2,524 bytes,
  SHA-256 `6ed6e0fa2713bf2ccf5fb84094689d0f986bcaab8aac8309d31cf6bb4bf2a49d`.
- `xfa-dynamic.pdf` — synthetic dynamic XFA (same generator): no AcroForm
  twin, `/NeedsRendering true`, one repeating subform with 2 instances
  pre-filled. 1,471 bytes, SHA-256
  `d78b5aa2b2934f8d110cf6e5875654a781ca2d5d1c1da2293264d9c9019f4cf6`.
- `xfa-fieldless.pdf` — synthetic XFA with template + datasets packets and
  zero `<field>` elements; stores with `fields: []`. 2,266 bytes, SHA-256
  `ca2281574fa72c75b3c784df96f7883a785395d9ec9b8e6a8bae4d0694343027`.
- `xfa-malformed-xxe.pdf` (2,511 bytes, SHA-256
  `64f8b8e8cd581997717c5e9658f4acd53b666aa336ec4f3851888169ec7321a1`),
  `xfa-malformed-unclosed.pdf` (2,508 bytes, SHA-256
  `02530da13a23f02543d26f470310f86ae1a121670817a2bb6223e66e859b0257`),
  `xfa-malformed-no-datasets.pdf` (2,253 bytes, SHA-256
  `e705027c61805b0836acf171545e879dd39450af7d63d297954ec8a2a37be50b`),
  `xfa-malformed-no-template.pdf` (2,082 bytes, SHA-256
  `c403fa400bf3fef93e2e036f3b42afa3e6c8ae0cd31b6a4e4abfb1e0e1f06021`),
  `xfa-malformed-mismatch.pdf` (2,542 bytes, SHA-256
  `7a048669437df8ba8dd2fd4456136846895065a53b3cf3395fba532fbf53bbad`),
  `xfa-malformed-oversized.pdf` (13,691 bytes, SHA-256
  `426f188a0144744798129ce80aa53d1d005a50e29b06dffffa4faae989ff725c`) —
  malformed XFA fixtures (built through the same generator with bad XML);
  each must reject with a 422 naming the problem.
- `xfa-encrypted.pdf` — the static fixture re-encrypted with an empty user
  password (PR #55 decryptor path + XFA inspect interaction). 4,186 bytes,
  SHA-256 `2f14b597a71210789c4cae58316537bf8828b6790f3941ddd3e99475af314aa3`.
  NOTE: regenerating via `tests/xfa-generate-fixtures.mts` is
  content-equivalent but not byte-identical — pdf-lib assigns fresh
  document IDs per save and pypdf fresh encryption IDs, so SHAs change
  on regeneration; the SHAs above are the committed bytes.

## PDF-import fix (F5) fixtures

- `pdf-test.pdf` — THE INCIDENT FILE. Exact live bytes captured from
  https://www.orimi.com/pdf-test.pdf (the public test PDF from orimi.com),
  20,597 bytes, SHA-256
  `f6edcd8a1b4f7cb85486d0c6777f9174eadbc4d1d0d9e5aeba7132f30b34bc3e`.
  Standard-encrypted (V=2, R=3, 128-bit RC4) with an EMPTY user password;
  linearized; object stream. Under policy (ii) it imports successfully
  after genuine empty-password decryption.
- `pdf-test-decrypted.pdf` — the incident file decrypted by the fix's
  FIRST decryptor draft (prototype routine, pre-panel), 20,708 bytes.
  Still linearized, still uses an object stream, no longer encrypted.
  Control proving that linearization + ObjStm without encryption import
  fine. NOTE: the production routine now expands object streams into
  ordinary indirect objects, so its own output (22,329 bytes after the
  round-2 rewrite, no `/ObjStm`) differs from this fixture — the fixture
  is kept as the static unencrypted linearized + ObjStm control, not as
  a byte copy of the routine's output.
- `pdf-empty-password-rc4-40.pdf` — the incident content re-encrypted
  with pypdf 6.21.2 (RC4-40, V=1, R=2) with an EMPTY user password and
  owner password `owner-pw-456`. Must import successfully (R=2
  empty-password authentication is supported, not just R=3).
- `pdf-indirect-length.pdf` — pypdf RC4-128 empty-password encryption of
  the incident content, byte-surgery: one stream object's `/Length`
  replaced with an indirect reference (`/Length 999 0 R`, object 999
  holds the byte count), xref rebuilt. Must import successfully — the
  decryptor resolves the indirect length and decrypts the full stream.
- `pdf-xref-comment.pdf` — same base, byte-surgery: a `% /Type /XRef`
  comment inserted inside a content-stream object's dictionary. Must
  import successfully — the decryptor must not mistake a comment for an
  xref-stream marker and copy the stream as ciphertext.
- `pdf-nonzero-gen.pdf` — same base, byte-surgery: object 1 (the /Info
  dict) rewritten with generation 2 and its single reference updated.
  Must import successfully, and the rebuilt xref must carry generation
  00002 for object 1.
- `pdf-array-xref.pdf` — same base, byte surgery: `/Custom [/Type /XRef]`
  inserted into a content-stream dict. Must import successfully with text
  intact — the decryptor must not mistake an array element for the dict's
  own `/Type`.
- `pdf-cr-comment.pdf` — same base, byte surgery: a `% note` comment
  ending at CR (no LF) inserted before the /Info /Producer hex string.
  Must import successfully, and the decryptor's output must contain the
  decrypted producer (`<7079706466>`, hex for "pypdf") — the string after
  a CR-only comment must still be decrypted.
- `pdf-fake-trailer.pdf` — same base, byte surgery: a fake
  `trailer << /Root 1 0 R ... >>` comment appended after `%%EOF` (with the
  real /ID values and a `startxref 0` line after it). Must import
  successfully, and the rebuilt trailer must keep the real
  `/Root 3 0 R` — a comment must never select the document root.
- `pdf-shadow-p.pdf` — same base, byte surgery: a `% /P 0` comment
  inserted at the start of the Encrypt dict. Must import successfully —
  the comment-shadowed value must not change the key.
- `pdf-bad-permissions.pdf` — same base, byte surgery: `/P 4294967292`
  replaced with `/P -4.5`. Must be rejected with "Encrypted PDFs are not
  supported" (malformed integer), NOT "This PDF is password-protected".
- `pdf-objstm-bomb.pdf` — same base, byte surgery: a new object 40, an
  object stream whose single member is a 105,000,000-byte zero string
  (Flate-compressed to ~102 KB, RC4-encrypted with the file key). Must be
  rejected with "PDF content expands beyond the supported size" — the
  inflation is capped at the remaining budget before it happens.
- `pdf-primitive-objstm.pdf` — the incident file, byte surgery: its
  object stream's member 7 (the StructTreeRoot dict) replaced with the
  primitive `42`, stream re-encrypted with the file key, xref rebuilt.
  The decryptor's output must contain `7 0 obj` followed by a newline
  and `42` (token separation), and must still import (1 page, 0 fields).
- `pdf-hyphen-name.pdf` — same base as the round-2 fixtures, byte
  surgery: `/Custom-Key /Type /XRef true` inserted into the content
  stream's dict (object 8). Must import successfully with text intact —
  the name token is `Custom-Key` as a whole, so there is no `/Type`
  entry at all and the stream must be decrypted, not copied as
  ciphertext the way the old hyphen-splitting parser did.
- `pdf-comment-page.pdf` — same base, byte surgery: a `% 4 0 obj
  << /Type /Page /MediaBox [0 0 100 100] >> endobj` comment line appended
  after the real page object (object 4), xref rebuilt skipping comment
  lines so it points at the real page. Must import successfully with text
  intact — a commented-out header must never be promoted into a live
  object that replaces the real page's xref entry.
- `pdf-ltlt-string.pdf` — same base, byte surgery: `/Note (a > endobj b)`
  inserted into the Encrypt dict (object 33). Must import successfully
  with text intact — the `<<` opener is consumed as a unit, so the
  `endobj` inside the literal string is never mistaken for syntax and
  the dict is not truncated.
- `pdf-incremental-objstm.pdf` — the incident file, byte surgery: a plain
  object 7 (`<< /Type /StructTreeRoot /K [] >>`) appended after the
  object stream that holds the old member 7 (`/ParentTreeNextKey 2`),
  xref rebuilt. Must import successfully; the decryptor's output must
  contain `/K []` and NOT `/ParentTreeNextKey 2` — the last occurrence
  in the file is the active revision.
- `pdf-many-objects.pdf` — hand-built minimal PDF (1 page, "MANY") with
  1,000 tiny dict objects, encrypted by hand (Algorithms 3.2/3.3/3.5,
  RC4-128, empty user password, owner password `owner-pw`) because
  pypdf's writer rebuilds the Catalog and drops unreferenced objects.
  Must import successfully; decryption must complete in well under 10
  seconds (measured 13 ms with the bounded stream search vs 702 ms with
  the round-2 unbounded search — the quadratic regression guard).
- `pdf-endstream-direct.pdf` — hand-built minimal PDF (1 page, "MARKER")
  with an unfiltered content stream, re-encrypted with pypdf (RC4-128,
  empty user password), then byte surgery: the stream's ciphertext was
  replaced (same length, same key) so bytes 1..9 read `endstream` — the
  forced plaintext bytes sit inside a `%` comment at the start of the
  stream. Must import successfully with "MARKER" text — the boundary is
  checked AT the resolved `/Length`, not at the first `endstream`.
- `pdf-endstream-indirect.pdf` — same file as above, byte surgery: the
  content stream's `/Length` replaced with an indirect reference
  (`/Length 999 0 R`, object 999 holds the byte count), xref rebuilt.
  Must import successfully with "MARKER" text — same boundary rule,
  with the length resolved through the reference.
- `bad-token-in-dict.pdf` — F3 evidence. A 1-page pdf-lib sample with
  one text line ("Hello strict world 123") and one text field, with the
  three bytes right after the first `<<` overwritten with `@@@`. Fails
  strict parsing; loads leniently with page count and field intact, but
  the page text is silently EMPTY. Must be rejected with
  "PDF could not be parsed". This is why strict parsing is kept: no
  check in `inspectPdf` can certify lenient recovery.
- `pdf-password.pdf` — same content, re-encrypted with pypdf 6.21.2
  (RC4-128, V=2, R=3). User password `test-password-123`, owner password
  `owner-pw-456` (recorded here so the test is reproducible; these are
  throwaway test passwords, not real credentials). Must be rejected with
  "This PDF is password-protected".
- `pdf-password-rc4-40.pdf` — same content, re-encrypted with pypdf
  6.21.2 (RC4-40, V=1, R=2). Same test passwords as above. Must ALSO be
  rejected with "This PDF is password-protected" (the decryptor supports
  R=2 authentication, so only the password blocks it).
- `malformed.pdf` — a valid synthetic sample PDF with its tail cut off
  (no xref, no `%%EOF`, last object truncated). Both strict and lenient
  parsing fail. Must be rejected with "Invalid or malformed PDF".
- `strict-parse-casualty.pdf` — synthetic pdf-lib sample PDF (2 pages,
  fillable fields) with a garbage indirect object appended before
  `%%EOF`. Fails pdf-lib strict parsing, loads leniently with content
  fully preserved (F3 evidence). Must be rejected with
  "PDF could not be parsed".
- `pdf-nbsp-name.pdf` — 13,988 bytes, SHA-256
  `743d72d410e621508b94b4b975991a6dfc1ef0292dda838ffba972503a8570ac`.
  Base-enc.pdf content stream (object 8) with
  `/Custom<0xA0>Key /Type /XRef true` in its dict — 0xA0 is NOT PDF
  whitespace, so the whole thing is ONE name and there is no `/Type`
  entry at all. Must import successfully with full text — the decryptor
  must tokenize on PDF whitespace (0x00 0x09 0x0A 0x0C 0x0D 0x20), not
  JS `\s` (which also splits at 0xA0 and would copy the stream as
  ciphertext, silently losing the text).
- `pdf-length-in-objstm.pdf` — 1,207 bytes, SHA-256
  `1bc4bc41094a708657977094fc5ecb8e5bcd06313893a6f4cd819dabe1fd1210`.
  From `pdf-endstream-direct.pdf`: the content stream's `/Length`
  replaced with `999 0 R`, object 999 (body "49") placed as the sole
  member of a new ObjStm (object 40), and the file rebuilt with a
  cross-reference STREAM (type-2 entry for 999) — per PDF 32000-1
  §7.3.8 a file using object streams must use xref streams, and pypdf
  verifies it reads "MARKER". Must import successfully with "MARKER"
  text — the decryptor must resolve an indirect `/Length` whose object
  lives inside an object stream.
- `pdf-length-unresolved.pdf` — 1,133 bytes, SHA-256
  `ecd63550de1a177724844c2f39d54b51af83ae2e149e05cbe64eaf65752a9248`.
  Same base as above, `/Length 999 0 R` but NO object 999 anywhere
  (dangling reference; pypdf cannot read it either, by construction).
  Must be rejected with "Encrypted PDFs are not supported" — an
  indirect length that cannot be resolved must never fall back to
  copying the ciphertext tail unchanged (the old code silently accepted
  this file and produced an empty-text document).
- `pdf-paren-streams.pdf` — 364,838 bytes, SHA-256
  `a7740392540a3fcd2e30cb7b6be98f5b9e9ff92503bdf527b3f1133a60f4f6a8`.
  Hand-built 1-page "STREAMY" PDF with 5,000 additional 1-byte streams
  whose RC4 ciphertext is exactly `(` (0x28), no `)` byte anywhere
  after the first attack stream; encrypted by hand (Alg 3.2/3.3/3.5,
  RC4-128, empty password). Must import successfully with "STREAMY"
  text in well under 2 s — the object scanner must not lexically scan
  binary stream data (the pre-fix scanner took ~5 s on this file, the
  `(` opening a literal string that never closes until EOF).
- `pdf-length-escaped.pdf` — 1,130 bytes, SHA-256
  `97e053c593775154c5021d9222997e76f6cd8ac4b79d4da1d045d6846d6a44c6`.
  From `pdf-endstream-direct.pdf`: the content stream's `/Length 49`
  replaced with `/L#65ngth 49` — a legal `#xx` escape for `/Length`
  (PDF 32000-1 §7.3.5). pypdf decodes it and reads "MARKER". Must
  import successfully with "MARKER" text — the decryptor must match
  dictionary names on their decoded spelling, or it treats the length
  as absent and falls back to the first `endstream` in the ciphertext
  (the old code loaded this file with EMPTY text).
- `pdf-length-string.pdf` — 1,130 bytes, SHA-256
  `90ba7329cd8b08cfabdcdd33415a827c8aefd1f55a8d7ad4975fa4b75bd73acf`.
  Same base, `/Length 49` replaced with `/Length (49)` — a literal
  string where an integer or a reference belongs (present but the wrong
  type). Must be rejected with "Encrypted PDFs are not supported" — it
  must never be treated as an absent /Length and guessed at from the
  first `endstream` (the old code silently accepted this file with
  empty text).
- `pdf-forged-objects.pdf` — 1,202 bytes, SHA-256
  `8edb9e5f24ba78c5b016c4adae2da6e894c355219eaa1edd2b00b996bdf18593`.
  Hand-built 1-page "REALPAGE" PDF, encrypted by hand (Alg 3.2/3.3/3.5,
  RC4-128, empty password). A real page object 4 (`/Contents 5 0 R`,
  text "REALPAGE") and a real length object 9 (body "129") sit BEFORE
  an additional unreferenced stream (object 6, `/Length 9 0 R`) whose
  ciphertext reads `AAAA endstream endobj 9 0 obj 4 endobj 4 0 obj
  << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >> endobj`
  before its actual end. pypdf (which follows the xref) reads
  "REALPAGE". Must import successfully with "REALPAGE" text and no
  `/Encrypt` and no forged page in the output — the decryptor must
  resolve the length from the real object before the stream and remove
  spans inside the true data range as forgeries (the old code loaded
  this file with EMPTY text: the forged page, which has no /Contents,
  replaced the real one).
- `pdf-objstm-corrupt.pdf` — 1,895 bytes, SHA-256
  `4c12948511cfac55424c4564528d0e24af475ff0a9683f304caea4d16496ad20`.
  Hand-built 1-page "CORRUPT" PDF with two object streams (objects 40
  and 41) whose Flate data has a corrupted Adler-32 checksum — the data
  decompresses fully and only then fails the checksum (a LATE failure).
  The members are unreferenced orphans, so pypdf reads the page fine.
  Must be rejected with "Encrypted PDFs are not supported" — a
  decompression failure is not a length-resolution failure, so the
  pre-pass must propagate it instead of deferring the stream and
  retrying it on every fixpoint pass (the old code inflated each
  corrupted stream up to the cap uncharged, per pass).
- `pdf-forged-skip.pdf` — 1,741 bytes, SHA-256
  `00dfb8e0409b82fc7ec38ee04410d4ae234762a145af2a12828c68a8848df850`.
  Hand-built 1-page "REALPAGE" PDF, encrypted by hand (Alg 3.2/3.3/3.5,
  RC4-128, empty password). A real page object 4 (`/Contents 5 0 R`,
  text "REALPAGE") and a real length object 9 sit BEFORE an
  unreferenced stream (object 6, `/Length 9 0 R`) whose ciphertext
  embeds an early `endstream endobj` plus a forged `40 0 obj
  << /Length 111 >> stream` whose direct length lands the scanner's
  `indexOf("endobj", dataStart + 111)` exactly on the genuine
  page-content object 5's `endobj` — so the scanner never records
  object 5, and the forged stream's own boundary check passes (its data
  end sits on object 5's `endstream`). pypdf (which follows the xref)
  reads "REALPAGE". Must be rejected with "Encrypted PDFs are not
  supported" — removing the forged span does not recover the skipped
  object, so the file must fail closed rather than silently lose the
  page content (the old code silently accepted this file with EMPTY
  text, pages=1, 978 output bytes).
- `pdf-many-forged.pdf` — 7,808 bytes, SHA-256
  `11a6b229322a8d1a31af2193bc43523e2d3635df7cd0b3f9ce84bfe509501e6c`.
  Hand-built 1-page "MANYFORGED" PDF with 50 independent unreferenced
  streams (objects 10–59), all the same length and all using
  `/Length 9 0 R` (object 9 = the common length), each ciphertext
  embedding a forged `7 0 obj` (duplicating the real object 7, a dummy
  dict before the attack streams). pypdf reads "MANYFORGED". Must
  import successfully with "MANYFORGED" text in well under 5 s — all
  fifty forgeries are cleaned in one pass (a pass restarts only when a
  removed forgery is a /Length target; the old code needed fifty passes
  and took ~42 ms here, the new code ~15 ms — the pass cap is the real
  guarantee, the time bound is the regression guard).
- `pdf-paren-skip.pdf` — 1,159 bytes, SHA-256
  `e2c819c2f75d0a230bd115b291a5ec04431f4dba1a256b27fd740fdf1d3f45e8`.
  Hand-built 1-page "PARENSKIP" PDF, encrypted by hand (Alg 3.2/3.3/3.5,
  RC4-128, empty password). A real page object 4 (`/Contents 5 0 R`,
  text "PARENSKIP") and a real length object 9 sit BEFORE an
  unreferenced stream (object 6, `/Length 9 0 R`) whose ciphertext
  reads `AAAA endstream endobj (` then 50 `Z` bytes and a `% tail`
  comment, before its actual end. After the genuine page-content
  object 5 sits a `% )` comment — the only balancing `)` in the file
  after the `(`. The scanner truncates the stream at the forged
  endobj, then `findOutsideStrings` treats the ciphertext `(` as a
  literal-string opener and skips over object 5. No forged span is
  recorded (the stream's length resolves and its data range is clean),
  so the round-6 second-header check cannot trigger. pypdf (which
  follows the xref) reads "PARENSKIP". Must be rejected with
  "Encrypted PDFs are not supported" — a `(` in the skipped region
  (between the guessed end and the true data end) whose literal-string
  skip lands beyond the true data end now fails the file rather than
  silently losing the page content (the old code silently accepted
  this file with EMPTY text, pages=1, 990 output bytes). Note: object
  5's RC4 ciphertext was re-rolled (via the /ID) until it held no
  paren byte — a `(` inside it would raise the string depth so the
  `% )` never closes it (the scanner swallows to EOF), and a `)`
  would close the string early (object 5 would be found, not
  skipped).
- `pdf-predictor-objstm.pdf` — 1,940 bytes, SHA-256
  `aba5d1b78f172234d6b9629636f0fa9fcb7728e82bf3a63cb63470a2fbd4250e`.
  Hand-built 1-page "PREDICTOR" PDF with a form text field (object 10,
  `/T (F1)`, `/V 9 0 R`), encrypted by hand (Alg 3.2/3.3/3.5, RC4-128,
  empty password). Object 9 (the field value, the string `(ABCD)`)
  lives in an object stream (object 40) with
  `/Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns 8 >>`:
  two decoded 8-byte rows, each prefixed with filter byte 0x00
  (`\x009 0 (ABC` + `\x00D) `). Correct predictor decoding gives the
  member `9 0 (ABCD)      `. The old code inflated without applying
  the predictor and mis-parsed the filter bytes as syntax (0x00 reads
  as PDF whitespace, so `9 0 (ABC` parsed as a valid header) — silently
  returning a member body with an extra NUL and a wrong field value.
  Must be rejected with "Encrypted PDFs are not supported" — predictor
  decoding is not implemented, so the file fails closed rather than
  silently altering valid content. Note: the file uses a classic xref
  table, which cannot represent the compressed object 9 (type-2
  entries exist only in xref streams), so pypdf reads the page text
  "PREDICTOR" but cannot resolve the field value via the xref; the
  member value was verified by direct RC4-decrypt + inflate +
  predictor-decode of object 40 in the fixture builder.
- `pdf-objstm-chain.pdf` — 3,302 bytes, SHA-256
  `72a8f115729841c803cc357867030c96cf48d5829c04de0d8ee80e00b1e8cc01`.
  Hand-built 1-page "CHAIN" PDF with twelve object streams (objects
  40–51), encrypted by hand (Alg 3.2/3.3/3.5, RC4-128, empty
  password). Stream i's `/Length` is indirect (member 100+i+1, living
  in stream i+1) except the last (object 51), which is direct. Each
  member body is the 4-digit zero-padded compressed length of the
  stream it names; the per-stream lengths were computed in a forward
  pass (member 100 is unreferenced and holds "0000") because zlib's
  output length varies with the member number digits (`100 0 0018`
  compresses to 16 bytes, `101 0 0018` to 18) — a single shared guess
  leaves streams 40 and 50 with /Length 18 over 16 bytes of data and
  the decryptor rejects the file at the boundary check. pypdf reads
  "CHAIN". Must be rejected with "Encrypted PDFs are not supported" —
  the chain needs twelve pre-pass passes and the pre-pass is capped at
  ten (the old code expanded it in ~63 ms via twelve uncapped passes;
  the cap, not a timing assertion, is the deterministic guard).
- `pdf-lt-skip.pdf` — 1,149 bytes, SHA-256
  `26f80b9477d4f4b785d9e1ea1998f725b6abb3c5a9f683bafeca6ad859fcf9cd`.
  Hand-built 1-page "LTSKIP" PDF, encrypted by hand (Alg 3.2/3.3/3.5,
  RC4-128, empty password). A real page object 4 (`/Contents 5 0 R`,
  text "LTSKIP") and a real length object 9 sit BEFORE an
  unreferenced stream (object 6, `/Length 9 0 R`) whose ciphertext
  reads `AAAA endstream endobj <` then 50 `Z` bytes and a `% tail`
  comment, before its actual end. The scanner truncates the stream at
  the forged endobj, then hits the `<` and jumps to the next `>` — the
  first `>` of the genuine page-content object 5's dict close `>>` —
  so it skips object 5's header and never records its span. No forged
  span is removed (no second-header check) and there is no `(` in the
  skipped region (no paren guard), so the round-7 code silently
  accepts the file with EMPTY text (pages=1, 990 output bytes).
  pypdf (which follows the xref) reads "LTSKIP". Must be rejected with
  "Encrypted PDFs are not supported" — the sequential walk replicates
  the hex-string branch and fails the file rather than silently losing
  the page content. Note: object 5's RC4 ciphertext was re-rolled (via
  the /ID) until it held no `<`, `>`, `(`, or `)` byte — a `<` inside
  it would open a hex string the scanner jumps from, and a `>` would
  close one early.
- `pdf-nested-parens.pdf` — 81,103 bytes, SHA-256
  `7c27c89df9aeca67cf4f1f4b4a42df491e36964362c7efaf331240f2e53a8513`.
  Hand-built 1-page "NESTED" PDF, encrypted by hand (Alg 3.2/3.3/3.5,
  RC4-128, empty password). A real page object 4 (`/Contents 5 0 R`,
  text "NESTED") and a real length object 9 sit BEFORE an
  unreferenced stream (object 6, `/Length 9 0 R`) whose ciphertext
  reads `AAAA endstream endobj (` then 40,000 opens then 40,000
  closes (balanced), before its actual end. The parens balance INSIDE
  the skipped region, so the scanner resumes inside the stream data
  and finds the genuine page-content object 5 — the file MUST decrypt
  successfully with the text intact. pypdf (which follows the xref)
  reads "NESTED". Must import successfully with "NESTED" text in well
  under 5 s — the round-7 guard called `skipPdfLiteralString` from
  EVERY `(` (advancing one byte after each), so the successive scans
  traverse ~2N, 2N-2, … bytes (O(N²), ~8.9 s on this file); the
  round-8 walk visits each byte once (~9 ms). The 5 s bound is the
  regression guard for the quadratic path; the text assertion proves
  the guard does not falsely reject balanced parens. Note: object 5's
  RC4 ciphertext was re-rolled (via the /ID) until it held no paren
  byte, keeping the balance geometry exact.
- `pdf-comment-skip.pdf` — 1,805 bytes, SHA-256
  `f31578d1d72ea369b4c0de67462100ca0e761366ebdcb5bbd19d55986cc2ad25`.
  Hand-built 1-page "COMMENTSKIP" PDF, encrypted by hand (Alg
  3.2/3.3/3.5, RC4-128, empty password). A real page object 4
  (`/Contents 5 0 R`, text "COMMENTSKIP") and a real length object 9
  sit BEFORE an unreferenced stream (object 6, `/Length 9 0 R`) whose
  ciphertext reads `AAAA endstream endobj` + a forged object 40
  (`40 0 obj << /Length 0 >> stream`) + a `% endobj (` comment whose
  `(` is unbalanced through the outer stream's true end and the
  genuine page-content object 5, with the balancing `)` in a `% )`
  comment after object 5. The scanner truncates the outer stream at
  the forged endobj, discovers forged object 40, computes its end
  with the plain `indexOf("endobj", …)` — which lands on the `endobj`
  INSIDE the `%` comment — and restarts searching inside the comment,
  where it treats the `(` as a string opener and skips over object 5.
  The round-8 walk skipped the whole `%` comment and never saw the
  `(`; the removed-span second-header check saw only object 40's own
  header — so the round-8 code silently accepted the file with EMPTY
  text (pages=1, 1032 output bytes). pypdf (which follows the xref)
  reads "COMMENTSKIP". Must be rejected with "Encrypted PDFs are not
  supported" — the walk now treats `%` as an ordinary byte, so every
  `(` and `<` in the region is checked even inside a comment. Note:
  object 5's RC4 ciphertext was re-rolled (via the /ID) until it held
  no paren byte, keeping the string-skip balance exact; the forged
  object 40's endobj was verified to be the `endobj` inside the `%`
  comment (at byte 421, the `(` at 428).
- `pdf-string-skip.pdf` — 1,751 bytes, SHA-256
  `3b34b42a3a2310cc8fede06aea1c4dbd63676d76b54a72088de1ca23b195d686`.
  Hand-built 1-page "STRINGSKIP" PDF, encrypted by hand (Alg
  3.2/3.3/3.5, RC4-128, empty password). A real page object 4
  (`/Contents 5 0 R`, text "STRINGSKIP") and a real length object 9
  sit BEFORE an unreferenced stream (object 6, `/Length 9 0 R`) whose
  ciphertext reads `AAAA endstream endobj` + a forged object 40
  (`40 0 obj << /Length 0 >> stream`) + a balanced literal string
  `( endobj < ZZZ )` whose `)` is before the outer stream's true data
  end, with the genuine page-content object 5 after the outer stream.
  The scanner truncates the outer stream at the forged endobj,
  discovers forged object 40, computes its end with the plain
  `indexOf("endobj", …)` — which lands on the `endobj` INSIDE the
  literal string — and restarts inside the string, where it treats
  the `<` as a hex-string opener and jumps to the next `>` (the
  genuine object 5's dict close `>>`), skipping object 5's header.
  The round-9 walk encountered the `(` and jumped past its balanced
  `)`, never seeing the `<` inside; the removed-span second-header
  check saw only object 40's own header — so the round-9 code
  silently accepted the file with EMPTY text. pypdf (which follows
  the xref) reads "STRINGSKIP". Must be rejected with "Encrypted PDFs
  are not supported" — the walk now splits the region into segments
  at the scanner's restart points (the ends of removed spans), so the
  segment starting inside the string re-examines the `<` with fresh
  state and rejects. Note: object 5's RC4 ciphertext was re-rolled
  (via the /ID) until it held no paren/angle byte; the forged object
  40's endobj was verified to be the `endobj` inside the string (at
  byte 420, the `(` at 418, the `<` at 427, the `)` at 433, before the
  true data end at 439).
- `pdf-comment-lt-skip.pdf` — 1,115 bytes, SHA-256
  `4d951c6fe7f73b3dcc88d569a6cf72bcac200ef7179490eb2096e1b2c4e4f452`.
  Hand-built 1-page "COMMENTLT" PDF, encrypted by hand (Alg
  3.2/3.3/3.5, RC4-128, empty password). A real page object 4
  (`/Contents 5 0 R`, text "COMMENTLT") and a real length object 9
  sit BEFORE an unreferenced stream (object 6, `/Length 9 0 R`) whose
  ciphertext reads `AAAA endstream endobj % (` then a newline, then
  `< ZZZ ) filler` before its actual end. The scanner truncates the
  outer stream at the forged endobj, skips `% (` as a comment
  (through the newline), encounters the `<` on the next line and
  jumps to the next `>` — the genuine page-content object 5's dict
  close `>>` — skipping object 5's header. The round-10 walk treated
  `%` as an ordinary byte, encountered the `(` in the comment, called
  skipPdfLiteralString, and jumped past the `)` (after the `<`), never
  seeing the `<` — and there is no forged object, so removedSpans is
  empty (no segmentation, no second-header check) — so the round-10
  code silently accepted the file with EMPTY text (pages=1, 950
  output bytes). pypdf (which follows the xref) reads "COMMENTLT".
  Must be rejected with "Encrypted PDFs are not supported" — the walk
  now restores comment-skipping (bounded to the segment end, clamped
  at restart points): it skips `% (` as a comment, encounters the
  `<`, and rejects. Note: object 5's RC4 ciphertext was re-rolled
  (via the /ID) until it held no paren/angle byte; the `%` is at byte
  386, the `(` at 388 inside the comment, the `<` at 390 on the next
  line, the `)` at 396 before the true data end at 405.
- `pdf-many-restarts.pdf` — 650,720 bytes, SHA-256
  `c44209192aec935a76919a40c700de81fee25365a89c1efa488c44fcbd6ffcee`.
  Hand-built 1-page "MANYRESTART" PDF, encrypted by hand (Alg
  3.2/3.3/3.5, RC4-128, empty password). A real page object 4
  (`/Contents 5 0 R`, text "MANYRESTART") and a real length object 9
  sit BEFORE an unreferenced stream (object 6, `/Length 9 0 R`) whose
  ciphertext reads `AAAA endstream endobj` + 10,000 forged objects,
  each `N 0 obj << /Length 0 >> stream` + `% ( endobj` (an unmatched
  `(` in a comment), before its actual end. The scanner finds each
  forged object's endobj inside its comment and restarts after it, so
  there are 10,000 restart points (10,000 segments). The round-10 walk
  called skipPdfLiteralString (whole file, unbounded) and clamped
  afterward — in each segment it scanned the entire remaining suffix
  looking for a `)` (there is none), then clamped: O(k * fileSize)
  quadratic work, ~15.3 s on this file. The round-11 walk bounds
  every search to the segment end, so each segment costs O(segment
  length) — ~350 ms on this file. pypdf (which follows the xref)
  reads "MANYRESTART". Must decrypt successfully with "MANYRESTART"
  text in well under 5 s — the 5 s bound is the regression guard for
  the quadratic path; the text assertion proves the guard does not
  falsely reject (the forged objects are removed and object 5 is
  preserved). Note: object 5's RC4 ciphertext was re-rolled (via the
  /ID) until it held no paren/angle byte.
- `pdf-length-comment-ref.pdf` — 1,062 bytes, SHA-256
  `cae6495529a50f40982bdaafacef71e8b13563855ae373105ee9150d81051040`.
  Hand-built 1-page "LENGTHCOMMENT" PDF, encrypted by hand (Alg
  3.2/3.3/3.5, RC4-128, empty password). A real page object 4
  (`/Contents 5 0 R`, text "LENGTHCOMMENT") and a real length object
  9 (body "69") BEFORE a content stream (object 5) whose /Length is
  written as `9 % length reference\n0 R` (a comment between the
  reference tokens) and whose ciphertext contains `endstream` at data
  offset 9 (and no premature `endobj`). The stream's true length is
  69 (> 18). The old code read /Length as the direct number 9 (the
  reference regex allowed only whitespace, not comments), used a
  9-byte boundary (the `endstream` at offset 9 passes its check),
  decrypted only 9 bytes, and copied the rest as ciphertext — so
  pdfjs extracted NO text (pages=1, empty text). The new code parses
  the reference structurally (comments skipped as whitespace) and
  resolves it to object 9, decrypting all 69 bytes. Must import
  successfully with "LENGTHCOMMENT" text — the test asserts the
  COMPLETE decrypted content, not just the page count. Note: pypdf
  CANNOT parse this fixture (it shares the same comment-blindness —
  it fails on `0 R` with "Expecting a NameObject for key but found
  0"); verification is by direct RC4-decrypt of object 5's data
  (it matches the expected plaintext, including the full
  "LENGTHCOMMENT" content) and by the decryptor itself, not pypdf.
  The plaintext is laid out so bytes 9-17 sit inside a `%` comment
  (byte 8 is `%`, byte 18 is `\n`), so the forced bytes (which make
  the ciphertext read `endstream` there) do not corrupt the content;
  they are `endstream` XOR keystream[9:18], re-rolled (via the /ID)
  until they hold no CR/LF. The fixture builder encrypts object 5's
  data MANUALLY — the shared `encrypt_streams`/`find_streams`
  helpers share the same comment-blindness and would use length 9.
- `pdf-header-comment.pdf` — 1,248 bytes, SHA-256
  `046909b8e7fcf5b504da572a387a81da1ef307a48026d0150e8fc76d31dc43e7`.
  Hand-built 1-page "HEADERCOMMENT" PDF with a form text field,
  encrypted by hand (Alg 3.2/3.3/3.5, RC4-128, empty password). The
  page (object 4) has /Annots [10 0 R] and /Contents 5 0 R (text
  "HEADERCOMMENT"); the text field (object 10, /T "F1", /V 9 0 R)
  references object 9, which holds the field value "FIELDVALUE" as
  an encrypted hex string under the header `9 0 % ordinary header
  comment\nobj` (a comment between the generation and `obj`). The
  old code walked backward from `obj` through whitespace only, so it
  stopped at the comment text instead of the generation number and
  skipped object 9 — the field value came back "" (missing) while
  the page text stayed intact. The new code skips whitespace AND
  comments backward, finds object 9, and preserves it. Must import
  successfully with field F1 = "FIELDVALUE" and "HEADERCOMMENT"
  text — the test asserts BOTH the object preservation (via the
  exact field value) and the page text. Note: pypdf CANNOT parse
  this fixture either (same header-comment blindness); verification
  is by direct RC4-decrypt (object 9's hex string decrypts to
  "FIELDVALUE" with object 9's key; object 5's content contains
  "HEADERCOMMENT") and by the decryptor itself, not pypdf. The hex
  string and object 10's /T are RC4-encrypted with their object keys
  and hex-encoded (plain-object strings are not covered by
  `encrypt_streams`, so this is done manually); the PDF is built
  manually (not via build_pdf/finish_encrypt) because the shared
  `rebuild_xref` header regex cannot match a header containing a
  comment.
- `pdf-percent-string.pdf` — 1,272 bytes, SHA-256
  `66899b4b19f1a560da943346cffbd9d25c4ba8a41f47975e62bc1ae9c6d663f1`.
  Hand-built 1-page "PERCENTSTRING" PDF with a form text field,
  encrypted by hand (Alg 3.2/3.3/3.5, RC4-128, empty password). An
  unreferenced literal-string object (object 8) whose RC4 CIPHERTEXT
  contains a `%` byte sits on the SAME physical line as the next
  referenced field-value object (object 9, an encrypted hex string
  "FIELDVALUE"). The page (object 4) has /Annots [10 0 R] and
  /Contents 5 0 R (text "PERCENTSTRING") and /AcroForm << /Fields
  [10 0 R] >>; the text field (object 10, /T "F1", /V 9 0 R)
  references object 9. The string plaintext is 32 `A` bytes; the /ID
  is re-rolled until the ciphertext contains a `%` (0x25) and no byte
  that would break the literal-string syntax or the same-line layout
  (`(`, `)`, `\`, CR, LF, NUL). The old backward header scan found
  the `%` inside the string, treated everything after it as comment
  text, and silently skipped object 9 — so the field value came back
  "" (pages=1, text intact, 1,202 output bytes). The new forward
  tokenizer skips the string (its `%` is not a comment) and finds
  object 9. Must import successfully with field F1 = "FIELDVALUE"
  and "PERCENTSTRING" text — the test asserts the EXACT field value
  (not just the page count) plus the page text. Note: the catalog
  MUST carry the inline /AcroForm << /Fields [10 0 R] >> (as in
  header-comment) — without it pdf-lib's getForm() creates an empty
  AcroForm and returns 0 fields even though the page /Annots are
  present. Built manually (tracking offsets) because objects 8 and 9
  must sit on ONE line with no newline between them. Verified by
  direct RC4-decrypt (object 9's hex string decrypts to "FIELDVALUE"
  with object 9's key; object 5's content contains "PERCENTSTRING";
  object 8's ciphertext contains `%`; objects 8 and 9 are on the same
  line) and by the decryptor itself, not pypdf.
- `pdf-many-sameline.pdf` — 649,947 bytes, SHA-256
  `c9a6fecfb9e505bb9e26788d2c12ff2b7ade603a73ad89c4279f13d2ba3c67e4`.
  Hand-built 1-page "SAMELINE" PDF, encrypted by hand (Alg
  3.2/3.3/3.5, RC4-128, empty password), with 15,000 null objects
  (`K 0 obj null endobj`, K = 10..15009) all on ONE line (no newlines
  between them), plus a normal page (object 4, /Contents 5 0 R, text
  "SAMELINE"). The null objects are unreferenced orphans (harmless in
  the output). The old backward header scan traversed a progressively
  longer prefix for each header, so this file cost Theta(N^2) —
  ~12.4 s under the round-12 code (N=10,000 took ~5.5 s; N=15,000
  was chosen for margin above the 5 s bound), before any budget
  reservation. The new forward tokenizer scans the line once
  (linear) — ~0.64 s. Must import successfully with "SAMELINE" text;
  decrypt < 5 s (the 5 s bound is the regression guard for the
  quadratic path; the text assertion proves the guard does not falsely
  reject). Both codes produce identical output ("SAMELINE" text,
  649,856 output bytes); the difference is the work, not the outcome.
  Built manually (tracking offsets) because `build_pdf` puts each
  object on its own line. Verified by construction (the line holds
  exactly 15,000 null objects, no newline) and by the decryptor
  itself, not pypdf.
- `pdf-forged-skip-comment-header.pdf` — 1,187 bytes, SHA-256
  `61054ac7ebb139c0e7d350df5d996d49aad622f06408f6bfe1dd12e7512d34c4`.
  The forged-skip construction (a forged stream, object 6, whose
  direct length L=137 lands the scanner past the genuine content
  object 5), but object 5's header is comment-bearing (`5 0 %
  ordinary header comment` + newline + `obj`). Real page object 4
  (`/Contents 5 0 R`, text "REALPAGE") and real length object 9
  BEFORE the unreferenced attack stream (object 6, `/Length 9 0 R`)
  whose ciphertext embeds an early `endstream endobj` plus a forged
  `40 0 obj << /Length 137 >> stream` whose direct length lands the
  scanner's `indexOf("endobj", dataStart + 137)` exactly on the
  genuine page-content object 5's `endobj` — so the scanner never
  records object 5, and the forged stream's own boundary check passes
  (its data end sits on object 5's `endstream`). The old
  second-header safeguard used a whitespace-only regex and did not
  detect the comment-bearing genuine header, so the file was silently
  accepted with EMPTY text (pages=1, 983 output bytes — the genuine
  content object is lost). The new comment-aware regex detects it and
  REJECTS with `PdfError("Encrypted PDFs are not supported")`, 422.
  Built manually (tracking offsets) because `rebuild_xref`'s header
  regex cannot match a comment-bearing header. The geometry is
  measured in a placeholder build (d40=420, o5_endstream=557,
  o5_end=568, L=137) and verified in the final file (the forged
  header exists in the ciphertext; d40+L lands on object 5's
  `endobj`/`endstream`).
- `pdf-bracket-skip.pdf` — 1,371 bytes, SHA-256
  `4d90af1d919be40f7381404e702392ef6066dcbca8c6c8a86050856abd90f372`.
  Hand-built 1-page "BRACKETSKIP" PDF with a form text field,
  encrypted by hand (Alg 3.2/3.3/3.5, RC4-128, empty password). Real
  page 4 (text "BRACKETSKIP" via /Contents 5 0 R, /Annots [10 0 R],
  /AcroForm << /Fields [10 0 R] >>), real length object 7 (the attack
  stream's length) and field object 10 (/T "F1", /V 9 0 R) BEFORE an
  unreferenced stream (object 6, /Length 7 0 R) whose ciphertext reads
  `AAAA endstream endobj [ ZZZ...` (the `[` is unclosed — no `]`
  before the genuine object), with the field's referenced value object
  9 (`9 0 obj <encrypted FIELDVALUE> endobj`) AFTER the stream. The
  content object 5 is BEFORE the stream (so the page text is
  preserved regardless); only object 9 is at risk. The filler is `Z`
  bytes (no `]`, `>`, `(`, `)`, `%` — nothing that would close the
  bracket or disturb the walk). The old depth-tracking tokenizer
  encountered `[`, suppressed subsequent headers at nonzero depth, and
  silently omitted object 9 — so the field value came back ""
  (pages=1, text intact, 1,285 output bytes). The new tokenizer (no
  depth tracking) finds object 9. Must import successfully with field
  F1 = "FIELDVALUE" and "BRACKETSKIP" text — the test asserts the
  EXACT field value plus the page text. Note: the Encrypt dict
  (object 11) MUST be BEFORE the attack stream (Astra's construction)
  — if it were after the stream, the old tokenizer would suppress it
  too and the file would be REJECTED for a missing Encrypt dict
  instead of silently accepted with an empty field value (the first
  build had it last and the old code rejected instead of
  discriminating). Built manually (tracking offsets). Verified by
  direct RC4-decrypt (object 9 = "FIELDVALUE"; the attack ciphertext
  contains the forged opener; object 9 is after the stream), not
  pypdf.
- `pdf-dict-skip.pdf` — 1,366 bytes, SHA-256
  `5d78b46c7214e7cfd26c1571cf8bacb9cadc814b6edc4002740db2367ca3bc52`.
  Same construction as bracket-skip, with `<<` (a dict opener)
  instead of `[` in the ciphertext (`AAAA endstream endobj <<
  ZZZ...`). The old tokenizer treated `<<` as a dict open (depth=1)
  and suppressed object 9 — so the field value came back ""
  (pages=1, text intact, 1,280 output bytes). The new tokenizer
  treats `<<` as an ordinary two-byte delimiter, so it finds object
  9. Must import successfully with field F1 = "FIELDVALUE" and
  "DICTSKIP" text — the test asserts the EXACT field value plus the
  page text. Built by the same shared builder as bracket-skip.
  Verified by direct RC4-decrypt, not pypdf.
- `pdf-percent-run.pdf` — 1,219 bytes, SHA-256
  `c441309c2575e9cf569b47cc4f939b4d9174743a1aa920b5c88f4634a35914f2`.
  Hand-built 1-page "PERCENTRUN" PDF, encrypted by hand (Alg
  3.2/3.3/3.5, RC4-128, empty password). An unreferenced stream
  (object 6, /Length 9 0 R) whose ciphertext contains a forged object
  40 (`40 0 obj << /Length 0 % <28 %s> \n>> stream\n... endstream
  endobj`) — the forged span is removed during validation (it starts
  inside object 6's data range), and the safeguard scans its byte
  range. The range contains the 28-`%` run (after the digit `0` and
  whitespace in `/Length 0 % ...`) with NO second header, so the old
  comment-aware regex backtracked exponentially trying (and failing)
  to find one (~21.7 s), while the new linear header-counting scan is
  fast (~16 ms). The file decrypts successfully in both codes (the
  genuine content object 5 is BEFORE the attack stream, not in the
  forged span's range, so no content is lost; identical output, 1,155
  bytes) — the difference is the work, not the outcome. Must import
  successfully with "PERCENTRUN" text; decrypt < 5 s (the 5 s bound
  is the regression guard for the exponential path; the text assertion
  proves the guard does not falsely reject). N=28 `%`s was chosen so
  the old code takes well over 5 s (~21.7 s) and the new code well
  under it (~16 ms). Built manually (tracking offsets); the attack
  stream's ciphertext is crafted (plaintext = desired ciphertext XOR
  keystream) so it reads as the forged object with the `%` run.
  Verified by construction (the forged header and `%` run are in the
  file; object 5 decrypts to "PERCENTRUN"), not pypdf.
- `pdf-percent-string-skip.pdf` — 1,376 bytes, SHA-256
  `fbcff26915d5689233cef623fbf932705201437e4502b74cf7f6dfa637902423`.
  Hand-built 1-page "PERCENTSTRINGSKIP" PDF with a form text field,
  encrypted by hand (Alg 3.2/3.3/3.5, RC4-128, empty password). A
  removed forged span (object 40, inside the attack stream's data
  range) contains a balanced literal string `(A%B)` (with a `%`
  inside it) and a genuine header (object 9, an encrypted hex string
  "FIELDVALUE") on the SAME line after the `%`. Real page 4 (text
  "PERCENTSTRINGSKIP" via /Contents 5 0 R, /Annots [10 0 R],
  /AcroForm << /Fields [10 0 R] >>), real length object 7 (the attack
  stream's length) and field object 10 (/T "F1", /V 9 0 R) BEFORE an
  unreferenced stream (object 6, /Length 7 0 R) whose ciphertext
  contains an early `endstream endobj`, followed by forged object 40
  (`40 0 obj << /Length L >> stream`) whose data is `(A%B)ZZZ 9 0 obj
  <hex> endobj` (object 9 inside the forged span, before its
  `endstream`). The old header counter did not skip strings, so it
  treated the `%` inside `(A%B)` as a comment start, skipped through
  object 9's header to the newline, and returned 1 (not 2) — so the
  safeguard did not reject and the file was silently accepted with
  object 9 missing (field value "", pages=1, text intact, 1,328
  output bytes). The new counter skips strings, finds object 9,
  returns 2, and REJECTS with `PdfError("Encrypted PDFs are not
  supported")`, 422. Note: Astra's construction as stated (forged L
  landing simultaneously on the outer `endstream` for its own boundary
  check AND past the outer `endobj` to include object 9) is
  geometrically impossible — the `indexOf("endobj", d40 + L)` after
  the outer `endstream` finds the outer `endobj` first, so the span
  cannot include object 9 that way. This fixture uses the workable
  variant: object 9 sits inside the FORGED object 40's own stream
  data (before its `endstream`), so the forged L lands on the forged
  `endstream` (boundary check passes) and the span includes object 9.
  Built manually (tracking offsets). Verified by direct RC4-decrypt
  (object 9 = "FIELDVALUE"; the forged header, `(A%B)`, and object 9
  are on the same line), not pypdf.
- `pdf-many-unclosed-dicts.pdf` — 210,149 bytes, SHA-256
  `2bb40118d2f2927142678f2284b6ce4adb9a58342484b1caca65eac7f4a0bdef`.
  Hand-built 1-page "UNCLOSED" PDF, encrypted by hand (Alg
  3.2/3.3/3.5, RC4-128, empty password), with 10,000 forged headers,
  each `K 0 obj << endobj` (K = 40..10039), inside one correctly sized
  encrypted stream (object 6, /Length 9 0 R, correct indirect length
  from object 9). The correct length object (9) and encryption
  dictionary (11) are BEFORE the stream; the genuine content object 5
  is BEFORE the stream (so the page text is preserved regardless).
  Each forged header is an unclosed dict (just `<<` then `endobj`, no
  `>>`). The old `parseBalancedDict` scanned the remaining file for
  each unclosed dict, returning undefined, then the fallback found the
  nearby `endobj` and discovery advanced to the next header —
  Theta(N^2), ~8.8 s. The new `parseBalancedDict` returns undefined
  immediately on the bare `endobj` (fail fast) and is bounded to 256
  KiB, so each call is O(1) and the total is linear, ~0.2 s. Must
  import successfully with "UNCLOSED" text; decrypt < 5 s (the 5 s
  bound is the regression guard for the quadratic path; the text
  assertion proves the guard does not falsely reject). Both codes
  produce identical output ("UNCLOSED" text, 210,085 output bytes);
  the difference is the work, not the outcome. N=10,000 was chosen
  for margin (N=5,000 took only ~2.2 s under the old code — too close
  to the 5 s bound). Built manually (tracking offsets); the attack
  stream's ciphertext is crafted (plaintext = desired ciphertext XOR
  keystream). Verified by construction (exactly 10,000 forged headers
  in the file; object 5 decrypts to "UNCLOSED"), not pypdf.
- `pdf-many-endobjx.pdf` — 220,147 bytes, SHA-256
  `7c04a9e221d4cdef033fd5d8ef09db3fbe70bfadf803ccd031b688c3f4ed6683`.
  Hand-built 1-page "ENDOBJX" PDF, encrypted by hand (Alg
  3.2/3.3/3.5, RC4-128, empty password), with 10,000 forged headers,
  each `K 0 obj << endobjx` (K = 40..10039), inside one correctly sized
  encrypted stream (object 6, /Length 9 0 R, correct indirect length
  from object 9). The correct length object (9) and encryption
  dictionary (11) are BEFORE the stream; the genuine content object 5
  is BEFORE the stream (so the page text is preserved regardless).
  Each forged header is an unclosed dict (just `<<` then `endobjx`, no
  `>>`). The old `parseBalancedDict` required a whole-token `endobj`
  to stop early, so `endobjx` (not a whole token — followed by `x`)
  did not trigger it and the scan went to its limit (256 KiB, or EOF
  for this ~220KB file) for each header — quadratic, ~13.9 s — while
  the fallback accepted the `endobj` prefix of `endobjx`. The new
  check triggers on the `endobj` prefix (when not preceded by `/` or
  a regular char), consistent with the fallback, so each call fails
  fast and the total is linear, ~0.34 s. Must import successfully
  with "ENDOBJX" text; decrypt < 5 s (the 5 s bound is the regression
  guard for the quadratic path; the text assertion proves the guard
  does not falsely reject). Both codes produce identical output
  ("ENDOBJX" text, 220,083 output bytes); the difference is the work,
  not the outcome. Built manually (tracking offsets); the attack
  stream's ciphertext is crafted (plaintext = desired ciphertext XOR
  keystream). Verified by construction (exactly 10,000 forged headers
  in the file; object 5 decrypts to "ENDOBJX"), not pypdf.
- `pdf-endobj-name.pdf` — 1,041 bytes, SHA-256
  `1edf1acca2933b8e79268d03ed3daa078cc904799d2edcdafdb5778e284d2ea8`.
  Hand-built 1-page "ENDOBJNAME" PDF, encrypted by hand (Alg
  3.2/3.3/3.5, RC4-128, empty password), whose content stream (object
  5) has the dict `<< /Length 52 /Custom /endobj >>` — the `/Custom`
  key's value is the NAME `/endobj` (legal name syntax, not the
  `endobj` keyword). The old `parseBalancedDict` treated `/endobj` as
  an object terminator (the `/` is a delimiter, so the whole-token
  check passed) and returned undefined, falling back to a lexical
  `endobj` search (which also matched inside `/endobj`) and recording
  a truncated object — so the old code REJECTED the file ("Encrypted
  PDFs are not supported"). The new check excludes `/` from the
  `before` test (a `/` makes it a name, not a keyword), so the dict
  parses normally and the stream decrypts successfully. Must import
  successfully with "ENDOBJNAME" text. Built manually (tracking
  offsets) and encrypted by hand — the shared
  `find_streams`/`encrypt_streams` helpers share the same substring
  confusion (their naive `find("endobj")` hits the `/endobj` inside
  the dict, so the slice cuts off before `>>` and the stream is left
  unencrypted). Verified with pypdf (it reads the page text — the dict
  is legal) and by the decryptor (probed separately, not here).
