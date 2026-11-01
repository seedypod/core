import { podPlaces, towerShape } from './towerLayout'
import type { PodState } from './towerScene'

const STATUS_FILL: Record<PodState['status'], string> = {
  empty: 'transparent',
  seeded: 'var(--text-2)',
  growing: 'var(--pod-ok)',
  harvest: 'var(--accent-light)',
  attention: 'var(--pod-attention)',
}

/**
 * The tower's front elevation as line work, from the same layout as the 3D
 * model. It needs no three.js, so it shows at once: the lines draw in, the pods
 * fill with their status, and it fades out as the 3D view fades in.
 */
export function TowerWireframe({ pods, podCount, fading }: { pods: PodState[], podCount: number, fading: boolean }) {
  const shape = towerShape(podCount)
  const places = podPlaces(podCount)
  const status = new Map(pods.map(p => [p.slot, p.status]))
  const baseWidth = shape.width + 0.14
  const top = shape.height + 0.08
  const half = baseWidth / 2 + 0.12
  // y runs up in metres; flip it for SVG.
  const y = (m: number) => top - m
  return (
    <svg
      aria-hidden
      data-testid="tower-wireframe"
      viewBox={`${-half} 0 ${half * 2} ${top + 0.04}`}
      preserveAspectRatio="xMidYMid meet"
      className="lp-wireframe pointer-events-none absolute inset-x-0 bottom-[8%] top-[6%] m-auto h-[86%] w-full text-fg-3 transition-opacity duration-500"
      style={{ opacity: fading ? 0 : 1 }}
      fill="none"
      stroke="currentColor"
      strokeWidth={0.004}
    >
      <g className="lp-draw">
        <rect x={-baseWidth / 2} y={y(shape.baseTop)} width={baseWidth} height={shape.baseTop} rx={0.03} pathLength={1} />
        <rect x={baseWidth / 2 - 0.095} y={y(shape.baseTop * 0.81)} width={0.05} height={shape.baseTop * 0.62} pathLength={1} />
        {shape.columnX.map(x => (
          <rect key={x} x={x - 0.0225} y={y(shape.height)} width={0.045} height={shape.height - shape.baseTop} rx={0.012} pathLength={1} />
        ))}
        {[-1, 1].map(side => (
          <line key={side} x1={side * (baseWidth / 2 + 0.02)} x2={side * (baseWidth / 2 + 0.02)} y1={y(0)} y2={y(shape.height + 0.06)} pathLength={1} />
        ))}
      </g>
      {places.map((p, i) => {
        const s = status.get(p.slot) ?? 'empty'
        return (
          <circle
            key={p.slot}
            cx={p.x + p.side * 0.012}
            cy={y(p.y + 0.02)}
            r={0.03}
            className="lp-pod-in"
            style={{ animationDelay: `${300 + i * 18}ms`, fill: STATUS_FILL[s], fillOpacity: s === 'empty' ? 0 : 0.35 }}

          />
        )
      })}
    </svg>
  )
}
