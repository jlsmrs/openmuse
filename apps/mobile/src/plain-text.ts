/**
 * Strip Markdown syntax for speech: read-aloud should speak the words, not
 * the formatting characters. Code keeps its text (a fence or backticks would
 * otherwise be read out literally); links and images keep their visible text.
 */
export function stripMarkdown(value: string): string {
  return (
    value
      // Fenced code blocks keep their inner text, lose the fence markers.
      .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
      // Images keep their alt text; links keep their visible text.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Inline code keeps its text.
      .replace(/`([^`]*)`/g, "$1")
      // Strikethrough, bold, and italic markers go; the words stay.
      .replace(/~~([^~]*)~~/g, "$1")
      .replace(/\*\*([^*]*)(\*\*|$)/g, "$1")
      .replace(/__([^_]*)__/g, "$1")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1$2")
      // Headings, blockquotes, list markers, and rules, line by line.
      .split("\n")
      .map((line) =>
        line
          .replace(/^#{1,6}\s+/, "")
          .replace(/^>\s?/, "")
          .replace(/^[-*+]\s+/, "")
          .replace(/^\d+[.)]\s+/, "")
          .replace(/^(-{3,}|\*{3,}|_{3,})\s*$/, ""),
      )
      .join("\n")
      // Any leftover HTML tags go.
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim()
  );
}
