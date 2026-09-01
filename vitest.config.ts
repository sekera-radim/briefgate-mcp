import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // login() opens a browser; a test run must not open one on anyone's desk.
    env: { BRIEFGATE_NO_BROWSER: '1' },
  },
});
