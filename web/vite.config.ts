import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

// Content-Security-Policy dla zbudowanej strony (GitHub Pages nie ustawia nagłówków, więc <meta>).
// Skrypty tylko z tej strony (+ onnxruntime-web z jsDelivr dla transformers.js), bez inline i eval (wasm dozwolony);
// połączenia tylko do znanych hostów. W trybie dev pomijane (Vite wstrzykuje skrypty inline).
const SB = 'agortpieeygmcttjwjfx.supabase.co'
// tylko jedna paczka z jsDelivr: onnxruntime-web w wersji zainstalowanej (transformers.js ładuje stamtąd wasm/mjs);
// dowolny inny skrypt z CDN jest blokowany (ochrona klucza portfela przed wstrzykniętym skryptem, docs/wallet.md)
const ORT = JSON.parse(readFileSync(new URL('./node_modules/onnxruntime-web/package.json', import.meta.url), 'utf8')).version as string
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT}/dist/`
export const CSP = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval' ${ORT_CDN}`,
  "worker-src 'self' blob:",
  `connect-src 'self' https://${SB} wss://${SB} https://huggingface.co https://*.huggingface.co https://*.hf.co ${ORT_CDN} ` +
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
