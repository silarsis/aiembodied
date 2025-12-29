import { createVitestConfig } from './vitest.config.base.js';

// Support VITEST_PATTERN env var for split test runs
const pattern = process.env.VITEST_PATTERN;
export default createVitestConfig(pattern);
