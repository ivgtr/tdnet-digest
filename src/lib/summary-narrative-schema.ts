/** Wire schemas only. Native quantities and meanings still require local validation. */
export function narrativeResponseSchema(sourceIds: string[], mode: 'draft' | 'edits' | 'review') {
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
  const root =
    mode === 'review'
      ? object({
          version: version(2),
          issues: array(
            object({
              claimId: { type: ['string', 'null'] },
              sourceIds: ref('sources'),
              reason: string,
            })
          ),
        })
      : mode === 'edits'
        ? object({
            version: version(2),
            edits: array({
              anyOf: [
                object({
                  op: { type: 'string', enum: ['replace', 'add'] },
                  path: string,
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
                }),
                object({ op: { type: 'string', enum: ['remove'] }, path: string }),
                object({
                  op: { type: 'string', enum: ['cite'] },
                  path: string,
                  value: ref('sources'),
                }),
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
