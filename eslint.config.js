import js from '@eslint/js';
import typescript from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';
import { builtinModules } from 'node:module';

// The Electron split (AGENTS.md rule 6). The renderer reaches main only through the preload bridge; code both
// sides run lives in app/main/src/shared/<feature>/ and must stand alone.
const nodeBuiltins = {
  regex: `^(node:|(${builtinModules.filter((name) => !name.startsWith('_')).join('|')})(/|$))`,
  message: 'Node built-ins are not available in the renderer or in app/main/src/shared.',
};
const electron = {
  regex: '^electron(/|$)',
  message: 'Electron is main-process only. The renderer reaches it through the preload bridge (window.aiembodied).',
};
const mainRuntime = {
  regex: '(^|/)main/src/(?!shared/)',
  allowTypeImports: true,
  message:
    'The renderer may import types from app/main, but runtime code only from app/main/src/shared/. Move code both sides run into app/main/src/shared/<feature>/, or call main through window.aiembodied.',
};
const rendererImport = {
  regex: '(^|/)renderer/',
  message: 'app/main never imports from app/renderer.',
};
const restrict = (...patterns) => ['error', { patterns }];

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'node_modules/**'],
  },
  js.configs.recommended,
  {
    // Base config for all files
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
        project: ['./app/main/tsconfig.json', './app/renderer/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
        NodeJS: 'readonly',
        Console: 'readonly',
        WindowEventMap: 'readonly',
        MediaStreamConstraints: 'readonly',
        FrameRequestCallback: 'readonly',
        RTCConfiguration: 'readonly',
        RTCIceServer: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
    },
    rules: {
      ...typescript.configs.recommended.rules,
      'no-console': 'off', // Allow console usage in this project

      // No any types
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      // No type assertions on object literals - but allow 'as' for library interop
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],

      // No non-null assertions - handle errors properly
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    // React config - only for renderer
    files: ['app/renderer/**/*.{js,jsx,ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      // React Compiler rules from react-hooks v7. Existing components predate them,
      // so report as warnings until App.tsx / avatar-configurator are refactored.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  {
    files: ['app/renderer/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': restrict(mainRuntime) },
  },
  {
    // Tests and vite.config.ts run in Node, so only the shipped renderer code is kept off Node and Electron.
    files: ['app/renderer/src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': restrict(mainRuntime, electron, nodeBuiltins) },
  },
  {
    files: ['app/main/**/*.ts'],
    rules: { 'no-restricted-imports': restrict(rendererImport) },
  },
  {
    files: ['app/main/src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict(
        rendererImport,
        electron,
        nodeBuiltins,
        { regex: '^[^.]', message: 'app/main/src/shared must not import npm packages.' },
        {
          regex: '^\\.\\./\\.\\./',
          allowTypeImports: true,
          message: 'app/main/src/shared must not import from outside shared/. Move what it needs into shared/.',
        },
      ),
    },
  },
];
