import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { createReadStream, readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

// Content-Security-Policy dla zbudowanej strony (GitHub Pages nie ustawia nagłówków, więc <meta>).
// Skrypty tylko z tej strony, bez inline i eval (wasm dozwolony); onnxruntime-web hostowany u nas (/ort/), bez CDN;
// połączenia tylko do znanych hostów. W trybie dev pomijane (Vite wstrzykuje skrypty inline).
const SB = 'agortpieeygmcttjwjfx.supabase.co'
// onnxruntime-web (wasm + mjs dla transformers.js) kopiowany z node_modules do dist/ort/ – żadnego skryptu z CDN
// (ochrona klucza portfela i klucza właścicielki przed przejęciem CDN, docs/security-audit.md A3).
// Wariant .asyncify = domyślny transformers.js; zwykły = Safari < 26 bez WebGPU.
export const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']
const ortSrc = (f: string) => new URL(`./node_modules/onnxruntime-web/dist/${f}`, import.meta.url)
const ortLocal = (): Plugin => ({
  name: 'myc-ort-local',
  generateBundle() {
    for (const f of ORT_FILES) this.emitFile({ type: 'asset', fileName: `ort/${f}`, source: readFileSync(ortSrc(f)) })
  },
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const f = ORT_FILES.find((x) => req.url?.split('?')[0].endsWith(`/ort/${x}`))
      if (!f) return next()
      res.setHeader('Content-Type', f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
      createReadStream(ortSrc(f)).pipe(res)
    })
  },
})
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  `connect-src 'self' https://${SB} wss://${SB} https://huggingface.co https://*.huggingface.co https://*.hf.co ` +
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
  plugins: [react(), tailwindcss(), csp(), ortLocal()],
  build: { chunkSizeWarningLimit: 700 },
})
