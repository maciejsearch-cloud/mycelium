// Klient czatu na grzybni: tokenizer (tylko słownik tokenów, ~2 MB, nie model) + szablon rozmowy Qwen.
import { mesh } from './mesh'

type Tok = {
  encode(t: string): number[]
  decode(ids: number[], o?: { skip_special_tokens?: boolean }): string
}
let tok: Promise<Tok> | undefined
export function tokenizer(): Promise<Tok> {
  tok ??= import('@huggingface/transformers').then(async (m) => {
    const t = await m.AutoTokenizer.from_pretrained('Qwen/Qwen2.5-0.5B-Instruct')
    return {
      encode: (s: string) => Array.from(t.encode(s) as number[]),
      decode: (ids: number[], o) => t.decode(ids, o),
    }
  })
  return tok
}

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}
export const template = (msgs: ChatMsg[]) => msgs.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join('') + '<|im_start|>assistant\n'

// jedna rozmowa na kartę: węzły trzymają jej pamięć K/V, więc kolejna wypowiedź liczy tylko nowe tokeny
const CONV = crypto.randomUUID()

export async function meshReply(msgs: ChatMsg[], onText: (t: string) => void, signal?: { stop: boolean }) {
  const t = await tokenizer()
  const ids = t.encode(template(msgs))
  const out: number[] = []
  const r = await mesh.generate(ids, {
    maxNew: 200,
    temp: 0.4,
    conv: CONV,
    signal,
    onToken: (id) => {
      out.push(id)
      onText(t.decode(out, { skip_special_tokens: true }))
    },
  })
  return {
    ...r,
    text: t.decode(r.tokens, { skip_special_tokens: true }),
    promptTokens: ids.length,
  }
}

/** Ta sama rozmowa, ale model grzybni liczony w tej przeglądarce (mesh/local.ts) – gdy żaden węzeł nie ma całego modelu. */
export async function localReply(msgs: ChatMsg[], onText: (t: string) => void) {
  const { localLM } = await import('./local')
  const t = await tokenizer()
  const ids = t.encode(template(msgs))
  const out: number[] = []
  const r = await localLM.generate(ids, {
    maxNew: 160,
    temp: 0.4,
    conv: CONV,
    onToken: (id) => {
      out.push(id)
      onText(t.decode(out, { skip_special_tokens: true }))
    },
  })
  return {
    ...r,
    text: t.decode(r.tokens, { skip_special_tokens: true }),
    promptTokens: ids.length,
  }
}
