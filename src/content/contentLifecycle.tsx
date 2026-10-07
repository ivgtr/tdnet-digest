import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import SummaryButton from './SummaryButton';
import { extractRowData } from './utils/rowDataExtractor';
import { addHeaderColumn, getRowCellClass, updateLastCellClass } from './utils/tdnetDomHelper';

interface MountedRow {
  root: Root;
  cell: HTMLTableCellElement;
  data: string;
  restoreCell: () => void;
}

// Each enabled session owns its frame, observers and React roots. DOM removal is
// always preceded by unmount, including rows/documents replaced by the host page.
export function startContentScript(hostDocument: Document = document): () => void {
  let disposed = false;
  let enabled = false;
  let settingsRevision = 0;
  let hostObserver: MutationObserver | null = null;
  let frameObserver: MutationObserver | null = null;
  let frame: HTMLIFrameElement | null = null;
  let frameDocument: Document | null = null;
  let header: { cell: Element; restore: () => void } | null = null;
  const roots = new Map<HTMLTableRowElement, MountedRow>();

  const removeRow = (row: HTMLTableRowElement, mounted: MountedRow) => {
    roots.delete(row);
    mounted.root.unmount();
    mounted.cell.remove();
    mounted.restoreCell();
  };
  const clearDocument = () => {
    frameObserver?.disconnect();
    frameObserver = null;
    roots.forEach((mounted, row) => removeRow(row, mounted));
    header?.restore();
    header = null;
    frameDocument = null;
  };

  const inject = () => {
    const doc = frameDocument;
    if (disposed || !enabled || !doc) return;
    const table = doc.querySelector('#main-list-table');
    roots.forEach((mounted, row) => {
      if (
        !table?.contains(row) ||
        !row.contains(mounted.cell) ||
        JSON.stringify(extractRowData(row)) !== mounted.data
      )
        removeRow(row, mounted);
    });
    if (header && !doc.contains(header.cell)) {
      header.restore();
      header = null;
    }
    if (!header) {
      const previous = doc.querySelector<HTMLElement>('#list-head tr td:last-child');
      const previousClass = previous?.className;
      const previousRadius = previous?.style.borderRadius;
      addHeaderColumn(doc);
      const cell = doc.querySelector('.tdnet-digest-header');
      if (cell) {
        const appliedClass = previous?.className;
        header = {
          cell,
          restore: () => {
            cell.remove();
            if (previous && previous.className === appliedClass) {
              previous.className = previousClass!;
              previous.style.borderRadius = previousRadius!;
            }
          },
        };
      }
    }
    table?.querySelectorAll<HTMLTableRowElement>('tbody > tr').forEach((row) => {
      if (roots.has(row) || row.classList.contains('tdnet-digest-summary-row')) return;
      const rowData = extractRowData(row);
      if (!rowData) return;
      const previous = row.lastElementChild;
      const previousClass = previous?.className;
      updateLastCellClass(row);
      const appliedClass = previous?.className;
      const cell = doc.createElement('td');
      cell.className = `${getRowCellClass(row)} tdnet-digest-button-cell`;
      cell.setAttribute('nowrap', '');
      cell.setAttribute('align', 'center');
      cell.style.width = '80px';
      const container = doc.createElement('div');
      cell.appendChild(container);
      row.appendChild(cell);
      const root = createRoot(container);
      roots.set(row, {
        root,
        cell,
        data: JSON.stringify(rowData),
        restoreCell: () => {
          if (previous && previous.className === appliedClass) previous.className = previousClass!;
        },
      });
      root.render(
        <React.StrictMode>
          <SummaryButton rowData={rowData} row={row} iframeDoc={doc} />
        </React.StrictMode>
      );
    });
  };

  const attachDocument = () => {
    if (!enabled || disposed || !frame) return;
    let doc: Document | null = null;
    try {
      doc = frame.contentDocument;
    } catch {
      // A navigating frame can temporarily be inaccessible. Its next load retries.
    }
    if (doc !== frameDocument) {
      clearDocument();
      frameDocument = doc;
      if (doc) {
        frameObserver = new MutationObserver(inject);
        frameObserver.observe(doc, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['href'],
        });
      }
    }
    inject();
  };
  const loaded = () => {
    clearDocument();
    attachDocument();
  };
  const clearFrame = () => {
    frame?.removeEventListener('load', loaded);
    clearDocument();
    frame = null;
  };
  const findFrame = () => {
    if (!enabled || disposed) return;
    const next = hostDocument.querySelector<HTMLIFrameElement>('iframe#main_list');
    if (next !== frame) {
      clearFrame();
      frame = next;
      frame?.addEventListener('load', loaded);
    }
    attachDocument();
  };
  const setEnabled = (next: boolean) => {
    if (disposed || next === enabled) return;
    enabled = next;
    if (enabled) {
      hostObserver = new MutationObserver(findFrame);
      hostObserver.observe(hostDocument, { childList: true, subtree: true });
      findFrame();
    } else {
      hostObserver?.disconnect();
      hostObserver = null;
      clearFrame();
    }
  };
  const onMessage = (request: { action?: string; enabled?: boolean }) => {
    if (request.action !== 'toggleExtension') return;
    settingsRevision++;
    setEnabled(request.enabled === true);
  };
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'sync' || !('extensionEnabled' in changes)) return;
    settingsRevision++;
    setEnabled(changes.extensionEnabled.newValue !== false);
  };
  const pageHidden = (event: PageTransitionEvent) => {
    // BFCache retains this realm and its listeners. Keep it usable on Back.
    if (!event.persisted) dispose();
  };
  const dispose = () => {
    if (disposed) return;
    setEnabled(false);
    disposed = true;
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.storage.onChanged.removeListener(onStorage);
    hostDocument.defaultView?.removeEventListener('pagehide', pageHidden);
  };
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorage);
  hostDocument.defaultView?.addEventListener('pagehide', pageHidden);
  const revision = settingsRevision;
  chrome.storage.sync.get(['extensionEnabled'], (settings) => {
    if (revision === settingsRevision) setEnabled(settings.extensionEnabled !== false);
  });
  return dispose;
}
