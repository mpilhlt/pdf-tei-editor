import { nodeResolve } from '@rollup/plugin-node-resolve';

export default {
  input: 'app/src/app.js',
  output: {
    file: 'app/web/app.js',
    format: 'es'
  },
  plugins: [
    nodeResolve()
  ],
  // Keep only HTTP URLs external (can't be bundled anyway)
  external: (id) => {
    return id.startsWith('http://') || id.startsWith('https://');
  }
};