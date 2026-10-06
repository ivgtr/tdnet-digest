/** Complete unchanged-forecast assertions, never a substring inside a condition. */
export function unchangedForecastTopic(text: string): '業績予想' | '配当予想' | null {
  const source = text.normalize('NFKC').replace(/\s/g, '');
  const note = source.match(
    /^\(注\)(?:\d+[.、])?直近に公表されている(配当|業績)予想からの修正の有無[:：]無$/
  );
  if (note) return note[1] === '配当' ? '配当予想' : '業績予想';
  const date = '20\\d{2}年\\d{1,2}月\\d{1,2}日';
  const noChange = '(?:変更はありません|修正は行っておりません|修正を行っておりません)';
  const period = '(?:20\\d{2}年\\d{1,2}月期の(?:通期の)?)?';
  if (
    new RegExp(
      `^${date}に?(?:公表しました|公表した|発表した)(?:連結)?業績予想から${noChange}。?$`
    ).test(source) ||
    new RegExp(
      `^${period}(?:連結)?業績予想につきましては、${date}(?:に発表した|発表の|に公表した)(?:業績予想|予想数値)から${noChange}。?$`
    ).test(source)
  )
    return '業績予想';
  return null;
}
