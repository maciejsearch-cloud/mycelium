import { useEffect, useRef } from 'react'

/** Obraz 28×28 w skali szarości (prawdziwe piksele ze zbioru). */
export function Px({ px, size = 84, rot = 0, invert = false }: { px?: Uint8Array; size?: number; rot?: number; invert?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current?.getContext('2d')
    if (!c || !px) return
    const d = c.createImageData(28, 28)
    for (let i = 0; i < 784; i++) {
      const v = invert ? 255 - px[i] : px[i]
      d.data.set([v, v, v, 255], i * 4)
    }
    c.putImageData(d, 0, 0)
  }, [px, invert])
  return <canvas ref={ref} width={28} height={28} style={{ width: size, height: size, transform: `rotate(${rot * 90}deg)`, transition: 'transform .2s' }} className="rounded-lg bg-black" aria-hidden />
}
