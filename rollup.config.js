import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default {
  input: 'app/src/app.js',
  output: {
    file: 'app/web/app.js',
    format: 'es',
    inlineDynamicImports: true
  },
  plugins: [
    nodeResolve(),
    commonjs({
      // Convert CommonJS modules to ES6, especially for highlight.js
      include: /node_modules/,
      transformMixedEsModules: true
    })
  ],
  // Keep only HTTP URLs external (can't be bundled anyway)
  external: (id) => {
    return id.startsWith('http://') || id.startsWith('https://');
  }
};