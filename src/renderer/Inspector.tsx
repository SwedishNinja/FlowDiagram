import { useEffect, useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import {
  deleteComponent,
  deleteConnection,
  deleteFlow,
  deleteGroup,
  renameComponent,
  renameConnection,
  renameFlow,
  renameGroup,
  reorderFlowsInStage,
  ungroupPackage,
  updateComponent,
  updateConnection,
  updateFlow,
  updateGroup,
} from '../parser/textMutations';
import type { ComponentNode, ConnectionNode, FlowNode, GroupNode, StageNode } from '../types';

/**
 * Floating right-side panel that surfaces editable fields for the currently
 * selected entity. Components, connections, and flows each render their own
 * field set; the panel hides when nothing is selected.
 */
export default function Inspector() {
  const ast = useFlowStore((s) => s.ast);
  const selectedIds = useFlowStore((s) => s.selectedIds);
  const selectionKind = useFlowStore((s) => s.selectionKind);

  // Multi-selection of components is handled by a separate popover, not this
  // panel. Single-selection is the only case where we render here.
  if (!ast || selectedIds.length !== 1 || !selectionKind) return null;
  const selectedId = selectedIds[0]!;

  let body: React.ReactNode = null;
  if (selectionKind === 'component') {
    const comp = ast.components.find((c) => c.id === selectedId);
    if (comp) body = <ComponentInspector comp={comp} />;
  } else if (selectionKind === 'connection') {
    const conn = ast.connections.find((c) => c.id === selectedId);
    if (conn) body = <ConnectionInspector conn={conn} />;
  } else if (selectionKind === 'flow') {
    const flow = ast.flows.find((f) => f.name === selectedId);
    if (flow) body = <FlowInspector flow={flow} />;
  } else if (selectionKind === 'group') {
    const group = ast.groups.find((g) => g.id === selectedId);
    if (group) body = <GroupInspector group={group} />;
  } else if (selectionKind === 'stage') {
    const stage = ast.stages.find((s) => s.name === selectedId);
    if (stage) body = <StageInspector stage={stage} />;
  }
  if (!body) return null;

  return (
    <div
      key={`${selectionKind}-${selectedId}`}
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 260,
        background: '#ffffff',
        borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
        padding: 12,
        zIndex: 10,
        font: '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        color: '#1e293b',
      }}
    >
      {body}
    </div>
  );
}

function ComponentInspector({ comp }: { comp: ComponentNode }) {
  const setSelection = useFlowStore((s) => s.setSelection);
  const clearSelection = useFlowStore((s) => s.clearSelection);
  const commit = (updates: Parameters<typeof updateComponent>[3]) => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = updateComponent(sourceText, ast, comp.id, updates);
    if (next !== sourceText) setSourceText(next);
  };
  const cascadeDelete = () => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = deleteComponent(sourceText, ast, comp.id);
    if (next !== sourceText) setSourceText(next);
    clearSelection();
  };
  const commitRename = (raw: string) => {
    const newId = raw.trim();
    if (newId === comp.id) return;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newId)) return;
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const taken = new Set<string>([
      ...ast.components.map((c) => c.id),
      ...ast.groups.map((g) => g.id),
      ...ast.connections.map((c) => c.id),
      ...ast.flows.map((f) => f.name),
    ]);
    taken.delete(comp.id);
    if (taken.has(newId)) return;
    const next = renameComponent(sourceText, ast, comp.id, newId);
    if (next !== sourceText) {
      setSourceText(next);
      setSelection(newId, 'component');
    }
  };
  return (
    <>
      <Header label="Component" id={comp.id} />
      <FieldRow label="Name">
        <CommitTextInput
          initial={comp.id}
          placeholder="alias"
          onCommit={commitRename}
        />
      </FieldRow>
      <FieldRow label="Display name">
        <CommitTextInput
          initial={comp.displayName}
          placeholder="Display name"
          onCommit={(v) => commit({ displayName: v })}
        />
      </FieldRow>
      <FieldRow label="Color">
        <ColorField value={comp.color} onCommit={(v) => commit({ color: v })} />
      </FieldRow>
      <FieldRow label="Stereotype">
        <CommitTextInput
          initial={comp.stereotype ?? ''}
          placeholder="(none)"
          onCommit={(v) => commit({ stereotype: v.trim() === '' ? null : v.trim() })}
        />
      </FieldRow>
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button type="button" onClick={cascadeDelete} style={dangerButtonStyle}>
          Delete component
        </button>
      </div>
    </>
  );
}

function ConnectionInspector({ conn }: { conn: ConnectionNode }) {
  const flows = useFlowStore((s) => s.ast?.flows ?? []);
  const setSelection = useFlowStore((s) => s.setSelection);
  const clearSelection = useFlowStore((s) => s.clearSelection);

  const commit = (updates: Parameters<typeof updateConnection>[3]) => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = updateConnection(sourceText, ast, conn.id, updates);
    if (next !== sourceText) setSourceText(next);
  };

  const cascadeDelete = () => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = deleteConnection(sourceText, ast, conn.id);
    if (next !== sourceText) setSourceText(next);
    clearSelection();
  };

  const commitRename = (raw: string) => {
    const newId = raw.trim();
    if (newId === conn.id) return;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newId)) return;
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const taken = new Set<string>([
      ...ast.components.map((c) => c.id),
      ...ast.groups.map((g) => g.id),
      ...ast.connections.map((c) => c.id),
      ...ast.flows.map((f) => f.name),
    ]);
    taken.delete(conn.id);
    if (taken.has(newId)) return;
    const next = renameConnection(sourceText, ast, conn.id, newId);
    if (next !== sourceText) {
      setSourceText(next);
      setSelection(newId, 'connection');
    }
  };

  const arrowKey = arrowKeyFor(conn.lineStyle, conn.arrowStyle);
  const flowsOnThis = flows.filter((f) => f.connection === conn.id);
  const isAutoId = conn.id.startsWith('_conn_');

  return (
    <>
      <Header label="Connection" id={`${conn.source} → ${conn.target}`} />
      <FieldRow label="Name">
        <CommitTextInput
          initial={isAutoId ? '' : conn.id}
          placeholder={isAutoId ? 'unnamed — add an alias' : 'alias'}
          onCommit={commitRename}
        />
      </FieldRow>
      <FieldRow label="Label">
        <CommitTextInput
          initial={conn.label ?? ''}
          placeholder="(none)"
          onCommit={(v) => commit({ label: v.trim() === '' ? null : v })}
        />
      </FieldRow>
      <FieldRow label="Arrow">
        <SegmentedControl
          options={[
            { value: 'forward', label: '→', title: 'Solid forward (->)' },
            { value: 'long', label: '⟶', title: 'Solid long (-->)' },
            { value: 'dotted', label: '⇢', title: 'Dotted forward (..>)' },
            { value: 'bidirectional', label: '↔', title: 'Bidirectional (<->)' },
          ]}
          value={arrowKey}
          onChange={(next) => commit(arrowUpdatesFor(next))}
        />
      </FieldRow>
      {flowsOnThis.length > 0 && (
        <FieldRow label="Flows">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {flowsOnThis.map((f) => (
              <button
                key={f.name}
                type="button"
                onClick={() => setSelection(f.name, 'flow')}
                style={chipStyle}
              >
                {f.name}
              </button>
            ))}
          </div>
        </FieldRow>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button type="button" onClick={cascadeDelete} style={dangerButtonStyle}>
          Delete connection{flowsOnThis.length > 0 ? ' + flows' : ''}
        </button>
      </div>
    </>
  );
}

function GroupInspector({ group }: { group: GroupNode }) {
  const setSelection = useFlowStore((s) => s.setSelection);
  const clearSelection = useFlowStore((s) => s.clearSelection);
  const commit = (updates: Parameters<typeof updateGroup>[3]) => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = updateGroup(sourceText, ast, group.id, updates);
    if (next !== sourceText) setSourceText(next);
  };
  const commitRename = (raw: string) => {
    const newId = raw.trim();
    if (newId === group.id) return;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newId)) return;
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const taken = new Set<string>([
      ...ast.components.map((c) => c.id),
      ...ast.groups.map((g) => g.id),
      ...ast.connections.map((c) => c.id),
      ...ast.flows.map((f) => f.name),
    ]);
    taken.delete(group.id);
    if (taken.has(newId)) return;
    const next = renameGroup(sourceText, ast, group.id, newId);
    if (next !== sourceText) {
      setSourceText(next);
      setSelection(newId, 'group');
    }
  };
  const ungroup = () => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = ungroupPackage(sourceText, ast, group.id);
    if (next !== sourceText) setSourceText(next);
    clearSelection();
  };
  const cascadeDelete = () => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = deleteGroup(sourceText, ast, group.id);
    if (next !== sourceText) setSourceText(next);
    clearSelection();
  };
  return (
    <>
      <Header label="Package" id={group.id} />
      <FieldRow label="Name">
        <CommitTextInput
          initial={group.id}
          placeholder="alias"
          onCommit={commitRename}
        />
      </FieldRow>
      <FieldRow label="Display name">
        <CommitTextInput
          initial={group.displayName}
          placeholder="Display name"
          onCommit={(v) => commit({ displayName: v })}
        />
      </FieldRow>
      <FieldRow label="Color">
        <ColorField value={group.color} onCommit={(v) => commit({ color: v })} />
      </FieldRow>
      <FieldRow label="Collapse at (px)">
        <CollapseAtField
          initial={group.collapseAtPx}
          onCommit={(v) => commit({ collapseAtPx: v })}
        />
      </FieldRow>
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button type="button" onClick={ungroup} style={{
          font: '11px inherit',
          background: 'transparent',
          border: '1px solid #cbd5e1',
          borderRadius: 4,
          padding: '6px 10px',
          cursor: 'pointer',
          color: '#475569',
        }}>
          Ungroup
        </button>
        <button type="button" onClick={cascadeDelete} style={dangerButtonStyle}>
          Delete with contents
        </button>
      </div>
    </>
  );
}

function CollapseAtField({
  initial,
  onCommit,
}: {
  initial: number | undefined;
  onCommit: (value: number | null) => void;
}) {
  const [value, setValue] = useState(initial === undefined ? '' : String(initial));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setValue(initial === undefined ? '' : String(initial));
  }, [initial, focused]);
  const commit = () => {
    const trimmed = value.trim();
    if (trimmed === '') {
      if (initial !== undefined) onCommit(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) {
      setValue(initial === undefined ? '' : String(initial));
      return;
    }
    if (n !== initial) onCommit(n);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="number"
        min={20}
        value={value}
        placeholder="(inherit default)"
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            setValue(initial === undefined ? '' : String(initial));
            e.currentTarget.blur();
          }
        }}
        style={{ ...textInputStyle, flex: 1 }}
      />
      {initial !== undefined && (
        <button
          type="button"
          onClick={() => onCommit(null)}
          style={{
            font: '11px inherit',
            background: 'transparent',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
            padding: '3px 6px',
            cursor: 'pointer',
            color: '#475569',
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}

function FlowInspector({ flow }: { flow: FlowNode }) {
  const setSelection = useFlowStore((s) => s.setSelection);
  const clearSelection = useFlowStore((s) => s.clearSelection);

  const commit = (updates: Parameters<typeof updateFlow>[3]) => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = updateFlow(sourceText, ast, flow.name, updates);
    if (next !== sourceText) setSourceText(next);
  };

  const deleteThis = () => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = deleteFlow(sourceText, ast, flow.name);
    if (next !== sourceText) setSourceText(next);
    clearSelection();
  };

  const commitRename = (rawNew: string) => {
    const newName = rawNew.trim();
    if (newName === flow.name) return;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newName)) return;
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const taken = new Set<string>([
      ...ast.components.map((c) => c.id),
      ...ast.groups.map((g) => g.id),
      ...ast.connections.map((c) => c.id),
      ...ast.flows.map((f) => f.name),
    ]);
    taken.delete(flow.name);
    if (taken.has(newName)) return;
    const next = renameFlow(sourceText, ast, flow.name, newName);
    if (next !== sourceText) {
      setSourceText(next);
      setSelection(newName, 'flow');
    }
  };

  return (
    <>
      <Header label="Flow" id={flow.name} />
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
        on{' '}
        <button
          type="button"
          onClick={() => setSelection(flow.connection, 'connection')}
          style={inlineLinkStyle}
        >
          {flow.connection}
        </button>
        {flow.stage && (
          <>
            {' · in stage '}
            <button
              type="button"
              onClick={() => setSelection(flow.stage!, 'stage')}
              style={inlineLinkStyle}
            >
              {flow.stage}
            </button>
          </>
        )}
      </div>
      <FieldRow label="Name">
        <CommitTextInput
          initial={flow.name}
          placeholder="flow identifier"
          onCommit={commitRename}
        />
      </FieldRow>
      <FieldRow label="Data label">
        <CommitTextInput
          initial={flow.data ?? ''}
          placeholder="(none)"
          onCommit={(v) => commit({ data: v.trim() === '' ? null : v })}
        />
      </FieldRow>
      <FieldRow label="Color">
        <ColorField value={flow.color} onCommit={(v) => commit({ color: v })} />
      </FieldRow>
      <FieldRow label="Direction">
        <SegmentedControl
          options={[
            { value: 'forward', label: 'Forward' },
            { value: 'reverse', label: 'Reverse' },
          ]}
          value={flow.direction}
          onChange={(v) => commit({ direction: v as 'forward' | 'reverse' })}
        />
      </FieldRow>
      <FieldRow label="Traverse time (ms)">
        <CommitNumberInput
          initial={Math.round(flow.traverseTimeMs)}
          min={50}
          onCommit={(v) => commit({ traverseTimeMs: v })}
        />
      </FieldRow>
      <FieldRow label="Continuous">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={!!flow.hasRate}
            onChange={(e) => commit({ hasRate: e.target.checked })}
          />
          <span style={{ color: '#475569' }}>Re-spawn on interval</span>
        </label>
      </FieldRow>
      {flow.hasRate && (
        <FieldRow label="Every (ms)">
          <CommitNumberInput
            initial={Math.round(flow.intervalMs)}
            min={30}
            onCommit={(v) => commit({ intervalMs: v })}
          />
        </FieldRow>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button type="button" onClick={deleteThis} style={dangerButtonStyle}>
          Delete flow
        </button>
      </div>
    </>
  );
}

function StageInspector({ stage }: { stage: StageNode }) {
  const setSelection = useFlowStore((s) => s.setSelection);

  const reorder = (from: number, to: number) => {
    if (to < 0 || to >= stage.flowNames.length || to === from) return;
    const newOrder = [...stage.flowNames];
    const [moved] = newOrder.splice(from, 1);
    newOrder.splice(to, 0, moved!);
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = reorderFlowsInStage(sourceText, ast, stage.name, newOrder);
    if (next !== sourceText) setSourceText(next);
  };

  return (
    <>
      <Header label="Stage" id={stage.name} />
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
        {stage.repeat ? 'repeats' : 'runs once'}
        {stage.after.length > 0 && ` · after ${stage.after.join(', ')}`}
      </div>
      <FieldRow label="Flows (in order)">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {stage.flowNames.length === 0 && (
            <div style={{ fontSize: 11, color: '#94a3b8' }}>(no flows in this stage)</div>
          )}
          {stage.flowNames.map((name, i) => (
            <div
              key={name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 6px',
                border: '1px solid #e2e8f0',
                borderRadius: 4,
                background: '#f8fafc',
              }}
            >
              <button
                type="button"
                onClick={() => setSelection(name, 'flow')}
                style={{
                  ...inlineLinkStyle,
                  flex: 1,
                  textAlign: 'left',
                  textDecoration: 'none',
                  color: '#1e293b',
                }}
              >
                {name}
              </button>
              <button
                type="button"
                onClick={() => reorder(i, i - 1)}
                disabled={i === 0}
                title="Move up"
                style={arrowButtonStyle(i === 0)}
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => reorder(i, i + 1)}
                disabled={i === stage.flowNames.length - 1}
                title="Move down"
                style={arrowButtonStyle(i === stage.flowNames.length - 1)}
              >
                ↓
              </button>
            </div>
          ))}
        </div>
      </FieldRow>
    </>
  );
}

function arrowButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    font: '12px inherit',
    background: 'transparent',
    border: '1px solid #cbd5e1',
    borderRadius: 4,
    padding: '2px 8px',
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? '#cbd5e1' : '#475569',
  };
}

function arrowKeyFor(
  lineStyle: 'solid' | 'dotted',
  arrowStyle: 'forward' | 'long' | 'bidirectional',
): 'forward' | 'long' | 'dotted' | 'bidirectional' {
  if (lineStyle === 'dotted') return 'dotted';
  if (arrowStyle === 'bidirectional') return 'bidirectional';
  if (arrowStyle === 'long') return 'long';
  return 'forward';
}

function arrowUpdatesFor(key: string): { lineStyle: 'solid' | 'dotted'; arrowStyle: 'forward' | 'long' | 'bidirectional' } {
  switch (key) {
    case 'dotted': return { lineStyle: 'dotted', arrowStyle: 'forward' };
    case 'bidirectional': return { lineStyle: 'solid', arrowStyle: 'bidirectional' };
    case 'long': return { lineStyle: 'solid', arrowStyle: 'long' };
    default: return { lineStyle: 'solid', arrowStyle: 'forward' };
  }
}

function Header({ label, id }: { label: string; id: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBottom: 10,
        gap: 8,
      }}
    >
      <span
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: '#64748b',
        }}
      >
        {label}
      </span>
      <code
        style={{
          font: '11px ui-monospace, SF Mono, Menlo, monospace',
          color: '#475569',
          textAlign: 'right',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {id}
      </code>
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

function CommitTextInput({
  initial,
  placeholder,
  onCommit,
}: {
  initial: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setValue(initial);
  }, [initial, focused]);
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (value !== initial) onCommit(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          setValue(initial);
          e.currentTarget.blur();
        }
      }}
      style={textInputStyle}
    />
  );
}

function CommitNumberInput({
  initial,
  min,
  onCommit,
}: {
  initial: number;
  min?: number;
  onCommit: (value: number) => void;
}) {
  const [value, setValue] = useState(String(initial));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setValue(String(initial));
  }, [initial, focused]);
  return (
    <input
      type="number"
      value={value}
      min={min}
      onChange={(e) => setValue(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        const n = Number(value);
        if (!Number.isFinite(n)) {
          setValue(String(initial));
          return;
        }
        const clamped = min !== undefined ? Math.max(min, n) : n;
        if (clamped !== initial) onCommit(clamped);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          setValue(String(initial));
          e.currentTarget.blur();
        }
      }}
      style={textInputStyle}
    />
  );
}

function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string; title?: string }[];
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
            title={opt.title}
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

function ColorField({
  value,
  onCommit,
}: {
  value: string | undefined;
  onCommit: (value: string | null) => void;
}) {
  const normalized = value ? '#' + value.replace(/^#/, '') : '#ffffff';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="color"
        value={normalized}
        onChange={(e) => onCommit(e.target.value.replace(/^#/, ''))}
        style={{
          width: 32,
          height: 28,
          border: '1px solid #cbd5e1',
          borderRadius: 4,
          padding: 0,
          background: '#ffffff',
          cursor: 'pointer',
        }}
      />
      <code style={{ font: '11px ui-monospace, SF Mono, Menlo, monospace', color: '#475569', flex: 1 }}>
        {value ? '#' + value.replace(/^#/, '') : '(none)'}
      </code>
      {value && (
        <button type="button" onClick={() => onCommit(null)} style={clearButtonStyle}>
          Clear
        </button>
      )}
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

const chipStyle: React.CSSProperties = {
  font: '11px inherit',
  padding: '3px 8px',
  border: '1px solid #cbd5e1',
  borderRadius: 12,
  background: '#f8fafc',
  color: '#475569',
  cursor: 'pointer',
};

const inlineLinkStyle: React.CSSProperties = {
  font: 'inherit',
  background: 'transparent',
  border: 'none',
  padding: 0,
  color: '#3b82f6',
  cursor: 'pointer',
  textDecoration: 'underline',
};

const clearButtonStyle: React.CSSProperties = {
  font: '11px inherit',
  background: 'transparent',
  border: '1px solid #cbd5e1',
  borderRadius: 4,
  padding: '3px 6px',
  cursor: 'pointer',
  color: '#475569',
};

const dangerButtonStyle: React.CSSProperties = {
  font: '11px inherit',
  background: 'transparent',
  border: '1px solid #fca5a5',
  borderRadius: 4,
  padding: '6px 10px',
  cursor: 'pointer',
  color: '#b91c1c',
};
