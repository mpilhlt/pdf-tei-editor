import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default {
  input: 'app/src/highlight-bundle.js',
  output: {
    file: 'app/web/highlight.js',
    format: 'iife',
    name: 'HighlightBundle'
  },
  plugins: [
    nodeResolve(),
    commonjs({
      include: /node_modules/,
      transformMixedEsModules: true
    })
  ]
};
