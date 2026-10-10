import { canonicalJSON } from './fact-contract';
import {
  NATIVE_LIMITS,
  type NativeContext,
  type NativeQName,
  type NativeUnit,
} from './native-disclosure-contract';

export const XBRLI = 'http://www.xbrl.org/2003/instance';
export const XBRLDI = 'http://xbrl.org/2006/xbrldi';
export const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
export const IX_NAMESPACES = [
  'http://www.xbrl.org/2008/inlineXBRL',
  'http://www.xbrl.org/2013/inlineXBRL',
];
export const TSE = 'http://www.xbrl.tdnet.info/taxonomy/jp/tse/tdnet/ed/t/2014-01-12';
export const elements = (root: Document | Element, namespace: string, local: string): Element[] =>
  Array.from(root.getElementsByTagNameNS(namespace, local));
export const allElements = (root: Document | Element): Element[] =>
  Array.from(root.querySelectorAll('*'));
export const isInline = (node: Element) => IX_NAMESPACES.includes(node.namespaceURI ?? '');
export function parseInertXml(text: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error('NATIVE:DTD・外部エンティティは使用できません');
  const doc = new DOMParser().parseFromString(text.replace(/^\uFEFF/, ''), 'application/xml');
  if (
    doc.getElementsByTagName('parsererror').length ||
    allElements(doc).length > NATIVE_LIMITS.nodes
  )
    throw new Error('NATIVE:XML形式または文書サイズが未対応です');
  return doc;
}
export function qname(node: Element, name: string | null): NativeQName {
  if (!name || !/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(name))
    throw new Error('NATIVE:概念名・名前空間が不正です');
  const pieces = name.split(':');
  const namespace = node.lookupNamespaceURI(pieces.length === 2 ? pieces[0] : null);
  if (!namespace) throw new Error('NATIVE:未定義の名前空間です');
  return { qname: name, namespace, localName: pieces[pieces.length - 1] };
}
export const expanded = (node: Element, value: string | null): string => {
  const name = qname(node, value);
  return `{${name.namespace}}${name.localName}`;
};
export const qualifiedId = (set: string, id: string) => `${set}#${id}`;
function requiredId(element: Element): string {
  const id = element.getAttribute('id');
  if (!id || id.length > 250 || /\s/.test(id)) throw new Error('NATIVE:原文IDが不正です');
  return id;
}
const singleText = (element: Element, local: string): string | null => {
  const nodes = elements(element, XBRLI, local);
  if (nodes.length > 1) throw new Error('NATIVE:文脈の期間が重複しています');
  return nodes[0]?.textContent?.trim() || null;
};
export const validNativeDate = (value: string | null) => {
  if (value === null) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
export function parseContext(node: Element, set: string, file: string): NativeContext {
  const identifiers = elements(node, XBRLI, 'identifier');
  if (identifiers.length !== 1) throw new Error('NATIVE:主体の識別子を確定できません');
  const period = {
    start: singleText(node, 'startDate'),
    end: singleText(node, 'endDate'),
    instant: singleText(node, 'instant'),
  };
  if (
    !Object.values(period).every(validNativeDate) ||
    (period.start && period.end && period.start > period.end) ||
    !(
      (period.start && period.end && !period.instant) ||
      (period.instant && !period.start && !period.end)
    )
  )
    throw new Error('NATIVE:文脈の期間が未対応です');
  const dimensions: NativeContext['dimensions'] = [
    ...elements(node, XBRLDI, 'explicitMember').map((member) => ({
      axis: expanded(member, member.getAttribute('dimension')),
      member: expanded(member, member.textContent?.trim() ?? null),
      typedValue: null,
    })),
    ...elements(node, XBRLDI, 'typedMember').map((member) => ({
      axis: expanded(member, member.getAttribute('dimension')),
      member: null,
      typedValue: new XMLSerializer().serializeToString(member),
    })),
  ].sort((a, b) => a.axis.localeCompare(b.axis));
  if (new Set(dimensions.map((d) => d.axis)).size !== dimensions.length)
    throw new Error('NATIVE:文脈の次元が重複しています');
  const dim = (axis: string) => dimensions.find((d) => d.axis === `{${TSE}}${axis}`)?.member;
  const state = dim('ResultForecastAxis'),
    scope = dim('ConsolidatedNonconsolidatedAxis');
  return {
    id: qualifiedId(set, requiredId(node)),
    documentSetId: set,
    sourceFiles: [file],
    entity: {
      identifier: identifiers[0].textContent?.trim() || '',
      scheme: identifiers[0].getAttribute('scheme') || '',
    },
    period,
    dimensions,
    otherContent: ['segment', 'scenario'].flatMap((local) =>
      elements(node, XBRLI, local)
        .flatMap((container) =>
          Array.from(container.children).filter(
            (child) =>
              child.namespaceURI !== XBRLDI ||
              !['explicitMember', 'typedMember'].includes(child.localName)
          )
        )
        .map((child) => new XMLSerializer().serializeToString(child))
    ),
    valueKind:
      state === `{${TSE}}ResultMember`
        ? 'actual'
        : state === `{${TSE}}ForecastMember`
          ? 'forecast'
          : null,
    consolidation:
      scope === `{${TSE}}ConsolidatedMember`
        ? 'consolidated'
        : scope === `{${TSE}}NonconsolidatedMember`
          ? 'nonconsolidated'
          : null,
  };
}
export function parseUnit(node: Element, set: string): NativeUnit {
  const divides = elements(node, XBRLI, 'divide');
  const measures = (parent: Element) =>
    elements(parent, XBRLI, 'measure').map((m) => expanded(m, m.textContent?.trim() ?? null));
  let numerator: string[], denominator: string[];
  if (divides.length) {
    const n = elements(node, XBRLI, 'unitNumerator'),
      d = elements(node, XBRLI, 'unitDenominator');
    if (divides.length !== 1 || n.length !== 1 || d.length !== 1)
      throw new Error('NATIVE:単位構造が不正です');
    numerator = measures(n[0]);
    denominator = measures(d[0]);
  } else {
    numerator = measures(node);
    denominator = [];
  }
  if (!numerator.length || (divides.length && !denominator.length))
    throw new Error('NATIVE:単位が空です');
  return { id: qualifiedId(set, requiredId(node)), documentSetId: set, numerator, denominator };
}
export function sameContext(a: NativeContext, b: NativeContext): boolean {
  return canonicalJSON({ ...a, sourceFiles: [] }) === canonicalJSON({ ...b, sourceFiles: [] });
}
/** Text only. Active markup and inline exclusions never enter the source text. */
export function inertText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (node.nodeType !== 1 && node.nodeType !== 9) return '';
  const el = node as Element;
  if (
    node.nodeType === 1 &&
    (['script', 'style', 'iframe', 'object', 'embed', 'head'].includes(el.localName) ||
      (isInline(el) && ['exclude', 'header'].includes(el.localName)))
  )
    return '';
  if (node.nodeType === 1 && el.localName === 'br') return '\n';
  return Array.from(node.childNodes).map(inertText).join('');
}
export const tidyText = (node: Node) =>
  inertText(node)
    .replace(/[\t\r\n ]+/g, ' ')
    .trim();
export function exactNumber(
  literal: string,
  scale: number,
  sign: '-' | null,
  format: NativeQName | null
): string | null {
  if (
    format &&
    (![
      'http://www.xbrl.org/inlineXBRL/transformation/2011-07-31',
      'http://www.xbrl.org/inlineXBRL/transformation/2015-02-26',
      'http://www.xbrl.org/inlineXBRL/transformation/2020-02-12',
    ].includes(format.namespace) ||
      format.localName !== 'numdotdecimal')
  )
    return null;
  const raw = literal.normalize('NFKC').replace(/\s/g, '');
  const pattern = format ? /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/ : /^-?\d+(?:\.\d+)?$/;
  if (!pattern.test(raw) || (sign && raw.startsWith('-')) || raw.length > 100) return null;
  const negative = sign === '-' || raw.startsWith('-');
  const [whole, fraction = ''] = raw.replace(/[-,]/g, '').split('.');
  const digits = whole + fraction;
  const position = whole.length + scale;
  const decimal =
    position <= 0
      ? `0.${'0'.repeat(-position)}${digits}`
      : position >= digits.length
        ? digits + '0'.repeat(position - digits.length)
        : `${digits.slice(0, position)}.${digits.slice(position)}`;
  let [integer, decimalPart = ''] = decimal.split('.');
  integer = integer.replace(/^0+(?=\d)/, '');
  decimalPart = decimalPart.replace(/0+$/, '');
  const result = integer + (decimalPart ? `.${decimalPart}` : '');
  return negative && result !== '0' ? `-${result}` : result;
}

/** Supported nonnumeric transformations are explicit; unknown registries are retained unparsed. */
export function exactText(literal: string, format: NativeQName | null): string | null {
  if (!format) return literal;
  if (
    ![
      'http://www.xbrl.org/inlineXBRL/transformation/2011-07-31',
      'http://www.xbrl.org/inlineXBRL/transformation/2015-02-26',
      'http://www.xbrl.org/inlineXBRL/transformation/2020-02-12',
    ].includes(format.namespace)
  )
    return null;
  if (format.localName === 'booleantrue') return 'true';
  if (format.localName === 'booleanfalse') return 'false';
  if (format.localName === 'dateyearmonthdaycjk') {
    const m = literal
      .normalize('NFKC')
      .replace(/\s/g, '')
      .match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
    if (!m) return null;
    const date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return validNativeDate(date) ? date : null;
  }
  return null;
}
