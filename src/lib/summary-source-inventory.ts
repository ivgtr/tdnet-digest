import type { ExtractedPage } from '@/types/summaryMetadata';
import { buildDocumentContext, type DocumentContext } from './document-context';
import { headingLevel } from './document-structure';
import {
  isAdministrativeBlock,
  headingRole,
  dividendPaymentExcerpt,
  type ContentRole,
  isSourceMetadata,
} from './summary-content-policy';
import type { DocumentType } from './document-type';
import { proseQuantities } from './quantity';

export interface SourceExcerpt {
  id: string;
  page: number;
  blockId: string;
  kind: 'paragraph' | 'row' | 'heading';
  text: string;
  heading: { id: string; text: string } | null;
  spanIds: string[];
  role: ContentRole;
}

/** Reading groups only: original block identities and text remain unchanged in storage. */
export function paragraphGroups(excerpts: SourceExcerpt[]): SourceExcerpt[] {
  const groups: SourceExcerpt[] = [];
  let previous: SourceExcerpt | undefined;
  for (const excerpt of excerpts) {
    if (excerpt.role === 'document') continue;
    if (/^\s*[-―－]\s*\d+\s*[-―－]\s*$/.test(excerpt.text)) continue;
    if (excerpt.kind !== 'paragraph') {
      previous = undefined;
      continue;
    }
    const last = groups[groups.length - 1];
    if (
      previous &&
      last &&
      (previous.page === excerpt.page || excerpt.page === previous.page + 1) &&
      previous.role === excerpt.role &&
      (previous.heading?.id === excerpt.heading?.id ||
        (excerpt.page === previous.page + 1 && excerpt.heading === null)) &&
      !/[。！？!?][」』）)\]】]*\s*$/.test(previous.text)
    ) {
      last.text += ' ' + excerpt.text;
    } else groups.push({ ...excerpt });
    previous = excerpt;
  }
  return groups;
}

/** Retain source blocks, including mixed assertions, without inventing a semantic claim.
 * Quotes are distinct from the facts used for calculations/scoring. */
export function sourceInventory(
  pages: ExtractedPage[],
  context: DocumentContext = buildDocumentContext(pages),
  type: DocumentType = 'other'
): SourceExcerpt[] {
  const blocks = pages.flatMap((p) => p.blocks);
  // Reading topics may continue across physical pages; this does not change semantic bindings.
  const headings: Array<{ level: number; role: ContentRole }> = [];
  let inlineRole: ContentRole | null = null;
  return pages.flatMap((p) =>
    p.blocks.flatMap((block): SourceExcerpt[] => {
      if (!block.text.trim() || isAdministrativeBlock(block.text)) return [];
      const binding = context.bindings.find(
        (b) => b.anchorId === block.id || b.blockId === block.id
      );
      const section = binding?.sectionIds[binding.sectionIds.length - 1];
      const parent = section ? blocks.find((b) => b.id === section)! : null;
      const level = headingLevel(block);
      const heading = level !== null;
      const ownRole = headingRole(block.text, type);
      if (heading) inlineRole = null;
      else if (
        /^修正の理由/.test(block.text.normalize('NFKC').trim()) &&
        headings[headings.length - 1]?.role !== 'dividend'
      )
        inlineRole = type === 'earningsRevision' ? 'reason' : null;
      if (heading && ownRole !== 'document') {
        while (headings.length && headings[headings.length - 1].level >= level!) headings.pop();
        headings.push({
          level: level!,
          role: ownRole ?? headings[headings.length - 1]?.role ?? 'unclassified',
        });
      }
      const role = heading
        ? (ownRole ?? headings[headings.length - 1]?.role ?? 'unclassified')
        : inlineRole
          ? inlineRole
          : parent
            ? (headingRole(parent.text, type) ??
              headings[headings.length - 1]?.role ??
              'unclassified')
            : (headings[headings.length - 1]?.role ?? 'unclassified');
      const documentOnly =
        isSourceMetadata(block.text) ||
        (/目次|決算短信/.test(block.text) && !/。|単位|資産の部|負債の部/.test(block.text)) ||
        /上場会社名.*代表者/.test(block.text.normalize('NFKC').replace(/\s/g, '')) ||
        /^\(?百万円未満切捨て\)?$/.test(block.text.normalize('NFKC').replace(/\s/g, ''));
      return [
        {
          id: `source:${block.id}`,
          page: p.pageNumber,
          blockId: block.id,
          kind: heading ? 'heading' : block.kind,
          text: block.text,
          spanIds: block.spanIds,
          role: dividendPaymentExcerpt(block.text) ? 'dividend' : documentOnly ? 'document' : role,
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
