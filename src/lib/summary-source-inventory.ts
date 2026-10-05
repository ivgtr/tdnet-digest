import type { ExtractedPage } from '@/types/summaryMetadata';
import { buildDocumentContext, type DocumentContext } from './document-context';
import { headingLevel } from './document-structure';
import { isAdministrativeBlock } from './summary-content-policy';
import { proseQuantities } from './quantity';

export interface SourceExcerpt {
  id: string;
  page: number;
  blockId: string;
  kind: 'paragraph' | 'row' | 'heading';
  text: string;
  heading: { id: string; text: string } | null;
}

/** Retain source blocks, including mixed assertions, without inventing a semantic claim.
 * Quotes are distinct from the facts used for calculations/scoring. */
export function sourceInventory(
  pages: ExtractedPage[],
  context: DocumentContext = buildDocumentContext(pages)
): SourceExcerpt[] {
  const blocks = pages.flatMap((p) => p.blocks);
  return pages.flatMap((p) =>
    p.blocks.flatMap((block): SourceExcerpt[] => {
      if (!block.text.trim() || isAdministrativeBlock(block.text)) return [];
      const binding = context.bindings.find(
        (b) => b.anchorId === block.id || b.blockId === block.id
      );
      const section = binding?.sectionIds[binding.sectionIds.length - 1];
      const parent = section ? blocks.find((b) => b.id === section)! : null;
      const heading = headingLevel(block) !== null;
      return [
        {
          id: `source:${block.id}`,
          page: p.pageNumber,
          blockId: block.id,
          kind: heading ? 'heading' : block.kind,
          text: block.text,
          heading: heading
            ? { id: block.id, text: block.text }
            : parent
              ? { id: parent.id, text: parent.text }
              : null,
        },
      ];
    })
  );
}

export function selectableFactCapacity(pages: ExtractedPage[]): number {
  return pages
    .filter((p) => p.selection === 'selected')
    .reduce(
      (count, page) =>
        count +
        page.quantities.length +
        page.blocks
          .filter((b) => b.kind === 'paragraph')
          .reduce((n, block) => n + 2 + proseQuantities(block).length, 0),
      0
    );
}
