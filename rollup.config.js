import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

/**
 * @param {string} name - Entry point in app/src, bundled to app/web/<name>.js
 */
const bundle = (name) => ({
  input: `app/src/${name}.js`,
  output: {
    file: `app/web/${name}.js`,
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
})

// the application and the standalone user manual window (app/web/manual.html)
export default [bundle('app'), bundle('manual')];
