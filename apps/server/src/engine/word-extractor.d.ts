// Minimal types for word-extractor (pure-JS .doc reader). The package ships
// no TypeScript declarations, so these cover exactly the API used here:
// extract a Buffer, read the document body as text.
declare module "word-extractor" {
  interface WordDocument {
    getBody(): string;
  }
  class WordExtractor {
    extract(source: string | Buffer): Promise<WordDocument>;
  }
  export = WordExtractor;
}
