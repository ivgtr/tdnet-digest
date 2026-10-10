import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeFixtureRef } from '../../lib/fixtures/native-disclosure-source';
import { extractRowData } from './rowDataExtractor';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis };
};
const ref = nativeFixtureRef();
const pdfFile = `1401${ref.disclosureId}.pdf`;
const zipFile = `0812${ref.disclosureId}.zip`;
const openWindows: Array<Window & typeof globalThis> = [];
const noNetwork = vi.fn(() => {
  throw new Error('Row extraction must not fetch');
});
beforeEach(() => {
  noNetwork.mockClear();
  vi.stubGlobal('fetch', noNetwork);
});
afterEach(() => {
  expect(noNetwork).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  for (const window of openWindows.splice(0)) window.close();
});
const rowMarkup = (links = `<a href="${zipFile}">XBRL</a>`, title = ref.title, history = '') =>
  `<tr><td class="kjTime"> 15:00 </td><td class="kjCode"> 26980 </td><td class="kjName"> キャンドゥ </td>` +
  `<td class="kjTitle"><a href="${pdfFile}">${title}</a></td><td class="kjXbrl">${links}</td>${history}</tr>`;
const rows = (html: string) => {
  const dom = new JSDOM(`<table><tbody>${html}</tbody></table>`, { url: ref.listingUrl });
  openWindows.push(dom.window);
  return dom.window.document.querySelectorAll('tr');
};

// Owns same-row discovery only. No network lookup, filename construction or date
// inference may turn an absent/untrusted archive into a native companion.
describe('selected TDnet row native companion', () => {
  it('uses the displayed ZIP and listing publication date, even when the filename is one day older', () => {
    const data = extractRowData(rows(rowMarkup())[0])!;
    expect(data).toMatchObject({
      time: '15:00',
      code: '26980',
      companyName: 'キャンドゥ',
      title: ref.title,
      pdfUrl: pdfFile,
    });
    expect(data.nativeCompanion).toEqual(ref);
    expect(data.nativeCompanion!.disclosureId).toMatch(/^20261008/);
    expect(data.nativeCompanion!.publishedDate).toBe('2026-10-09');
  });

  it('does not use a neighboring row ZIP or fetch/fabricate one when the selected row has none', () => {
    const selected = rows(rowMarkup('') + rowMarkup())[0];
    const data = extractRowData(selected)!;
    expect(data.pdfUrl).toBe(pdfFile);
    expect(data.nativeCompanion).toBeUndefined();
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it.each([
    ['foreign host', `<a href="https://example.test/inbs/${zipFile}">XBRL</a>`],
    [
      'mismatching disclosure ID',
      `<a href="0812${nativeFixtureRef('yaskawa').disclosureId}.zip">XBRL</a>`,
    ],
    ['ambiguous links', `<a href="${zipFile}">XBRL</a><a href="${zipFile}">別リンク</a>`],
  ])('leaves the PDF path usable when the ZIP has %s', (_name, links) => {
    const data = extractRowData(rows(rowMarkup(links))[0]);
    expect(data).toMatchObject({ pdfUrl: pdfFile });
    expect(data?.nativeCompanion).toBeUndefined();
  });

  it.each([
    ['title', '（訂正）' + ref.title, ''],
    ['history', ref.title, '<td class="kjHistory">訂正履歴あり</td>'],
    ['legacy history class', ref.title, '<td class="kjHistroy">履歴あり</td>'],
  ])(
    'marks a %s correction without losing the original companion provenance',
    (_name, title, history) => {
      expect(
        extractRowData(rows(rowMarkup(undefined, title, history))[0])?.nativeCompanion
      ).toEqual({
        ...ref,
        title,
        correction: true,
      });
    }
  );
});
