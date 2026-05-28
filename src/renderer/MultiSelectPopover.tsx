import { useEffect, useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import {
  createFlow,
  findConnectionBetween,
  generateUniqueFlowName,
} from '../parser/textMutations';
import type { LayoutNode } from '../types';

/**
 * Floating popover that appears when exactly two components are selected.
 * Offers a flow-creation form on the connection between them; if no such
 * connection exists, surfaces an error instead.
 *
 * Position is computed once per render at the midpoint of the two selected
 * nodes' centers. The caller passes the current pan/zoom/canvas-rect via
 * `transform` so we can convert diagram coords → screen coords without
 * subscribing to high-frequency state.
 */
export interface PopoverTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export default function MultiSelectPopover({
  transform,
}: {
  transform: PopoverTransform | null;
}) {
  const ast = useFlowStore((s) => s.ast);
  const layout = useFlowStore((s) => s.layout);
  const selectedIds = useFlowStore((s) => s.selectedIds);
  const selectionKind = useFlowStore((s) => s.selectionKind);

  if (
    !ast ||
    !layout ||
    !transform ||
    selectionKind !== 'component' ||
    selectedIds.length !== 2
  ) {
    return null;
  }
  const [firstId, secondId] = selectedIds;
  const firstNode = layout.nodes.find((n) => n.id === firstId);
  const secondNode = layout.nodes.find((n) => n.id === secondId);
  if (!firstNode || !secondNode) return null;

  const screenPos = midpointToScreen(firstNode, secondNode, transform);

  return (
    <div
      style={{
        position: 'absolute',
        left: screenPos.x,
        top: screenPos.y,
        transform: 'translate(-50%, -50%)',
        zIndex: 11,
      }}
      // Keep canvas pointer handlers from firing through the popover.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <FlowCreateCard firstId={firstId!} secondId={secondId!} />
    </div>
  );
}

function midpointToScreen(
  a: LayoutNode,
  b: LayoutNode,
  t: PopoverTransform,
): { x: number; y: number } {
  const mx = (a.x + a.width / 2 + b.x + b.width / 2) / 2;
  const my = (a.y + a.height / 2 + b.y + b.height / 2) / 2;
  return { x: mx * t.scale + t.offsetX, y: my * t.scale + t.offsetY };
}

function FlowCreateCard({ firstId, secondId }: { firstId: string; secondId: string }) {
  const ast = useFlowStore((s) => s.ast)!;
  const setSelection = useFlowStore((s) => s.setSelection);
  const clearSelection = useFlowStore((s) => s.clearSelection);

  const match = findConnectionBetween(ast, firstId, secondId);

  // Initial form state. Re-derived when the connection changes.
  const [name, setName] = useState(() => generateUniqueFlowName(ast));
  const [data, setData] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [continuous, setContinuous] = useState(true);
  const [everyMs, setEveryMs] = useState(1000);
  const [traverseMs, setTraverseMs] = useState(1500);
  const [direction, setDirection] = useState<'forward' | 'reverse'>(
    match?.reverseToMatchOrder ? 'reverse' : 'forward',
  );

  // Sync direction when the matched connection changes (e.g. user re-selected).
  useEffect(() => {
    if (match) setDirection(match.reverseToMatchOrder ? 'reverse' : 'forward');
  }, [match?.connection.id, match?.reverseToMatchOrder]);

  if (!match) {
    return (
      <Card>
        <Header label="No route" />
        <p style={{ fontSize: 12, color: '#475569', margin: '0 0 10px' }}>
          No connection exists between <code style={codeStyle}>{firstId}</code> and{' '}
          <code style={codeStyle}>{secondId}</code>. Drag a handle from one to the other to
          create a connection first.
        </p>
        <button type="button" onClick={clearSelection} style={primaryButtonStyle}>
          Dismiss
        </button>
      </Card>
    );
  }

  const conn = match.connection;
  const create = () => {
    const trimmedName = name.trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmedName)) return;
    const { sourceText, setSourceText, ast: latestAst } = useFlowStore.getState();
    if (!latestAst) return;
    // Collision check at submit time so the name field can show errors later.
    const taken = new Set<string>([
      ...latestAst.components.map((c) => c.id),
      ...latestAst.groups.map((g) => g.id),
      ...latestAst.connections.map((c) => c.id),
      ...latestAst.flows.map((f) => f.name),
    ]);
    if (taken.has(trimmedName)) return;
    const updated = createFlow(sourceText, latestAst, {
      name: trimmedName,
      connection: conn.id,
      data: data.trim() ? data.trim() : null,
      color,
      hasRate: continuous,
      intervalMs: everyMs,
      traverseTimeMs: traverseMs,
      direction,
    });
    if (updated !== sourceText) setSourceText(updated);
    setSelection(trimmedName, 'flow');
  };

  return (
    <Card>
      <Header label="Create flow" />
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
        on <code style={codeStyle}>{conn.id.startsWith('_conn_') ? `${conn.source} → ${conn.target}` : conn.id}</code>
      </div>
      <FieldRow label="Name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={textInputStyle}
        />
      </FieldRow>
      <FieldRow label="Data label">
        <input
          type="text"
          value={data}
          placeholder="(none)"
          onChange={(e) => setData(e.target.value)}
          style={textInputStyle}
        />
      </FieldRow>
      <FieldRow label="Color">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="color"
            value={color ? '#' + color.replace(/^#/, '') : '#ffffff'}
            onChange={(e) => setColor(e.target.value.replace(/^#/, ''))}
            style={{
              width: 32,
              height: 28,
              border: '1px solid #cbd5e1',
              borderRadius: 4,
              padding: 0,
              cursor: 'pointer',
            }}
          />
          <code style={{ font: '11px ui-monospace, monospace', color: '#475569', flex: 1 }}>
            {color ? '#' + color : '(none)'}
          </code>
          {color && (
            <button type="button" onClick={() => setColor(null)} style={smallButtonStyle}>
              Clear
            </button>
          )}
        </div>
      </FieldRow>
      <FieldRow label="Direction">
        <Segmented
          options={[
            { value: 'forward', label: 'Forward' },
            { value: 'reverse', label: 'Reverse' },
          ]}
          value={direction}
          onChange={(v) => setDirection(v as 'forward' | 'reverse')}
        />
      </FieldRow>
      <FieldRow label="Traverse time (ms)">
        <input
          type="number"
          min={50}
          value={traverseMs}
          onChange={(e) => setTraverseMs(Math.max(50, Number(e.target.value) || 50))}
          style={textInputStyle}
        />
      </FieldRow>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={continuous}
          onChange={(e) => setContinuous(e.target.checked)}
        />
        <span style={{ color: '#475569', fontSize: 12 }}>Re-spawn on interval</span>
      </label>
      {continuous && (
        <FieldRow label="Every (ms)">
          <input
            type="number"
            min={30}
            value={everyMs}
            onChange={(e) => setEveryMs(Math.max(30, Number(e.target.value) || 30))}
            style={textInputStyle}
          />
        </FieldRow>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button type="button" onClick={create} style={primaryButtonStyle}>
          Create flow
        </button>
        <button type="button" onClick={clearSelection} style={smallButtonStyle}>
          Cancel
        </button>
      </div>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: 260,
        background: '#ffffff',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.18)',
        padding: 12,
        font: '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        color: '#1e293b',
      }}
    >
      {children}
    </div>
  );
}

function Header({ label }: { label: string }) {
  return (
    <div
      style={{
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: '#64748b',
        marginBottom: 10,
      }}
    >
      {label}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
      <span style={{ fontSize: 11, color: '#64748b' }}>{label}</span>
      {children}
    </label>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div style={{ display: 'flex', border: '1px solid #cbd5e1', borderRadius: 4, overflow: 'hidden' }}>
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              flex: 1,
              font: '12px inherit',
              padding: '6px 4px',
              border: 'none',
              borderLeft: i === 0 ? 'none' : '1px solid #cbd5e1',
              background: active ? '#3b82f6' : '#f8fafc',
              color: active ? '#ffffff' : '#475569',
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

const textInputStyle: React.CSSProperties = {
  font: 'inherit',
  padding: '6px 8px',
  border: '1px solid #cbd5e1',
  borderRadius: 4,
  outline: 'none',
  background: '#f8fafc',
};

const codeStyle: React.CSSProperties = {
  font: '11px ui-monospace, SF Mono, Menlo, monospace',
  color: '#0f172a',
  background: '#f1f5f9',
  padding: '1px 4px',
  borderRadius: 3,
};

const primaryButtonStyle: React.CSSProperties = {
  font: '12px inherit',
  background: '#3b82f6',
  color: '#ffffff',
  border: 'none',
  borderRadius: 4,
  padding: '6px 10px',
  cursor: 'pointer',
  fontWeight: 600,
};

const smallButtonStyle: React.CSSProperties = {
  font: '11px inherit',
  background: 'transparent',
  border: '1px solid #cbd5e1',
  borderRadius: 4,
  padding: '6px 8px',
  cursor: 'pointer',
  color: '#475569',
};
