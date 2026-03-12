import { defineManifest } from '@crxjs/vite-plugin';
import packageJson from './package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'TDnet Digest',
  version: packageJson.version,
  description: 'TDnet適時開示情報をAIで要約するChrome拡張',
  // 固定キー: 拡張機能IDを安定させ、アップデート時にchrome.storageが引き継がれるようにする
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAy/Gf919uU8pFj8q53unT6KUwZZOlgZ8BOHtVGoFu66nCE3Gy8l/vYSmEwMBTZlgfEerHPswHYDtIM9zQf0J1tNWYys0E3mvOuuqpcGmWu2hRrK1EEs6C29UvG/Qt3U+Sp6DpSRyHkENYvEYo7levGnvku3fn3FMHU73R1CysnWRU+EL5bfRBGNJT9voLb5bDiVN4gEuTPTD3T+dKCcH7QGo/WrFWDhPmkSh6D7SL79Y6U9YsJx9jdq5bQZnUeJZKoff39ee8c/dB+6aS5NWX0/94KVzlu/kO6BuUH5er7BcgIzleSmbI64sJWXo3MGG2WEPbc8k8/jLMpUM7pI8eWQIDAQAB',
  permissions: ['storage', 'activeTab', 'offscreen'],
  host_permissions: ['https://www.release.tdnet.info/*'],
  action: {
    default_popup: 'popup.html',
    default_icon: {
      '16': 'logo.png',
      '32': 'logo.png',
      '48': 'logo.png',
      '128': 'logo.png',
    },
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://www.release.tdnet.info/*'],
      js: ['src/content/index.tsx'],
      run_at: 'document_end',
    },
  ],
  options_page: 'options.html',
  icons: {
    '16': 'logo.png',
    '32': 'logo.png',
    '48': 'logo.png',
    '128': 'logo.png',
  },
});
