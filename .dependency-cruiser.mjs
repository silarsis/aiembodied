// Rule 2: imports go one way. `no-circular` fails on runtime import cycles in the app source.
// Type-only imports are erased at compile time, so they are not followed (tsPreCompilationDeps: false).
/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Two modules that import each other (directly or through others) cannot be layered.',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: 'app/main/tsconfig.json' },
    tsPreCompilationDeps: false,
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(tests|dist|dist-cjs)/' },
  },
};
