import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Content-Security-Policy dla zbudowanej strony (GitHub Pages nie ustawia nagłówków, więc <meta>).
// Skrypty tylko z tej strony (+ onnxruntime-web z jsDelivr dla transformers.js), bez inline i eval (wasm dozwolony);
// połączenia tylko do znanych hostów. W trybie dev pomijane (Vite wstrzykuje skrypty inline).
const SB = 'agortpieeygmcttjwjfx.supabase.co'
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  `connect-src 'self' https://${SB} wss://${SB} https://huggingface.co https://*.huggingface.co https://*.hf.co https://cdn.jsdelivr.net ` +
    'https://*.wiktionary.org https://*.wikipedia.org https://www.wikidata.org https://query.wikidata.org https://commons.wikimedia.org ' +
    'https://upload.wikimedia.org https://api.github.com https://github.com https://objects.githubusercontent.com https://raw.githubusercontent.com',
  'img-src * data: blob:',
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "media-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const csp = (): Plugin => ({
  name: 'myc-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<meta charset="UTF-8" />',
      `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <meta name="referrer" content="strict-origin-when-cross-origin" />`,
    ),
})

// BASE=/demo/mycelium/ dla GitHub Pages; lokalnie "/"
export default defineConfig({
  base: process.env.BASE ?? '/',
  plugins: [react(), tailwindcss(), csp()],
  build: { chunkSizeWarningLimit: 700 },
})
