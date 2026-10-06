/** Wire schemas only. Native quantities and meanings still require local validation. */
export function narrativeResponseSchema(
  sourceIds: string[],
  mode: 'draft' | 'edits' | 'review',
  claimIds: string[] = [],
  draft?: unknown,
  reviewTopics: string[] = []
) {
  const string = { type: 'string' };
  const array = (items: unknown) => ({ type: 'array', items });
  const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
  const object = (properties: Record<string, unknown>) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  const $defs = {
    sources: array({ type: 'string', enum: sourceIds }),
    line: object({ text: string, sourceIds: ref('sources') }),
    row: object({ cells: array(string), sourceIds: ref('sources') }),
    table: object({ caption: ref('line'), headers: array(string), rows: array(ref('row')) }),
    section: object({ title: string, summary: array(ref('line')), tables: array(ref('table')) }),
  };
  const version = (v: number) => ({ type: 'integer', enum: [v] });
  const paths = { existing: [] as string[], additions: [] as string[], citations: [] as string[] };
  const walk = (value: unknown, path: string) => {
    if (path) paths.existing.push(path);
    if (Array.isArray(value)) {
      for (let i = 0; i <= value.length; i++) paths.additions.push(`${path}/${i}`);
      paths.additions.push(`${path}/-`);
      value.forEach((v, i) => walk(v, `${path}/${i}`));
    } else if (value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value)) {
        if (key === 'version') continue;
        if (key === 'sourceIds' && Array.isArray(v)) paths.citations.push(`${path}/${key}`);
        walk(v, `${path}/${key}`);
      }
    }
  };
  if (mode === 'edits') {
    if (!draft || typeof draft !== 'object') throw new Error('修復スキーマには現行草稿が必要です');
    walk(draft, '');
  }
  const pathSchema = (enumValues: string[]) => ({ type: 'string', enum: enumValues });
  const root =
    mode === 'review'
      ? object({
          version: version(4),
          claims: object(
            Object.fromEntries(
              claimIds.map((id) => [
                id,
                {
                  anyOf: [
                    { type: 'null' },
                    object({
                      status: { type: 'string', enum: ['mismatch', 'detail', 'style'] },
                      sourceIds: ref('sources'),
                      reason: string,
                    }),
                  ],
                },
              ])
            )
          ),
          coverage: object(
            Object.fromEntries(
              reviewTopics.map((topic) => [
                topic,
                {
                  anyOf: [{ type: 'null' }, object({ sourceIds: ref('sources'), reason: string })],
                },
              ])
            )
          ),
        })
      : mode === 'edits'
        ? object({
            version: version(2),
            edits: array({
              anyOf: [
                ...(['replace', 'add'] as const).map((op) =>
                  object({
                    op: { type: 'string', enum: [op] },
                    path: pathSchema(op === 'replace' ? paths.existing : paths.additions),
                    value: {
                      anyOf: [
                        string,
                        array(string),
                        ...['line', 'row', 'table', 'section'].flatMap((name) => [
                          ref(name),
                          array(ref(name)),
                        ]),
                      ],
                    },
                  })
                ),
                object({
                  op: { type: 'string', enum: ['remove'] },
                  path: pathSchema(paths.existing),
                }),
                ...(paths.citations.length
                  ? [
                      object({
                        op: { type: 'string', enum: ['cite'] },
                        path: pathSchema(paths.citations),
                        value: ref('sources'),
                      }),
                    ]
                  : []),
              ],
            }),
          })
        : object({
            version: version(3),
            overview: array(ref('line')),
            sections: array(ref('section')),
          });
  return { ...root, $defs };
}
