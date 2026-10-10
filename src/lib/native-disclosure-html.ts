import {
  NATIVE_LIMITS,
  type NativeHtmlCell,
  type NativeHtmlPassage,
  type NativeHtmlTable,
} from './native-disclosure-contract';
import { allElements, isInline, tidyText } from './native-disclosure-xml';

function nearest(node: Element, names: string[]): Element | null {
  let current: Element | null = node;
  while (current) {
    if (names.includes(current.localName)) return current;
    current = current.parentElement;
  }
  return null;
}
/** Keeps physical HTML row/column membership and spans, never synthesizes financial headers. */
export function parseNativeHtml(doc: Document, file: string, budget = { cells: 0, slots: 0 }) {
  const tables: NativeHtmlTable[] = [],
    passages: NativeHtmlPassage[] = [];
  const cellRefs = new Map<Element, { tableId: string; cellId: string; rowText: string }>();
  const retained = new Set<Element>();
  for (const node of allElements(doc).filter((n) => n.localName === 'table')) {
    const table: NativeHtmlTable = {
      id: `${file}#table-${tables.length + 1}`,
      file,
      caption:
        Array.from(node.children)
          .find((n) => n.localName === 'caption')
          ?.textContent?.trim() || null,
      cells: [],
      rows: [],
    };
    const occupied = new Set<string>();
    const rows = allElements(node).filter(
      (n) => n.localName === 'tr' && nearest(n, ['table']) === node
    );
    rows.forEach((row, index) => {
      let column = 0;
      const cellNodes = Array.from(row.children).filter((n) => ['td', 'th'].includes(n.localName));
      const cellIds: string[] = [];
      const rowText = cellNodes.map(tidyText).join(' | ');
      for (const cellNode of cellNodes) {
        while (occupied.has(`${index}:${column}`)) column++;
        const span = (name: string) => {
          const raw = cellNode.getAttribute(name) || '1';
          if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 200)
            throw new Error('NATIVE:表の結合セルが未対応です');
          return Number(raw);
        };
        const rowSpan = span('rowspan'),
          colSpan = span('colspan');
        budget.cells++;
        budget.slots += rowSpan * colSpan;
        if (
          budget.cells > NATIVE_LIMITS.tableCells ||
          budget.slots > 200000 ||
          rowSpan * colSpan > 10000 ||
          column + colSpan > 1000
        )
          throw new Error('NATIVE:表のサイズ上限を超えました');
        for (let r = index; r < index + rowSpan; r++)
          for (let c = column; c < column + colSpan; c++) {
            const key = `${r}:${c}`;
            if (occupied.has(key)) throw new Error('NATIVE:表の結合セルが重なっています');
            occupied.add(key);
          }
        const id = `${table.id}:r${index + 1}c${column + 1}`;
        const cell: NativeHtmlCell = {
          id,
          row: index,
          column,
          rowSpan,
          colSpan,
          tag: cellNode.localName as 'td' | 'th',
          text: tidyText(cellNode),
          headers: (cellNode.getAttribute('headers') || '').split(/\s+/).filter(Boolean),
          scope: cellNode.getAttribute('scope'),
        };
        table.cells.push(cell);
        cellIds.push(id);
        cellRefs.set(cellNode, { tableId: table.id, cellId: id, rowText });
        column += colSpan;
      }
      table.rows.push({ id: `${table.id}:r${index + 1}`, index, cellIds, text: rowText });
    });
    tables.push(table);
    retained.add(node);
  }
  for (const node of allElements(doc)) {
    if (
      !['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'div'].includes(node.localName) ||
      nearest(node, ['td', 'th', 'head', 'script', 'style']) ||
      (node.localName === 'div' &&
        allElements(node).some((n) => ['p', 'div', 'table', 'li'].includes(n.localName)))
    )
      continue;
    const text = tidyText(node);
    if (!text) continue;
    retained.add(node);
    passages.push({
      id: `${file}#passage-${passages.length + 1}`,
      file,
      kind: /^h[1-6]$/.test(node.localName)
        ? 'heading'
        : /^[（(]?注[）)\d\s：:]/.test(text)
          ? 'note'
          : 'paragraph',
      text,
    });
  }
  // Keep text in unfamiliar containers too. A paragraph-name vocabulary must not
  // decide whether an acquired company statement survives into source evidence.
  const body = allElements(doc).find((node) => node.localName === 'body');
  if (body) {
    const walker = doc.createTreeWalker(body, 4); // SHOW_TEXT, without a global DOM dependency.
    let textNode: Node | null;
    while ((textNode = walker.nextNode())) {
      const text = tidyText(textNode);
      if (!text) continue;
      let parent = textNode.parentElement,
        covered = false;
      while (parent) {
        if (
          retained.has(parent) ||
          ['head', 'script', 'style', 'iframe', 'object', 'embed'].includes(parent.localName) ||
          (isInline(parent) && ['header', 'exclude'].includes(parent.localName))
        ) {
          covered = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (!covered)
        passages.push({
          id: `${file}#passage-${passages.length + 1}`,
          file,
          kind: 'paragraph',
          text,
        });
    }
  }
  return { tables, passages, cellRefs };
}
export function cellReference(
  node: Element,
  refs: Map<Element, { tableId: string; cellId: string; rowText: string }>
) {
  const cell = nearest(node, ['td', 'th']);
  return (cell && refs.get(cell)) || { tableId: null, cellId: null, rowText: null };
}
