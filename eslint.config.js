import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { readFileSync } from 'node:fs'

const sizeExceptions = JSON.parse(
  readFileSync(new URL('./scripts/size-exceptions.json', import.meta.url), 'utf8'),
)
const sizeExceptionSources = sizeExceptions
  .map((entry) => entry.path)
  .filter((path) => /^(?:apps|packages|scripts|e2e)\//.test(path) && /\.(?:ts|tsx|mjs)$/.test(path))

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: [
      'apps/**/*.{ts,tsx,mjs,js}',
      'packages/**/*.{ts,tsx,mjs,js}',
      'scripts/**/*.{ts,tsx,mjs,js}',
      'e2e/**/*.{ts,tsx,mjs,js}',
    ],
    rules: {
      'max-lines': ['error', { max: 450, skipBlankLines: false, skipComments: false }],
    },
  },
  {
    files: sizeExceptionSources,
    rules: { 'max-lines': 'off' },
  },
  {
    // The service worker and offline page are plain scripts served from public/.
    files: ['apps/web/public/*.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/hermes/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)hermes(?:$|/(?!index\\.ts$))',
              message: 'Use the Hermes adapter entry (hermes/index.ts).',
            },
          ],
        },
      ],
    },
  },
  {
    // The front end may only talk to the server through the API contract.
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@score/server', '**/apps/server/**'],
              message: 'Use the API contract (@score/contract) instead.',
            },
          ],
        },
      ],
      // Undefined on plain-HTTP LAN origins (secure contexts only); it broke every action in remote mode.
      'no-restricted-properties': [
        'error',
        { object: 'crypto', property: 'randomUUID', message: 'Use newId() from data/ids.ts.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='randomUUID']",
          message: 'Use newId() from data/ids.ts (crypto.randomUUID needs HTTPS).',
        },
        {
          selector: "MemberExpression[object.name='navigator'][property.name='clipboard']",
          message: 'Use copyText() from data/clipboard.ts (navigator.clipboard needs HTTPS).',
        },
      ],
    },
  },
  {
    files: ['apps/web/src/data/ids.test.ts', 'apps/web/src/data/clipboard.test.ts'],
    rules: { 'no-restricted-properties': 'off', 'no-restricted-syntax': 'off' },
  },
)
