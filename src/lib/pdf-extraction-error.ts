import { record } from './fact-contract';

const stages = [
  'document-load',
  'page-load',
  'text-content',
  'operator-list',
  'page-layout',
  'validation',
  'selection',
  'cleanup',
  'transport',
] as const;
export type PdfExtractionStage = (typeof stages)[number];

/** Plain data only: Error properties do not survive Chrome message serialization. */
export interface PdfExtractionErrorDetails {
  pageNumber: number | null;
  stage: PdfExtractionStage;
  name: string;
  code: string | number | null;
  message: string;
}

export class PdfExtractionError extends Error {
  constructor(readonly details: PdfExtractionErrorDetails) {
    const message = details.message.replace(/^(?:PDF抽出エラー:\s*)+/, '');
    super(
      `PDF抽出エラー: ${details.pageNumber === null ? '' : `PDF p.${details.pageNumber}: `}${message}`
    );
    this.name = 'PdfExtractionError';
  }
}

/** Keep the earliest stage and original cause when a failure crosses another boundary. */
export function pdfExtractionError(
  error: unknown,
  stage: PdfExtractionStage,
  pageNumber: number | null = null
): PdfExtractionError {
  if (error instanceof PdfExtractionError) return error;
  const source = record(error) ? error : {};
  const message = typeof source.message === 'string' ? source.message : String(error);
  return new PdfExtractionError({
    pageNumber,
    stage,
    name: typeof source.name === 'string' ? source.name : 'Error',
    code:
      typeof source.code === 'string' ||
      (typeof source.code === 'number' && Number.isFinite(source.code))
        ? source.code
        : (message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] ?? null),
    message,
  });
}

export async function withPdfExtractionStage<T>(
  stage: PdfExtractionStage,
  pageNumber: number | null,
  operation: () => T | Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw pdfExtractionError(error, stage, pageNumber);
  }
}

/** Rehydrate only the diagnostic fields; never trust or copy arbitrary error properties. */
export function readPdfExtractionError(value: unknown): PdfExtractionError | null {
  if (
    !record(value) ||
    !(
      value.pageNumber === null ||
      (Number.isInteger(value.pageNumber) && Number(value.pageNumber) > 0)
    ) ||
    !stages.includes(value.stage as PdfExtractionStage) ||
    typeof value.name !== 'string' ||
    typeof value.message !== 'string' ||
    !(
      value.code === null ||
      typeof value.code === 'string' ||
      (typeof value.code === 'number' && Number.isFinite(value.code))
    )
  )
    return null;
  return new PdfExtractionError({
    pageNumber: value.pageNumber as number | null,
    stage: value.stage as PdfExtractionStage,
    name: value.name,
    code: value.code as string | number | null,
    message: value.message,
  });
}
