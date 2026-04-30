import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/three/build/*',
          dest: 'libs/three/build',
          rename: { stripBase: 3 },
        },
        {
          src: 'node_modules/three/examples/jsm/**/*',
          dest: 'libs/three',
          rename: { stripBase: 2 },
        },
        {
          src: 'node_modules/three/examples/jsm/libs/draco/gltf/*',
          dest: 'libs/draco',
          rename: { stripBase: 7 },
        },
        {
          src: 'node_modules/uplot/dist/*',
          dest: 'libs/uplot',
          rename: { stripBase: 3 },
        },
      ],
    }),
  ],
  server: {
    watch: {
      ignored: ['**/resources/docs/**', '**/resources/examples/**', '**/src-tauri/target/**'],
    },
  },
});
