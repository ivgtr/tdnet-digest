/**
 * Markdown → インラインスタイル付きHTML変換ユーティリティ
 * Content Scriptではグローバル CSS を使えないため、
 * marked の出力に対してインラインスタイルを適用する
 */

import { type Tokens, Marked } from 'marked';

/**
 * HTML特殊文字をエスケープする
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * URLが安全なスキームかどうかを検証する
 */
function isSafeUrl(href: string): boolean {
  try {
    const url = new URL(href, 'https://example.com');
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 要素ごとのインラインスタイル定義 */
const MARKDOWN_STYLES: Record<string, string> = {
  h1: 'font-size: 16px; font-weight: bold; color: #111827; margin: 12px 0 6px 0; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb;',
  h2: 'font-size: 15px; font-weight: bold; color: #1f2937; margin: 10px 0 6px 0; padding-bottom: 3px; border-bottom: 1px solid #f3f4f6;',
  h3: 'font-size: 14px; font-weight: bold; color: #1f2937; margin: 8px 0 4px 0;',
  h4: 'font-size: 13px; font-weight: bold; color: #374151; margin: 6px 0 4px 0;',
  h5: 'font-size: 13px; font-weight: bold; color: #374151; margin: 4px 0 2px 0;',
  h6: 'font-size: 12px; font-weight: bold; color: #6b7280; margin: 4px 0 2px 0;',
  p: 'margin: 4px 0; line-height: 1.6;',
  ul: 'margin: 4px 0; padding-left: 20px; list-style-type: disc;',
  ol: 'margin: 4px 0; padding-left: 20px; list-style-type: decimal;',
  li: 'margin: 2px 0; line-height: 1.5;',
  strong: 'font-weight: bold;',
  em: 'font-style: italic;',
  blockquote:
    'margin: 6px 0; padding: 6px 12px; border-left: 3px solid #d1d5db; color: #6b7280; background-color: #f9fafb;',
  code: 'font-family: monospace; font-size: 12px; background-color: #f3f4f6; padding: 1px 4px; border-radius: 3px;',
  pre: 'margin: 6px 0; padding: 8px; background-color: #f3f4f6; border-radius: 4px; overflow-x: auto;',
  'pre code':
    'font-family: monospace; font-size: 12px; background-color: transparent; padding: 0; border-radius: 0;',
  table: 'border-collapse: collapse; margin: 6px 0; font-size: 12px; width: 100%;',
  th: 'border: 1px solid #d1d5db; padding: 4px 8px; background-color: #f3f4f6; font-weight: bold; text-align: left;',
  td: 'border: 1px solid #d1d5db; padding: 4px 8px;',
  hr: 'border: none; border-top: 1px solid #e5e7eb; margin: 8px 0;',
  a: 'color: #2563eb; text-decoration: underline;',
};

/**
 * marked のレンダラーをカスタマイズしてインラインスタイルを付与
 */
function createStyledRenderer(pdfUrl?: string): Partial<import('marked').RendererObject> {
  return {
    heading(token: Tokens.Heading) {
      const tag = `h${token.depth}` as keyof typeof MARKDOWN_STYLES;
      const text = this.parser.parseInline(token.tokens);
      return `<${tag} style="${MARKDOWN_STYLES[tag] || ''}">${text}</${tag}>`;
    },
    paragraph(token: Tokens.Paragraph) {
      const text = this.parser.parseInline(token.tokens);
      const reference = token.text.startsWith('根拠：') ? 'font-size:11px;color:#6b7280;' : '';
      return `<p style="${MARKDOWN_STYLES.p}${reference}">${text}</p>`;
    },
    list(token: Tokens.List) {
      const tag = token.ordered ? 'ol' : 'ul';
      let body = '';
      for (const item of token.items) {
        body += this.listitem(item);
      }
      return `<${tag} style="${MARKDOWN_STYLES[tag]}">${body}</${tag}>`;
    },
    listitem(token: Tokens.ListItem) {
      let text = '';
      if (token.tokens) {
        text = this.parser.parse(token.tokens);
      }
      return `<li style="${MARKDOWN_STYLES.li}">${text}</li>`;
    },
    strong(token: Tokens.Strong) {
      const text = this.parser.parseInline(token.tokens);
      return `<strong style="${MARKDOWN_STYLES.strong}">${text}</strong>`;
    },
    em(token: Tokens.Em) {
      const text = this.parser.parseInline(token.tokens);
      return `<em style="${MARKDOWN_STYLES.em}">${text}</em>`;
    },
    blockquote(token: Tokens.Blockquote) {
      const body = this.parser.parse(token.tokens);
      return `<blockquote style="${MARKDOWN_STYLES.blockquote}">${body}</blockquote>`;
    },
    code(token: Tokens.Code) {
      const langAttr = token.lang ? ` data-lang="${escapeHtml(token.lang)}"` : '';
      return `<pre style="${MARKDOWN_STYLES.pre}"${langAttr}><code style="${MARKDOWN_STYLES['pre code']}">${escapeHtml(token.text)}</code></pre>`;
    },
    codespan(token: Tokens.Codespan) {
      return `<code style="${MARKDOWN_STYLES.code}">${escapeHtml(token.text)}</code>`;
    },
    table(token: Tokens.Table) {
      let header = '<tr>';
      for (let i = 0; i < token.header.length; i++) {
        const cell = token.header[i];
        const align = token.align[i];
        const alignStyle = align ? ` text-align: ${align};` : '';
        const text = this.parser.parseInline(cell.tokens);
        header += `<th style="${MARKDOWN_STYLES.th}${alignStyle}">${text}</th>`;
      }
      header += '</tr>';

      let body = '';
      for (const row of token.rows) {
        body += '<tr>';
        for (let i = 0; i < row.length; i++) {
          const cell = row[i];
          const align = token.align[i];
          const alignStyle = align ? ` text-align: ${align};` : '';
          const text = this.parser.parseInline(cell.tokens);
          body += `<td style="${MARKDOWN_STYLES.td}${alignStyle}">${text}</td>`;
        }
        body += '</tr>';
      }

      return `<div style="overflow-x:auto;max-width:100%;"><table style="${MARKDOWN_STYLES.table}"><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
    },
    tablerow(token: Tokens.TableRow) {
      return `<tr>${token.text}</tr>`;
    },
    tablecell(token: Tokens.TableCell) {
      const tag = token.header ? 'th' : 'td';
      const text = this.parser.parseInline(token.tokens);
      return `<${tag} style="${MARKDOWN_STYLES[tag]}">${text}</${tag}>`;
    },
    hr() {
      return `<hr style="${MARKDOWN_STYLES.hr}">`;
    },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      let href = token.href;
      if (/^tdnet-page:[1-9]\d*$/.test(href)) {
        if (!pdfUrl || !isSafeUrl(pdfUrl)) return text;
        const url = new URL(pdfUrl, 'https://www.release.tdnet.info/inbs/');
        url.hash = `page=${href.slice('tdnet-page:'.length)}`;
        href = url.href;
      }
      if (!isSafeUrl(href)) {
        return text;
      }
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" style="${MARKDOWN_STYLES.a}">${text}</a>`;
    },
  };
}

/** marked インスタンス（シングルトン） */
const markedInstance = new Marked({
  renderer: createStyledRenderer(),
  gfm: true,
  breaks: true,
});

/**
 * Markdown テキストをインラインスタイル付き HTML に変換する
 */
export function parseMarkdown(markdown: string, pdfUrl?: string): string {
  const parser = pdfUrl
    ? new Marked({ renderer: createStyledRenderer(pdfUrl), gfm: true, breaks: true })
    : markedInstance;
  const result = parser.parse(markdown);
  if (typeof result !== 'string') {
    return markdown;
  }
  return result;
}

/** Fold only the generated source supplement; verified facts and other Markdown stay visible. */
export function parseSummaryMarkdown(markdown: string, pdfUrl?: string): string {
  const parser = new Marked({
    renderer: createStyledRenderer(pdfUrl),
    gfm: true,
    breaks: true,
  });
  const tokens = parser.lexer(markdown);
  let html = '';
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (
      token.type !== 'heading' ||
      token.depth !== 3 ||
      !['原文を見る', '確認の詳細（原文）'].includes(token.text)
    )
      continue;
    html += parser.parser(tokens.slice(start, i));
    let end = i + 1;
    while (end < tokens.length) {
      const next = tokens[end];
      if (next.type === 'heading' && next.depth <= 3) break;
      end++;
    }
    const pages = new Set<number>();
    parser.walkTokens(tokens.slice(i + 1, end), (item) => {
      if (item.type === 'link' && /^tdnet-page:[1-9]\d*$/.test(item.href))
        pages.add(Number(item.href.slice('tdnet-page:'.length)));
    });
    const label =
      token.text +
      (pages.size
        ? `（${[...pages]
            .sort((a, b) => a - b)
            .map((page) => `p.${page}`)
            .join('、')}）`
        : '');
    html +=
      '<details class="tdnet-digest-source" style="margin:8px 0;">' +
      `<summary style="cursor:pointer;font-size:12px;color:#6b7280;padding:4px 0;">${escapeHtml(label)}</summary>` +
      parser.parser(tokens.slice(i + 1, end)) +
      '</details>';
    start = end;
    i = end - 1;
  }
  return html + parser.parser(tokens.slice(start));
}
