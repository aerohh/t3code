import { assistantCitationsToPlainText } from "./assistantCitations.ts";

/** A short local title is always available, including for attachment-only messages. */
export function messageBookmarkTitle(text: string, attachmentName?: string): string {
  const plain = assistantCitationsToPlainText(text)
    .replace(/<[^>]*>/gu, " ")
    .replace(/[[\]#*_`>~]/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  return (plain.split(" ").slice(0, 8).join(" ") || attachmentName || "Bookmarked message")
    .slice(0, 160)
    .trim();
}
