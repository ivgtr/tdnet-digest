/**
 * Markdown → インラインスタイル付きHTML変換ユーティリティ
 * Content Scriptではグローバル CSS を使えないため、
 * marked の出力に対してインラインスタイルを適用する
 */

import { type Tokens, Marked } from 'marked';

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
  table:
    'border-collapse: collapse; margin: 6px 0; font-size: 12px; width: 100%;',
  th: 'border: 1px solid #d1d5db; padding: 4px 8px; background-color: #f3f4f6; font-weight: bold; text-align: left;',
  td: 'border: 1px solid #d1d5db; padding: 4px 8px;',
  hr: 'border: none; border-top: 1px solid #e5e7eb; margin: 8px 0;',
  a: 'color: #2563eb; text-decoration: underline;',
};

/**
 * marked のレンダラーをカスタマイズしてインラインスタイルを付与
 */
function createStyledRenderer(): Partial<import('marked').RendererObject> {
  return {
    heading(token: Tokens.Heading) {
      const tag = `h${token.depth}` as keyof typeof MARKDOWN_STYLES;
      const text = this.parser.parseInline(token.tokens);
      return `<${tag} style="${MARKDOWN_STYLES[tag] || ''}">${text}</${tag}>`;
    },
    paragraph(token: Tokens.Paragraph) {
      const text = this.parser.parseInline(token.tokens);
      return `<p style="${MARKDOWN_STYLES.p}">${text}</p>`;
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
      const langAttr = token.lang ? ` data-lang="${token.lang}"` : '';
      return `<pre style="${MARKDOWN_STYLES.pre}"${langAttr}><code style="${MARKDOWN_STYLES['pre code']}">${token.text}</code></pre>`;
    },
    codespan(token: Tokens.Codespan) {
      return `<code style="${MARKDOWN_STYLES.code}">${token.text}</code>`;
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

      return `<table style="${MARKDOWN_STYLES.table}"><thead>${header}</thead><tbody>${body}</tbody></table>`;
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
      return `<a href="${token.href}" target="_blank" rel="noopener noreferrer" style="${MARKDOWN_STYLES.a}">${text}</a>`;
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
export function parseMarkdown(markdown: string): string {
  const result = markedInstance.parse(markdown);
  if (typeof result !== 'string') {
    return markdown;
  }
  return result;
}
