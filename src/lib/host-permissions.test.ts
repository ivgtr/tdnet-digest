import { describe, expect, it } from 'vitest';
import { customApiPermission } from './host-permissions';

describe('カスタムAPIのホスト権限', () => {
  it('APIのURLから必要なHTTPSホストだけを取り出す', () => {
    expect(customApiPermission('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/*'
    );
    expect(customApiPermission('https://api.example.com:8443/v1/chat')).toBe(
      'https://api.example.com/*'
    );
  });

  it('HTTP、相対URL、認証情報付きURLを拒否する', () => {
    for (const url of [
      'http://api.example.com/v1',
      '/v1/chat',
      'https://user:pass@api.example.com/v1',
    ]) {
      expect(() => customApiPermission(url)).toThrow();
    }
  });
});
