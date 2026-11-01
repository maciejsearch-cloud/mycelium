// Ładowanie modułów TypeScript z web/src w Node (bez bundlera): transpilacja ts → mjs do katalogu tymczasowego,
// względne importy dostają rozszerzenie .mjs. Używane przez skrypty pomiarowe i proces rozmówcy (rozmowa-worker).
import ts from 'typescript'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const SRC = new URL('../../src/', import.meta.url).pathname
/** @param {string[]} files ścieżki względem web/src, np. 'myc/rozbior.ts' @returns {Promise<Record<string, any>>} */
export async function loadTs(files) {
  const dir = mkdtempSync(join(tmpdir(), 'myc-ts-'))
  for (const f of files) {
    const out = join(dir, f.replace(/\.ts$/, '.mjs'))
    mkdirSync(dirname(out), { recursive: true })
    const code = ts.transpileModule(readFileSync(join(SRC, f), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
    }).outputText.replace(/(from\s+['"])(\.{1,2}\/[^'"]+?)(['"])/g, (_m, a, p, b) => a + p + '.mjs' + b)
    writeFileSync(out, code)
  }
  const mods = {}
  for (const f of files) mods[f.replace(/^.*\//, '').replace(/\.ts$/, '')] = await import(join(dir, f.replace(/\.ts$/, '.mjs')))
  return mods
}
