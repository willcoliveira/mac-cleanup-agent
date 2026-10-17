import { defineConfig } from 'tsup';

// One build: the CLI, with the shebang injected as a banner so it never depends
// on the first line of the source file. Sourcemaps are off so the tarball does
// not embed src/. The rule catalog ships as YAML next to dist/ (see package.json
// "files") and is read at runtime, so contributors can add rules without a build.
export default defineConfig({
  entry: { 'cli/index': 'src/cli/index.ts' },
  format: ['esm'],
  dts: false,
  sourcemap: false,
  clean: true,
  target: 'node22',
  outDir: 'dist',
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
});
