import { defineConfig } from 'vite';

// Relative asset paths so the same build runs from a web server and from the Electron app (file://).
export default defineConfig({
  base: './',
});
