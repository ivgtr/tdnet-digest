/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { preflightExtensionSmoke } from '../../evaluation/scripts/extension-smoke-fixture';

describe('実拡張スモークの固定応答契約（ブラウザー・実API不要）', () => {
  it.each(['success', 'partial', 'failure'] as const)(
    '%s の現行応答を実製品経路で事前検査する',
    async (outcome) => {
      const result = await preflightExtensionSmoke(outcome);
      expect(result.requests).toBe(1);
    }
  );
});
