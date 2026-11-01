import type { Category } from './catalogue'

/**
 * Round point icons, flat, ink with a white glyph (D29: colour is kept for crowding and alerts).
 * Glyphs are drawn on a 24 × 24 grid centred on 0,0.
 */
const G: Partial<Record<Category, string>> = {
  wc: 'M-6,-6h3v3h-3zM3,-6h3v3h-3zM-7,-1h5l-1,8h-3zM2,-1h5v4h-1v4h-3v-4h-1z',
  food: 'M-6,-7v6a2,2 0 0 0 1.5,2v6h1.5v-6a2,2 0 0 0 1.5,-2v-6h-1v5h-0.8v-5h-0.9v5h-0.8v-5zM3,-7c3,1 3,6 1,8v6h-1.6z',
  info: 'M-1.5,-7h3v3h-3zM-3,-2h4.5v7h1.5v2h-6v-2h1.5v-5h-1.5z',
  atm: 'M-8,-5h16v10h-16zM-6.5,-2.5h13v-1h-13zM-5,1h4v1.5h-4z',
  shop: 'M-6,-3h12l-1,10h-10zM-3,-3v-1.5a3,3 0 0 1 6,0v1.5h-1.4v-1.5a1.6,1.6 0 0 0 -3.2,0v1.5z',
  checkin: 'M-8,1h16v6h-16zM-5,-7h8v6h-8zM-3,-8.5h4v1.5h-4z',
  security: 'M0,-8l7,3v4c0,4.5 -3,7.5 -7,9c-4,-1.5 -7,-4.5 -7,-9v-4z',
  passport: 'M-5,-8h10v16h-10zM0,-3.5a3,3 0 1 0 0.01,0zM-3,4h6v1.2h-6z',
  belt: 'M-8,-3h16a3,3 0 0 1 0,6h-16a3,3 0 0 1 0,-6zM-4,-8h6v4h-6z',
  exit: 'M-7,-7h7v2h-5v10h5v2h-7zM2,-4l5,4l-5,4v-3h-5v-2h5z',
  emergency: 'M-7,-7h7v2h-5v10h5v2h-7zM2,-4l5,4l-5,4v-3h-5v-2h5z',
  transport: 'M-7,-1l2,-5h10l2,5v6h-2v2h-2v-2h-6v2h-2v-2h-2zM-4.5,-4l-1,3h11l-1,-3z',
  parking: 'M-4,-7h5a4,4 0 0 1 0,8h-2.5v6h-2.5zM-1.5,-4.6v3.2h2.5a1.6,1.6 0 0 0 0,-3.2z',
  vertical: 'M-8,6h4v-4h4v-4h4v-4h4v2h-2v4h-4v4h-4v4h-4z',
  assembly: 'M-2,-8a2,2 0 1 1 0.01,0zM3,-8a2,2 0 1 1 0.01,0zM-8,-4a2,2 0 1 1 0.01,0zM-5,-3h6v6h-2v5h-2v-5h-2z',
  area: 'M-3,-3h6v6h-6z',
  apron: 'M-5,-7h10v14h-10z',
}

export function PointGlyph({ cat, x, y, r, label, cls = '' }: { cat: Category; x: number; y: number; r: number; label?: string; cls?: string }) {
  const k = r / 11
  if (cat === 'gate') return <g className={`lm-icon gate ${cls}`} transform={`translate(${x} ${y})`}>
    <rect x={-r} y={-r} width={2 * r} height={2 * r} rx={r * 0.15} />
    <text y={r * 0.36} fontSize={r * (label && label.length > 1 ? 0.95 : 1.15)}>{label}</text>
  </g>
  return <g className={`lm-icon c-${cat} ${cls}`} transform={`translate(${x} ${y})`}>
    <circle r={r} />
    {G[cat] && <path d={G[cat]} transform={`scale(${k})`} />}
  </g>
}

/** Three person glyphs, `n` filled: the crowding level as a shape, beside the word. */
export function People({ n, size = 14, className = '' }: { n: number; size?: number; className?: string }) {
  const w = size * 0.62
  return <svg className={`people ${className}`} width={w * 3 + 4} height={size} viewBox={`0 0 ${w * 3 + 4} ${size}`} aria-hidden="true">
    {[0, 1, 2].map(i => <g key={i} transform={`translate(${i * (w + 2) + w / 2} 0)`} className={i < n ? 'on' : 'off'}>
      <circle cy={size * 0.2} r={size * 0.18} />
      <path d={`M${-w / 2},${size}v${-size * 0.35}a${w / 2},${size * 0.3} 0 0 1 ${w},0v${size * 0.35}z`} />
    </g>)}
  </svg>
}
