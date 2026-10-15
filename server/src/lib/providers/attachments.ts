import type {
  ChatMessage,
  ContentPart,
  DocumentPart,
  ImagePart,
  ModelCatalogEntry,
} from "./types.js";
export function dataUrl(part: ImagePart): string {
  if (part.source.kind === "url") return part.source.url;
  return `data:${part.mediaType};base64,${part.source.data}`;
}
export function assertAttachmentsSupported(
  messages: readonly ChatMessage[],
  model: ModelCatalogEntry,
): void {
  for (const message of messages)
    for (const part of message.content) {
      if (part.type === "image" && !model.modalities.imageInput)
        throw new Error(`Model ${model.id} does not support image input`);
      if (
        part.type === "document" &&
        !model.modalities.pdfInput &&
        part.mediaType === "application/pdf"
      )
        throw new Error(`Model ${model.id} does not support PDF input`);
    }
}
export function documentText(part: DocumentPart): string {
  if (part.source.kind === "text") return part.source.text;
  if (part.mediaType === "application/pdf")
    throw new Error(
      "PDF must be sent using a provider-native document encoder",
    );
  return Buffer.from(part.source.data, "base64").toString("utf8");
}
export function textOf(parts: readonly ContentPart[]): string {
  return parts
    .flatMap((p) =>
      p.type === "text"
        ? [p.text]
        : p.type === "document"
          ? [documentText(p)]
          : [],
    )
    .join("\n");
}
