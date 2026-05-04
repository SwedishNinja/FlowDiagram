import { useEffect, useRef, useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import type { AnimationController } from './animationLoop';

interface Props {
  controllerRef: React.RefObject<AnimationController | null>;
}

const ACTIVE_FLOWS_POLL_MS = 150;

/**
 * Side panel listing annotations for active flows. While playing the panel
 * shows annotations for flows that currently have live particles. While
 * paused, hovering a particle on the canvas highlights its row.
 */
export default function AnnotationsPanel({ controllerRef }: Props) {
  const ast = useFlowStore((s) => s.ast);
  const isPlaying = useFlowStore((s) => s.isPlaying);
  const hoveredFlow = useFlowStore((s) => s.hoveredFlow);

  const [activeFlows, setActiveFlows] = useState<Set<string>>(new Set());
  const rowsRef = useRef<Map<string, HTMLDivElement | null>>(new Map());

  // Poll active flows from the controller. requestAnimationFrame would
  // re-render every frame; setInterval at ~7 fps is plenty for a UI list
  // and avoids needless React work.
  useEffect(() => {
    const tick = () => {
      const flows = controllerRef.current?.getActiveFlows() ?? new Set<string>();
      setActiveFlows((prev) => {
        if (prev.size === flows.size) {
          let same = true;
          for (const f of flows) if (!prev.has(f)) { same = false; break; }
          if (same) return prev;
        }
        return flows;
      });
    };
    tick();
    const id = window.setInterval(tick, ACTIVE_FLOWS_POLL_MS);
    return () => window.clearInterval(id);
  }, [controllerRef]);

  // Scroll the hovered row into view so it's visible regardless of list length.
  useEffect(() => {
    if (!hoveredFlow) return;
    const el = rowsRef.current.get(hoveredFlow);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hoveredFlow]);

  if (!ast || ast.annotations.length === 0) return null;

  // Order annotations: when paused, hovered first; otherwise active first,
  // then idle. Inside each bucket preserve declaration order.
  const indexByTarget = new Map<string, number>();
  ast.annotations.forEach((a, i) => indexByTarget.set(a.target, i));
  const sorted = [...ast.annotations].sort((a, b) => {
    if (!isPlaying && hoveredFlow) {
      if (a.target === hoveredFlow) return -1;
      if (b.target === hoveredFlow) return 1;
    }
    const aActive = activeFlows.has(a.target);
    const bActive = activeFlows.has(b.target);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return (indexByTarget.get(a.target) ?? 0) - (indexByTarget.get(b.target) ?? 0);
  });

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        bottom: 12,
        width: 280,
        background: 'var(--surface-1, #1f2937)',
        border: '1px solid var(--line, #374151)',
        borderRadius: 6,
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: 'auto',
        zIndex: 5,
      }}
    >
      <div
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid var(--line, #374151)',
          fontSize: 'var(--fs-micro, 11px)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--ink-5, #9ca3af)',
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
        }}
      >
        <span>Annotations</span>
        <span style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontSize: 10 }}>
          {isPlaying ? `${activeFlows.size} active` : 'paused — hover a particle'}
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '8px' }}>
        {sorted.map((ann) => {
          const isActive = activeFlows.has(ann.target);
          const isHovered = !isPlaying && hoveredFlow === ann.target;
          return (
            <div
              key={`${ann.target}-${indexByTarget.get(ann.target)}`}
              ref={(el) => { rowsRef.current.set(ann.target, el); }}
              style={{
                padding: '8px 10px',
                marginBottom: 6,
                borderRadius: 4,
                background: isHovered
                  ? 'rgba(59,130,246,0.18)'
                  : isActive
                  ? 'var(--surface-2, #111827)'
                  : 'transparent',
                border: isHovered
                  ? '1px solid #3b82f6'
                  : '1px solid var(--line, #374151)',
                opacity: isActive || isHovered ? 1 : 0.45,
                transition: 'opacity 120ms, background 120ms, border-color 120ms',
              }}
            >
              <div
                style={{
                  fontSize: 'var(--fs-micro, 11px)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: isHovered ? '#93c5fd' : 'var(--ink-5, #9ca3af)',
                  marginBottom: 3,
                }}
              >
                {ann.target}
              </div>
              <div
                style={{
                  fontSize: 'var(--fs-sm, 13px)',
                  color: 'var(--ink-1, #e5e7eb)',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.45,
                }}
              >
                {ann.info}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
