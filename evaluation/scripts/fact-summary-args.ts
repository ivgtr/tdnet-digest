const flags = new Set([
  '--holdout',
  '--list-cases',
  '--browser',
  '--fixed-api',
  '--fixture-source',
  '--fixed-failure',
  '--smart-full',
  '--with-comparison',
  '--review-upgrade',
  '--review-rejected-url',
  '--review-diagnostics',
  '--review-copy-blocked',
  '--review-settings-change',
  '--live-followups',
]);
const values = new Set([
  '--browser-module',
  '--browser-executable',
  '--baseline-dir',
  '--same-input-as',
  '--additional-review-case',
]);

/** Resolve the optional case ID independently of flags and their values. */
export function parseFactSummaryArgs(args: string[]) {
  let caseId: string | null = null;
  const options = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.has(arg) || values.has(arg)) {
      if (options.has(arg)) throw new Error(`Duplicate option: ${arg}`);
      if (values.has(arg)) {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing option value: ${arg}`);
        options.set(arg, value);
      } else options.set(arg, true);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else {
      if (caseId !== null) throw new Error('Only one case ID is allowed');
      caseId = arg;
    }
  }
  return { caseId, holdout: options.has('--holdout'), listCases: options.has('--list-cases') };
}
