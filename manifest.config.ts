import { defineManifest } from '@crxjs/vite-plugin';
import packageJson from './package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'TDnet Digest',
  version: packageJson.version,
  description: 'TDnet適時開示情報をAIで要約するChrome拡張',
  permissions: ['storage', 'activeTab'],
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
