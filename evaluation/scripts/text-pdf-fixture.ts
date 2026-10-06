/** Deterministic text PDF, not an offscreen mock: PDF.js must recover these physical pages. */
export function textPdf(texts: string[], columns = [30, 280, 500]): Uint8Array {
  const hex = (text: string) =>
    [...text].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const objects: string[] = [
    '',
    '',
    '<< /Type /Font /Subtype /Type0 /BaseFont /ReviewFont /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ReviewFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 0 >> /DW 1000 /CIDToGIDMap /Identity /FontDescriptor 6 0 R >>',
  ];
  const codes = [...new Set(texts.join('').split(''))].map((c) => hex(c));
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /ReviewUnicode def /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange ${codes.length} beginbfchar ${codes.map((c) => `<${c}> <${c}>`).join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const stream = (body: string) => `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  objects.push(stream(cmap));
  objects.push(
    '<< /Type /FontDescriptor /FontName /ReviewFont /Flags 4 /FontBBox [0 -200 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -200 /CapHeight 700 /StemV 80 >>'
  );
  const kids: number[] = [];
  for (const text of texts) {
    const id = objects.length + 1;
    kids.push(id);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`
    );
    objects.push(
      stream(
        text
          .split('\n')
          .flatMap((line, i) =>
            line
              .split('\t')
              .map(
                (cell, j) =>
                  `BT /F1 10 Tf 1 0 0 1 ${columns[j]} ${800 - i * 24 + (/^\(2\)/.test(line) ? 4 : 0)} Tm <${hex(cell)}> Tj ET`
              )
          )
          .join('\n')
      )
    );
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] >>`;
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${n.toString().padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
