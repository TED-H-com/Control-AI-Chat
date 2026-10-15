export const MIME = {
  text: 'text/plain', csv: 'text/csv', markdown: 'text/markdown',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

export type ExtractionWarning =
  | 'CONTROL_CHARACTERS_REMOVED' | 'TEXT_TRUNCATED' | 'PAGE_LIMIT_REACHED'
  | 'LANGUAGE_UNDETERMINED' | 'EXTERNAL_REFERENCES_REMOVED';

export type ExtractionErrorCode =
  | 'UNSUPPORTED_TYPE' | 'FILE_TOO_LARGE' | 'MIME_MISMATCH' | 'CORRUPT_FILE'
  | 'ENCRYPTED_FILE' | 'PAGE_LIMIT_EXCEEDED' | 'ARCHIVE_BOMB'
  | 'ARCHIVE_PATH_TRAVERSAL' | 'UNSAFE_XML'
  | 'EXTRACTION_BUSY' | 'EXTRACTION_TIMEOUT' | 'EXTRACTION_FAILED';

export interface ExtractionLimits {
  readonly maxFileBytes: number;
  readonly maxExtractedCharacters: number;
  readonly maxPages: number;
  readonly timeoutMs: number;
  readonly maxDecompressedBytes: number;
  readonly maxCompressionRatio: number;
}

export interface ExtractionRequest {
  readonly bytes: Uint8Array;
  readonly declaredMimeType?: string;
  readonly filename?: string;
  readonly limits?: Partial<ExtractionLimits>;
}

export interface ExtractionResult {
  readonly status: 'ok';
  readonly mimeType: string;
  readonly text: string;
  readonly unitCount: number;
  readonly unitKind: 'document' | 'page' | 'sheet' | 'slide';
  readonly language: string | null;
  readonly truncated: boolean;
  readonly warnings: readonly ExtractionWarning[];
  /** Extracted uploads are untrusted and MUST be gated before preview/search/provider use. */
  readonly gateRequired: true;
}

export interface ExtractionFailure {
  readonly status: 'error';
  readonly code: ExtractionErrorCode;
  readonly mimeType: string | null;
  readonly warnings: readonly ExtractionWarning[];
  readonly gateRequired: true;
}

export type ExtractionOutcome = ExtractionResult | ExtractionFailure;

export interface ExtractorContext {
  readonly mimeType: string;
  readonly limits: ExtractionLimits;
}

export interface Extractor {
  readonly id: string;
  readonly mimeTypes: ReadonlySet<string>;
  extract(bytes: Uint8Array, context: ExtractorContext): Promise<ExtractionOutcome>;
}
