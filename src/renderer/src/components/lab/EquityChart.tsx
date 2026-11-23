import { useId, useMemo, useState } from 'react';

import type { ForwardCurvePoint } from '../../../../shared/lab';
import { money, shortDate, signedPct } from './format';

const W = 960;
const H = 320;
const PAD = { top: 20, right: 72, bottom: 32, left: 8 };

interface Props {
  curve: ForwardCurvePoint[];
  initialCash: number;
  benchmark: string;
  /** Etiqueta del cursor del final: «Ahora» en una prueba viva, la fecha si está detenida. */
  nowLabel: string;
}

/**
 * Curva de capital de la prueba en vivo frente al benchmark. La línea de
 * la estrategia lleva el único acento; el benchmark va en neutro. El
 * cursor del final marca el último cierre medido.
 */
export function EquityChart({ curve, initialCash, benchmark, nowLabel }: Props) {
  const titleId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    const values = curve.flatMap((p) =>
      p.benchmark === null ? [p.equity] : [p.equity, p.benchmark],
    );
    values.push(initialCash);
    let min = Math.min(...values);
    let max = Math.max(...values);
    const span = Math.max(max - min, initialCash * 0.01);
    min -= span * 0.12;
    max += span * 0.12;
    const iw = W - PAD.left - PAD.right;
    const ih = H - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (curve.length <= 1 ? iw : (i / (curve.length - 1)) * iw);
    const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * ih;
    const path = (pick: (p: ForwardCurvePoint) => number | null) => {
      let d = '';
      curve.forEach((p, i) => {
        const v = pick(p);
        if (v === null) return;
        d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      });
      return d;
    };
    const ticks = [0, 0.5, 1].map((t) => min + (max - min) * (0.15 + t * 0.7));
    const dateTicks =
      curve.length > 2
        ? [0, Math.floor((curve.length - 1) / 2), curve.length - 1]
        : curve.map((_, i) => i);
    return {
      x,
      y,
      strategy: path((p) => p.equity),
      bench: path((p) => p.benchmark),
      ticks,
      dateTicks,
      baseY: y(initialCash),
    };
  }, [curve, initialCash]);

  if (curve.length === 0) return null;
  const last = curve[curve.length - 1]!;
  const lastX = model.x(curve.length - 1);
  const active = hover === null ? null : curve[hover];

  return (
    <figure className="lab-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby={titleId}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const px = ((event.clientX - rect.left) / rect.width) * W;
          const iw = W - PAD.left - PAD.right;
          const i = Math.round(((px - PAD.left) / iw) * (curve.length - 1));
          setHover(Math.max(0, Math.min(curve.length - 1, i)));
        }}
      >
        <title id={titleId}>
          {`Capital de la estrategia frente a ${benchmark}: ${money(last.equity)} al ${shortDate(last.date)}`}
        </title>
        {model.ticks.map((v) => (
          <g key={v} className="lab-chart-grid">
            <line x1={PAD.left} x2={W - PAD.right} y1={model.y(v)} y2={model.y(v)} />
            <text x={W - PAD.right + 8} y={model.y(v) + 4}>
              {money(v)}
            </text>
          </g>
        ))}
        <line
          className="lab-chart-base"
          x1={PAD.left}
          x2={W - PAD.right}
          y1={model.baseY}
          y2={model.baseY}
        />
        {model.dateTicks.map((i) => (
          <text
            key={i}
            className="lab-chart-date"
            x={model.x(i)}
            y={H - 8}
            textAnchor={i === 0 ? 'start' : i === curve.length - 1 ? 'end' : 'middle'}
          >
            {shortDate(curve[i]!.date)}
          </text>
        ))}
        {model.bench && <path className="lab-chart-bench" d={model.bench} />}
        <path className="lab-chart-line" d={model.strategy} />
        <line
          className="lab-chart-now"
          x1={lastX}
          x2={lastX}
          y1={PAD.top - 8}
          y2={H - PAD.bottom}
        />
        <text className="lab-chart-now-label" x={lastX - 6} y={PAD.top - 8} textAnchor="end">
          {nowLabel}
        </text>
        <circle className="lab-chart-dot" cx={lastX} cy={model.y(last.equity)} r={4} />
        {active && hover !== null && (
          <g className="lab-chart-hover">
            <line x1={model.x(hover)} x2={model.x(hover)} y1={PAD.top} y2={H - PAD.bottom} />
            <circle cx={model.x(hover)} cy={model.y(active.equity)} r={3.5} />
          </g>
        )}
      </svg>
      <figcaption className="lab-chart-legend">
        {active ? (
          <span className="lab-chart-readout">
            {shortDate(active.date)} · <b>{money(active.equity)}</b>{' '}
            {signedPct(active.equity / initialCash - 1)}
            {active.benchmark !== null &&
              ` · ${benchmark} ${signedPct(active.benchmark / initialCash - 1)}`}
          </span>
        ) : (
          <>
            <span className="lab-key lab-key-strategy">Tu estrategia</span>
            <span className="lab-key lab-key-bench">{benchmark} comprado el mismo día</span>
            <span className="lab-key lab-key-base">Capital inicial</span>
          </>
        )}
      </figcaption>
    </figure>
  );
}
