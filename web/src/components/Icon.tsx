/** Jednolity zestaw ikon (własne ścieżki SVG, obrys 1.75, 24×24) – zamiast znaków Unicode, bez zewnętrznej biblioteki. */
const P: Record<string, string> = {
  home: 'M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z',
  chat: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4.5 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 9.5h8M8 12.5h5',
  globe: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.4 2.3 3.5 5.2 3.5 8.5s-1.1 6.2-3.5 8.5c-2.4-2.3-3.5-5.2-3.5-8.5S9.6 5.8 12 3.5z',
  circles: 'M9 9.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM15 5.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z',
  teach: 'M12 20v-6M12 14c0-4 3-7 7-7 0 4-3 7-7 7zM12 16c0-3-2.5-5.5-6-5.5 0 3.2 2.6 5.5 6 5.5z',
  tasks: 'M5 4.5h14v15H5zM8.5 9l1.5 1.5L13 7.5M8.5 15l1.5 1.5 3-3M15 9.5h1.5M15 15.5h1.5',
  check: 'M12 3.5 19 6v5.5c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6zM8.8 12.2l2.2 2.2 4.4-4.6',
  node: 'M12 3.5 19.5 7.8v8.4L12 20.5l-7.5-4.3V7.8zM12 12V20.5M12 12l7.5-4.2M12 12 4.5 7.8',
  bolt: 'M13 3.5 5.5 13.5H12l-1 7 7.5-10H12z',
  growth: 'M4 19.5h16M6 16l4-5 3.5 3L19 7M15 7h4v4',
  book: 'M5 5.5c2.5-1 5-1 7 .5 2-1.5 4.5-1.5 7-.5v13c-2.5-1-5-1-7 .5-2-1.5-4.5-1.5-7-.5zM12 6v13',
  tree: 'M12 4.5v15M12 8.5H6.5v4M12 8.5h5.5v4M12 14H8.5v4M12 14h4.5v4M6.5 12.5v.01M17.5 12.5v.01',
  spark: 'M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8zM18.5 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  proof: 'M7 3.5h7.5L19 8v12.5H7zM14 3.5V8.5h5M10 14l2 2 3.5-3.8',
  flag: 'M6 20.5V4.5M6 5c4-2 6.5 2 11 0v8c-4.5 2-7-2-11 0',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20c1-3.6 4-5.5 7.5-5.5s6.5 1.9 7.5 5.5',
  more: 'M5 7h14M5 12h14M5 17h9',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4',
  moon: 'M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z',
  text: 'M5 6h14M5 10h14M5 14h9M5 18h6',
  target: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 11.2v1.6',
  gauge: 'M4.5 17a8 8 0 1 1 15 0M12 13l3.5-4.5M12 13v.01',
  flask: 'M9.5 3.5h5M10.5 3.5v5.5L5.2 18.2A1.5 1.5 0 0 0 6.5 20.5h11a1.5 1.5 0 0 0 1.3-2.3L13.5 9V3.5M7.5 15h9',
  hypha: 'M12 13c-3-1-4.5-4.5-7-8M12 13c2.5-3 4-6.5 7.5-8.5M12 13c3.5 1 6 0 8.5 2.5M12 13c-.5 3.5 1.5 6 4 7.5M12 13c-3 1.5-5 3.5-8 4.5M12 11a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  repo: 'M6 4.5h11.5v13H7.5A1.5 1.5 0 0 0 6 19zM6 19a1.5 1.5 0 0 0 1.5 1.5h10',
  wallet: 'M4.5 7.5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-14zM4.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h10.5v3M15.5 12.5h4v3h-4a1.5 1.5 0 0 1 0-3z',
  blocks: 'M4 4.5h6.5V11H4zM13.5 4.5H20V11h-6.5zM4 13h6.5v6.5H4zM13.5 13H20v6.5h-6.5zM10.5 7.75h3M7.25 11v2M16.75 11v2',
}
export type IconName = keyof typeof P

export function Icon({ name, size = 18, className = '', strokeWidth = 1.75 }: { name: IconName | string; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d={P[name] ?? P.spark} />
    </svg>
  )
}
