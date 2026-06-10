import { useEffect, useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import {
  createFlow,
  createFlowChain,
  findConnectionBetween,
  findShortestComponentPath,
  generateUniqueFlowName,
  generateUniqueGroupId,
  wrapInPackage,
} from '../parser/textMutations';
import type { FlowPathHop } from '../parser/textMutations';
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
    selectedIds.length < 2
  ) {
    return null;
  }
  const selectedNodes = selectedIds
    .map((id) => layout.nodes.find((n) => n.id === id))
    .filter((n): n is LayoutNode => !!n);
  if (selectedNodes.length < 2) return null;

  const screenPos = centroidToScreen(selectedNodes, transform);
  const exactlyTwo = selectedIds.length === 2;

  return (
    <div
      style={{
        position: 'absolute',
        left: screenPos.x,
        top: screenPos.y,
        transform: 'translate(-50%, -50%)',
        zIndex: 11,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {exactlyTwo && <FlowCreateCard firstId={selectedIds[0]!} secondId={selectedIds[1]!} />}
      <WrapInPackageCard ids={selectedIds} />
    </div>
  );
}

function centroidToScreen(nodes: LayoutNode[], t: PopoverTransform): { x: number; y: number } {
  let sx = 0, sy = 0;
  for (const n of nodes) {
    sx += n.x + n.width / 2;
    sy += n.y + n.height / 2;
  }
  const mx = sx / nodes.length;
  const my = sy / nodes.length;
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
  // Held as raw text so the user can type freely; coerced on Create.
  const [everyMs, setEveryMs] = useState('1000');
  const [speedPx, setSpeedPx] = useState('150');
  const [direction, setDirection] = useState<'forward' | 'reverse'>(
    match?.reverseToMatchOrder ? 'reverse' : 'forward',
  );
  const [stage, setStage] = useState<string>(''); // '' = no stage

  // Sync direction when the matched connection changes (e.g. user re-selected).
  useEffect(() => {
    if (match) setDirection(match.reverseToMatchOrder ? 'reverse' : 'forward');
  }, [match?.connection.id, match?.reverseToMatchOrder]);

  if (!match) {
    // No direct connection — see if the two are linked indirectly and offer a
    // relay along the shortest route through existing connections.
    const path = findShortestComponentPath(ast, firstId, secondId);
    if (path && path.length > 0) {
      return <RelayCreateCard firstId={firstId} hops={path} />;
    }
    return (
      <Card>
        <Header label="No route" />
        <p style={{ fontSize: 12, color: '#475569', margin: '0 0 10px' }}>
          No path exists between <code style={codeStyle}>{firstId}</code> and{' '}
          <code style={codeStyle}>{secondId}</code> through existing connections. Drag a handle
          from one to the other to create a connection first.
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
      intervalMs: toMs(everyMs, 30, 1000),
      speedPxPerSec: toMs(speedPx, 10, 150),
      direction,
      stage: stage === '' ? null : stage,
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
      <FieldRow label="Stage">
        <select
          value={stage}
          onChange={(e) => setStage(e.target.value)}
          style={{ ...textInputStyle, padding: '5px 6px' }}
        >
          <option value="">(no stage)</option>
          {ast.stages.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
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
      <FieldRow label="Speed (px/s)">
        <input
          type="number"
          min={10}
          value={speedPx}
          onChange={(e) => setSpeedPx(e.target.value)}
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
            onChange={(e) => setEveryMs(e.target.value)}
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

/**
 * Shown when the two selected components have no direct connection but ARE
 * linked through a chain of existing connections. Creates a relay: one flow
 * per hop, each firing when the previous arrives, tracing the shortest route.
 */
function RelayCreateCard({
  firstId,
  hops,
}: {
  firstId: string;
  hops: FlowPathHop[];
}) {
  const ast = useFlowStore((s) => s.ast)!;
  const setSelection = useFlowStore((s) => s.setSelection);
  const clearSelection = useFlowStore((s) => s.clearSelection);

  const [prefix, setPrefix] = useState('relay');
  const [data, setData] = useState('');
  const [continuous, setContinuous] = useState(true);
  // Held as raw text so the user can type freely; coerced on Create.
  const [everyMs, setEveryMs] = useState('1000');
  const [speedPx, setSpeedPx] = useState('150');

  // Route as display names: start node followed by each hop's destination.
  const nameOf = (id: string) => ast.components.find((c) => c.id === id)?.displayName ?? id;
  const routeIds = [firstId, ...hops.map((h) => h.to)];

  const create = () => {
    const trimmedPrefix = prefix.trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmedPrefix)) return;
    const { sourceText, setSourceText, ast: latestAst } = useFlowStore.getState();
    if (!latestAst) return;
    const { text: updated, flowNames } = createFlowChain(sourceText, latestAst, {
      hops,
      namePrefix: trimmedPrefix,
      data: data.trim() ? data.trim() : null,
      continuous,
      intervalMs: toMs(everyMs, 30, 1000),
      speedPxPerSec: toMs(speedPx, 10, 150),
    });
    if (updated !== sourceText) setSourceText(updated);
    if (flowNames[0]) setSelection(flowNames[0], 'flow');
  };

  return (
    <Card>
      <Header label={`Relay flow · ${hops.length} hops`} />
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8, lineHeight: 1.5 }}>
        {routeIds.map((id, i) => (
          <span key={`${id}-${i}`}>
            {i > 0 && <span style={{ color: '#94a3b8' }}> → </span>}
            <code style={codeStyle}>{nameOf(id)}</code>
          </span>
        ))}
      </div>
      <FieldRow label="Name prefix">
        <input
          type="text"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
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
      <FieldRow label="Speed (px/s)">
        <input
          type="number"
          min={10}
          value={speedPx}
          onChange={(e) => setSpeedPx(e.target.value)}
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
            onChange={(e) => setEveryMs(e.target.value)}
            style={textInputStyle}
          />
        </FieldRow>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button type="button" onClick={create} style={primaryButtonStyle}>
          Create relay
        </button>
        <button type="button" onClick={clearSelection} style={smallButtonStyle}>
          Cancel
        </button>
      </div>
    </Card>
  );
}

function WrapInPackageCard({ ids }: { ids: string[] }) {
  const ast = useFlowStore((s) => s.ast)!;
  const setSelection = useFlowStore((s) => s.setSelection);
  const clearSelection = useFlowStore((s) => s.clearSelection);

  const [packageId, setPackageId] = useState(() => generateUniqueGroupId(ast));
  const [displayName, setDisplayName] = useState(() => titleCaseFromId(packageId));

  const create = () => {
    const trimmedId = packageId.trim();
    const trimmedName = displayName.trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmedId) || trimmedName === '') return;
    const { sourceText, setSourceText, ast: latestAst } = useFlowStore.getState();
    if (!latestAst) return;
    const taken = new Set<string>([
      ...latestAst.components.map((c) => c.id),
      ...latestAst.groups.map((g) => g.id),
      ...latestAst.connections.map((c) => c.id),
      ...latestAst.flows.map((f) => f.name),
    ]);
    if (taken.has(trimmedId)) return;
    const updated = wrapInPackage(sourceText, latestAst, ids, trimmedId, trimmedName);
    if (updated !== sourceText) setSourceText(updated);
    setSelection(trimmedId, 'group');
  };

  return (
    <Card>
      <Header label={`Wrap ${ids.length} components`} />
      <FieldRow label="Package id">
        <input
          type="text"
          value={packageId}
          onChange={(e) => setPackageId(e.target.value)}
          style={textInputStyle}
        />
      </FieldRow>
      <FieldRow label="Display name">
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          style={textInputStyle}
        />
      </FieldRow>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button type="button" onClick={create} style={primaryButtonStyle}>
          Wrap in package
        </button>
        <button type="button" onClick={clearSelection} style={smallButtonStyle}>
          Cancel
        </button>
      </div>
    </Card>
  );
}

/** Turn `group1` into `Group 1`. Cheap auto-title for the display field. */
function titleCaseFromId(id: string): string {
  const m = id.match(/^([a-zA-Z]+)(\d+)$/);
  if (m) return m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1) + ' ' + m[2]!;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Coerce a free-text ms field to a valid number on submit: round, enforce a
 *  floor, and fall back to a default for empty/garbage input. */
function toMs(raw: string, min: number, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, n);
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
