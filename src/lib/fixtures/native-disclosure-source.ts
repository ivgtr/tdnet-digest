/** Minimal public-data fixtures. Values independently checked against the 2026-10-09
 * official PDFs in native-verification.json during research. These are synthesized
 * XML documents, not a claim of full taxonomy or general XBRL conformance. */
import type { NativeCompanionRef } from '../native-disclosure-contract';
export const nativeNamespaces = `xmlns="http://www.w3.org/1999/xhtml"
 xmlns:ix="http://www.xbrl.org/2008/inlineXBRL"
 xmlns:ixt="http://www.xbrl.org/inlineXBRL/transformation/2011-07-31"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
 xmlns:xbrli="http://www.xbrl.org/2003/instance"
 xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
 xmlns:tse="http://www.xbrl.tdnet.info/taxonomy/jp/tse/tdnet/ed/t/2014-01-12"
 xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
 xmlns:ext="https://example.test/public-fixture-taxonomy"`;
const html = (body: string) =>
  `<?xml version="1.0"?><html ${nativeNamespaces}><head><title>公開開示fixture</title></head><body>${body}</body></html>`;
export const fixturePeriods = [
  { id: 'current', start: '2026-03-01', end: '2026-08-31', state: 'ResultMember' },
  { id: 'prior', start: '2025-03-01', end: '2025-08-31', state: 'ResultMember' },
  { id: 'forecast', start: '2026-03-01', end: '2027-02-28', state: 'ForecastMember' },
];
export const verifiedNativeCases = {
  cando: {
    code: '26980',
    name: '株式会社 キャンドゥ',
    disclosureId: '20261008548129',
    metrics: [
      {
        concept: 'NetSales',
        label: '売上高',
        values: ['44,743', '43,372', '88,600'],
        expected: ['44743000000', '43372000000', '88600000000'],
        eps: false,
      },
      {
        concept: 'OperatingIncome',
        label: '営業利益',
        values: ['997', '1,324', '1,670'],
        expected: ['997000000', '1324000000', '1670000000'],
        eps: false,
      },
      {
        concept: 'OrdinaryIncome',
        label: '経常利益',
        values: ['952', '1,322', '1,600'],
        expected: ['952000000', '1322000000', '1600000000'],
        eps: false,
      },
      {
        concept: 'ProfitAttributableToOwnersOfParent',
        label: '親会社株主に帰属する中間純利益',
        values: ['480', '725', '450'],
        expected: ['480000000', '725000000', '450000000'],
        eps: false,
      },
      {
        concept: 'NetIncomePerShare',
        label: '１株当たり中間純利益',
        values: ['30.05', '45.32', '28.12'],
        expected: ['30.05', '45.32', '28.12'],
        eps: true,
      },
    ],
  },
  yaskawa: {
    code: '65060',
    name: '株式会社 安川電機',
    disclosureId: '20261009548685',
    metrics: [
      {
        concept: 'ProfitBeforeTaxIFRS',
        label: '税引前利益',
        values: ['25,963', '25,204', '65,500'],
        expected: ['25963000000', '25204000000', '65500000000'],
        eps: false,
      },
    ],
  },
} as const;
export type NativeFixtureCase = keyof typeof verifiedNativeCases;
export function nativeFixtureRef(which: NativeFixtureCase = 'cando'): NativeCompanionRef {
  const item = verifiedNativeCases[which];
  return {
    kind: 'tdnet-row',
    zipUrl: `https://www.release.tdnet.info/inbs/0812${item.disclosureId}.zip`,
    pdfUrl: `https://www.release.tdnet.info/inbs/1401${item.disclosureId}.pdf`,
    disclosureId: item.disclosureId,
    listingUrl: 'https://www.release.tdnet.info/inbs/I_list_001_20261009.html',
    publishedDate: '2026-10-09',
    code: item.code,
    title: '2027年２月期 第２四半期決算短信（連結）',
    correction: false,
  };
}
export function nativeFixturePdfText(which: NativeFixtureCase = 'cando') {
  const { name, code } = verifiedNativeCases[which];
  return `${name} 2027年２月期 第２四半期決算短信 2026年10月9日 コード番号 ${code.slice(0, 4)}\nPDF本文の数値は別途照合する。`;
}
export function nativeFixtureContext(
  id: string,
  code: string,
  start = '2026-03-01',
  end = '2026-08-31',
  state = 'ResultMember'
) {
  return `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.tse.or.jp/sicc">${code}</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period><xbrli:scenario><xbrldi:explicitMember dimension="tse:ConsolidatedNonconsolidatedAxis">tse:ConsolidatedMember</xbrldi:explicitMember><xbrldi:explicitMember dimension="tse:ResultForecastAxis">tse:${state}</xbrldi:explicitMember></xbrli:scenario></xbrli:context>`;
}
export const nativeFixturePaths = {
  summary: 'XBRLData/Summary/summary.htm',
  manifest: 'XBRLData/Attachment/manifest.xml',
  definitions: 'XBRLData/Attachment/definitions.htm',
  statement: 'XBRLData/Attachment/statement.htm',
  qualitative: 'XBRLData/Attachment/qualitative.htm',
};
export function nativeFixtureFiles(which: NativeFixtureCase = 'cando'): Record<string, string> {
  const item = verifiedNativeCases[which];
  const contexts = fixturePeriods
    .map((p) => nativeFixtureContext(p.id, item.code, p.start, p.end, p.state))
    .join('');
  const units = `<xbrli:unit id="JPY"><xbrli:measure>iso4217:JPY</xbrli:measure></xbrli:unit><xbrli:unit id="perShare"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:JPY</xbrli:measure></xbrli:unitNumerator><xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:divide></xbrli:unit><xbrli:unit id="pure"><xbrli:measure>xbrli:pure</xbrli:measure></xbrli:unit>`;
  const metadata = `<ix:nonNumeric name="tse:CompanyName" contextRef="current">${item.name}</ix:nonNumeric><ix:nonNumeric name="tse:SecuritiesCode" contextRef="current">${item.code}</ix:nonNumeric><ix:nonNumeric name="tse:FilingDate" contextRef="current" format="ixt:dateyearmonthdaycjk">2026年10月9日</ix:nonNumeric>`;
  const rows = item.metrics
    .map(
      (metric) =>
        `<tr><th>${metric.label}</th>${metric.values.map((literal, i) => `<td><ix:nonFraction name="tse:${metric.concept}" contextRef="${fixturePeriods[i].id}" unitRef="${metric.eps ? 'perShare' : 'JPY'}" scale="${metric.eps ? 0 : 6}" decimals="${metric.eps ? 2 : -6}" format="ixt:numdotdecimal">${literal}</ix:nonFraction></td>`).join('')}</tr>`
    )
    .join('');
  return {
    [nativeFixturePaths.summary]: html(
      `<ix:header><ix:resources>${contexts}${units}</ix:resources></ix:header><p>${metadata}</p><table><caption>業績（百万円、１株当たり利益は円）</caption><tr><th rowspan="2">指標</th><th colspan="2">中間期実績</th><th rowspan="2">通期予想</th></tr><tr><th>当期</th><th>前期</th></tr>${rows}</table><p><ix:nonFraction name="tse:ChangeInOperatingIncome" contextRef="current" unitRef="pure" scale="-2" sign="-" decimals="3" format="ixt:numdotdecimal">24.7</ix:nonFraction><ix:nonFraction name="ext:UnknownForecastBound" contextRef="forecast" unitRef="JPY" scale="6" decimals="-6" xsi:nil="true" /></p>`
    ),
    [nativeFixturePaths.manifest]: `<manifest xmlns="http://disclosure.edinet-fsa.go.jp/2013/manifest"><list><instance id="attachment"><ixbrl>definitions.htm</ixbrl><ixbrl>statement.htm</ixbrl></instance></list></manifest>`,
    [nativeFixturePaths.definitions]: html(
      `<ix:header><ix:resources>${nativeFixtureContext('current', item.code)}${units}</ix:resources></ix:header>`
    ),
    [nativeFixturePaths.statement]: html(
      `<table><tr><th>未知概念も保持する</th><td><ix:nonFraction name="ext:UnknownPublicMetric" contextRef="current" unitRef="JPY" decimals="-6" scale="6" format="ixt:numdotdecimal">876</ix:nonFraction></td></tr></table>`
    ),
    [nativeFixturePaths.qualitative]: html(
      `<h2>経営成績</h2><p>FC店への卸売上高49億4百万円、その他売上高7億96百万円となりました。</p><table><caption>通期予想の修正（百万円）</caption><tr><th>項目</th><th>税引前利益</th></tr><tr><td>前回予想</td><td>65,000</td></tr><tr><td>今回予想</td><td>65,500</td></tr><tr><td>増減率（％）</td><td>0.8</td></tr></table><p>注：金額と増減率は別の行です。</p>`
    ),
  };
}
