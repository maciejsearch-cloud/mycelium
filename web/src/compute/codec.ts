// Kompresja aktualizacji: top-k (największe |Δ|) + int8 ze skalą na tensor; wagi globalne jako float32.
export function b64(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

/** Δ (płaski wektor) → bajty: [u32 N][u32 T][T×(u32 rozmiar, f32 skala)][maska N bitów][int8 wartości wybranych]. */
export function encodeDelta(d: Float32Array, sizes: number[], frac: number): Uint8Array {
  const N = d.length
  const k = Math.max(1, Math.floor(N * frac))
  // próg k-tej największej wartości |Δ| (przybliżony przez sortowanie próbki – dokładny przy N < 200k)
  const abs = Float32Array.from(d, Math.abs).sort()
  const thr = abs[N - k]
  const mask = new Uint8Array(Math.ceil(N / 8))
  const vals: number[] = []
  const scales: number[] = []
  let off = 0
  for (const sz of sizes) {
    let mx = 1e-12
    for (let i = off; i < off + sz; i++) if (Math.abs(d[i]) >= thr) mx = Math.max(mx, Math.abs(d[i]))
    const sc = mx / 127
    scales.push(sc)
    for (let i = off; i < off + sz; i++)
      if (Math.abs(d[i]) >= thr && d[i] !== 0) {
        mask[i >> 3] |= 1 << (i & 7)
        vals.push(Math.max(-127, Math.min(127, Math.round(d[i] / sc))))
      }
    off += sz
  }
  const head = 8 + sizes.length * 8
  const out = new Uint8Array(head + mask.length + vals.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, N, true)
  dv.setUint32(4, sizes.length, true)
  sizes.forEach((sz, t) => {
    dv.setUint32(8 + t * 8, sz, true)
    dv.setFloat32(12 + t * 8, scales[t], true)
  })
  out.set(mask, head)
  out.set(new Uint8Array(Int8Array.from(vals).buffer), head + mask.length)
  return out
}

export function decodeDelta(u: Uint8Array): Float32Array {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength)
  const N = dv.getUint32(0, true)
  const T = dv.getUint32(4, true)
  const head = 8 + T * 8
  const mlen = Math.ceil(N / 8)
  const vals = new Int8Array(u.buffer, u.byteOffset + head + mlen, u.byteLength - head - mlen)
  const d = new Float32Array(N)
  let off = 0
  let j = 0
  for (let t = 0; t < T; t++) {
    const sz = dv.getUint32(8 + t * 8, true)
    const sc = dv.getFloat32(12 + t * 8, true)
    for (let i = off; i < off + sz; i++) if (u[head + (i >> 3)] & (1 << (i & 7))) d[i] = vals[j++] * sc
    off += sz
  }
  return d
}
