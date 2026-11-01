// Czysta grzybnia – ułamki dokładne (BigInt): działania szkolne i jednostki liczą bez błędów zaokrągleń.
const babs = (x: bigint) => (x < 0n ? -x : x)
const bgcd = (a: bigint, b: bigint): bigint => {
  a = babs(a)
  b = babs(b)
  while (b) [a, b] = [b, a % b]
  return a
}
export class Q {
  n: bigint
  d: bigint
  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new Error('dzielenie przez zero')
    if (d < 0n) [n, d] = [-n, -d]
    const g = bgcd(n, d) || 1n
    this.n = n / g
    this.d = d / g
  }
  static parse(s: string): Q | null {
    const t = s.replace(/[\s\u00a0]/g, '').replace(',', '.')
    let m = /^(-?)(\d+)\/(\d+)$/.exec(t)
    if (m) return new Q(BigInt(m[1] + m[2]), BigInt(m[3]))
    m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(t)
    if (!m) return null
    const frac = m[3] ?? ''
    return new Q(BigInt(m[1] + m[2] + frac), 10n ** BigInt(frac.length))
  }
  static of(x: number | bigint) {
    return typeof x === 'bigint' ? new Q(x) : Q.parse(String(x))!
  }
  add(o: Q) {
    return new Q(this.n * o.d + o.n * this.d, this.d * o.d)
  }
  sub(o: Q) {
    return new Q(this.n * o.d - o.n * this.d, this.d * o.d)
  }
  mul(o: Q) {
    return new Q(this.n * o.n, this.d * o.d)
  }
  div(o: Q) {
    return new Q(this.n * o.d, this.d * o.n)
  }
  cmp(o: Q) {
    const x = this.n * o.d - o.n * this.d
    return x < 0n ? -1 : x > 0n ? 1 : 0
  }
  isInt() {
    return this.d === 1n
  }
  /** skończone rozwinięcie dziesiętne (mianownik = 2^a·5^b) */
  terminates() {
    let d = this.d
    while (d % 2n === 0n) d /= 2n
    while (d % 5n === 0n) d /= 5n
    return d === 1n
  }
  toNumber() {
    return Number(this.n) / Number(this.d)
  }
  /** zapis polski: dziesiętny z przecinkiem, gdy skończony (i nie wolno ułamka), inaczej ułamek zwykły „a/b” */
  pl(preferFraction = false): string {
    if (this.isInt()) return this.n.toString()
    if (preferFraction || !this.terminates()) {
      const sign = this.n < 0n ? '-' : ''
      return `${sign}${babs(this.n)}/${this.d}`
    }
    let k = 0
    while ((10n ** BigInt(k)) % this.d !== 0n) k++
    const scaled = (this.n * 10n ** BigInt(k)) / this.d
    const sign = scaled < 0n ? '-' : ''
    const s = babs(scaled).toString().padStart(k + 1, '0')
    return `${sign}${s.slice(0, s.length - k)},${s.slice(s.length - k)}`
  }
  /** zaokrąglenie do 10^-k (k może być ujemne: -3 = do tysięcy), połówki w górę */
  round(k: number): Q {
    const f = k >= 0 ? new Q(10n ** BigInt(k)) : new Q(1n, 10n ** BigInt(-k))
    const x = this.mul(f)
    const twice = (2n * babs(x.n)) / x.d
    let r = (twice + 1n) / 2n
    if (x.n < 0n) r = -r
    return new Q(r).div(f)
  }
}

