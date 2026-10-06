/** Bounded, explicit checks of the reading goals, alongside factual verification. */
export const NARRATIVE_READING_CHECKS = [
  'businessComparisons',
  'demandComparisons',
  'cashFlowFocus',
  'summaryFocus',
] as const;

export interface NarrativeCorrectionTarget {
  path: string;
  citationPath: string;
  value: string | string[];
  columns?: number;
}

/** Wire schemas only. Native quantities and meanings still require local validation. */
export function narrativeResponseSchema(
  sourceIds: string[],
  mode: 'draft' | 'corrections' | 'review',
  claimIds: string[] = [],
  corrections: NarrativeCorrectionTarget[] = [],
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
  const root =
    mode === 'review'
      ? object({
          version: version(5),
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
          reading: object(
            Object.fromEntries(
              NARRATIVE_READING_CHECKS.map((check) => [
                check,
                object({
                  status: {
                    type: 'string',
                    enum: ['supported', 'notApplicable', 'importantOmission', 'style'],
                  },
                  sourceIds: ref('sources'),
                  claimIds: array({ type: 'string', enum: claimIds }),
                  reason: string,
                }),
              ])
            )
          ),
        })
      : mode === 'corrections'
        ? object({
            version: version(3),
            corrections: object(
              Object.fromEntries(
                corrections.map((target) => [
                  target.path,
                  object({
                    value: Array.isArray(target.value)
                      ? {
                          ...array(string),
                          ...(target.columns === undefined
                            ? {}
                            : { minItems: target.columns, maxItems: target.columns }),
                        }
                      : string,
                    sourceIds: ref('sources'),
                  }),
                ])
              )
            ),
          })
        : object({
            version: version(3),
            overview: array(ref('line')),
            sections: array(ref('section')),
          });
  return { ...root, $defs };
}
