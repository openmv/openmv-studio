import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    watch: {
      ignored: ['**/resources/docs/**', '**/resources/examples/**', '**/src-tauri/target/**'],
    },
  },
});
