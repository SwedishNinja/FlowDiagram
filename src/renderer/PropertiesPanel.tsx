import { useState, useCallback, useEffect, useRef } from 'react';
import { useFlowStore } from '../store/flowStore';
import {
  createStage,
  deleteComponent,
  deleteConnection,
  deleteFlow,
  deleteGroup,
  deleteStage,
  generateUniqueStageName,
  moveComponent,
  moveFlowToStage,
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
  updateStage,
} from '../parser/textMutations';
import type {
  ComponentNode,
  ConnectionNode,
  FlowDocument,
  FlowNode,
  GroupNode,
  StageNode,
} from '../types';

// ── Stable empty-array selectors (avoids React 19 useSyncExternalStore loop) ──
const EMPTY_FLOWS: ReadonlyArray<FlowNode> = [];
const EMPTY_GROUPS: ReadonlyArray<GroupNode> = [];
const EMPTY_STAGES: ReadonlyArray<StageNode> = [];
function selectFlows(s: { ast: FlowDocument | null }) { return s.ast?.flows ?? EMPTY_FLOWS; }
function selectGroups(s: { ast: FlowDocument | null }) { return s.ast?.groups ?? EMPTY_GROUPS; }
function selectStages(s: { ast: FlowDocument | null }) { return s.ast?.stages ?? EMPTY_STAGES; }

// ── Layout constants ──────────────────────────────────────────────────────────
const PANEL_WIDTH = 260;
const SPLITTER_H = 5;
const SECTION_MIN = 72;
const SPLIT_KEY = 'fd-props-split';

export default function PropertiesPanel() {
  const containerRef = useRef<HTMLDivElement>(null);

  // Persisted split position (px from top of panel to splitter).
  const [splitPx, setSplitPx] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem(SPLIT_KEY) ?? '', 10);
      if (Number.isFinite(v) && v > 0) return v;
    } catch { /* ignore */ }
    return 320;
  });

  useEffect(() => {
    try { localStorage.setItem(SPLIT_KEY, String(splitPx)); } catch { /* ignore */ }
  }, [splitPx]);

  // Draggable horizontal splitter between the two sections.
  const splitDragRef = useRef<{ startY: number; startSplit: number } | null>(null);

  const handleSplitterDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    splitDragRef.current = { startY: e.clientY, startSplit: splitPx };
  }, [splitPx]);

  const handleSplitterMove = useCallback((e: React.PointerEvent) => {
    const drag = splitDragRef.current;
    if (!drag || !containerRef.current) return;
    const totalH = containerRef.current.clientHeight;
    const dy = e.clientY - drag.startY;
    const max = totalH - SPLITTER_H - SECTION_MIN;
    setSplitPx(Math.min(max, Math.max(SECTION_MIN, drag.startSplit + dy)));
  }, []);

  const handleSplitterUp = useCallback((e: React.PointerEvent) => {
    if (splitDragRef.current) {
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      splitDragRef.current = null;
    }
  }, []);

  const handleSplitterDoubleClick = useCallback(() => {
    if (!containerRef.current) return;
    setSplitPx(Math.round(containerRef.current.clientHeight / 2));
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: PANEL_WIDTH,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid var(--line)',
        background: 'var(--surface-2)',
        overflow: 'hidden',
      }}
    >
      {/* ── Properties section ── */}
      <div style={{ height: splitPx, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <SectionHeader label="Properties" />
        <div style={{ flex: 1, overflow: 'auto', padding: '10px 12px' }}>
          <PropertiesContent />
        </div>
      </div>

      {/* ── Horizontal splitter ── */}
      <div
        onPointerDown={handleSplitterDown}
        onPointerMove={handleSplitterMove}
        onPointerUp={handleSplitterUp}
        onPointerCancel={handleSplitterUp}
        onDoubleClick={handleSplitterDoubleClick}
        title="Drag to resize · double-click to reset"
        role="separator"
        aria-orientation="horizontal"
        style={{
          height: SPLITTER_H,
          flexShrink: 0,
          cursor: 'row-resize',
          background: 'var(--line)',
          touchAction: 'none',
        }}
      />

      {/* ── Stages section ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: SECTION_MIN }}>
        <StagesSectionHeader />
        <div style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
          <StagesList />
        </div>
      </div>
    </div>
  );
}

// ── Section headers ───────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <div
      className="fd-grain"
      style={{
        padding: '10px 12px 8px',
        background: 'var(--surface-1)',
        borderBottom: '1px solid var(--line)',
        flexShrink: 0,
      }}
    >
      <span className="fd-label">{label}</span>
    </div>
  );
}

function StagesSectionHeader() {
  const ast = useFlowStore((s) => s.ast);
  const setSelection = useFlowStore((s) => s.setSelection);

  const create = () => {
    const { sourceText, setSourceText, ast: doc } = useFlowStore.getState();
    if (!doc) return;
    const name = generateUniqueStageName(doc);
    const updated = createStage(sourceText, doc, { name });
    if (updated !== sourceText) {
      setSourceText(updated);
      setSelection(name, 'stage');
    }
  };

  const count = ast?.stages.length ?? 0;

  return (
    <div
      className="fd-grain"
      style={{
        padding: '8px 12px',
        background: 'var(--surface-1)',
        borderBottom: '1px solid var(--line)',
        borderTop: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
      }}
    >
      <span className="fd-label" style={{ flex: 1 }}>
        Stages{count > 0 ? ` · ${count}` : ''}
      </span>
      <button
        type="button"
        onClick={create}
        className="fd-btn fd-btn--ghost"
        style={{ height: 20, padding: '0 6px', fontSize: 'var(--fs-micro)' }}
        title="New stage"
      >
        + New
      </button>
    </div>
  );
}

// ── Stages list ───────────────────────────────────────────────────────────────

function StagesList() {
  const stages = useFlowStore(selectStages);
  const selectedIds = useFlowStore((s) => s.selectedIds);
  const selectionKind = useFlowStore((s) => s.selectionKind);
  const setSelection = useFlowStore((s) => s.setSelection);

  if (stages.length === 0) {
    return (
      <div style={{ padding: '12px', color: 'var(--ink-5)', fontSize: 'var(--fs-xs)', lineHeight: 1.55 }}>
        No stages yet.
        <br />
        Click <span style={{ color: 'var(--ink-3)' }}>+ New</span> to add one.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {stages.map((s) => {
        const active = selectionKind === 'stage' && selectedIds[0] === s.name;
        return (
          <button
            key={s.name}
            type="button"
            onClick={() => setSelection(s.name, 'stage')}
            data-active={active}
            className="fd-file"
            title={s.name}
          >
            <span className="fd-file-mark">{active ? '●' : '○'}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
            <span style={{ color: 'var(--ink-5)', fontSize: 'var(--fs-micro)', flexShrink: 0, marginLeft: 4 }}>
              {s.flowNames.length}f{s.repeat ? ' ↻' : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Properties content dispatcher ────────────────────────────────────────────

function PropertiesContent() {
  const ast = useFlowStore((s) => s.ast);
  const selectedIds = useFlowStore((s) => s.selectedIds);
  const selectionKind = useFlowStore((s) => s.selectionKind);

  if (!ast || selectedIds.length === 0 || !selectionKind) {
    return (
      <div style={{ color: 'var(--ink-5)', fontSize: 'var(--fs-xs)', paddingTop: 4, lineHeight: 1.6 }}>
        Select an item on the canvas to see its properties.
      </div>
    );
  }

  if (selectedIds.length > 1) {
    return (
      <div style={{ color: 'var(--ink-5)', fontSize: 'var(--fs-xs)', paddingTop: 4, lineHeight: 1.6 }}>
        {selectedIds.length} items selected.
        <br />
        <span style={{ color: 'var(--ink-4)' }}>Use the canvas popover to group or create a flow.</span>
      </div>
    );
  }

  const id = selectedIds[0]!;
  if (selectionKind === 'component') {
    const comp = ast.components.find((c) => c.id === id);
    if (comp) return <ComponentForm key={id} comp={comp} />;
  } else if (selectionKind === 'connection') {
    const conn = ast.connections.find((c) => c.id === id);
    if (conn) return <ConnectionForm key={id} conn={conn} />;
  } else if (selectionKind === 'flow') {
    const flow = ast.flows.find((f) => f.name === id);
    if (flow) return <FlowForm key={id} flow={flow} />;
  } else if (selectionKind === 'group') {
    const group = ast.groups.find((g) => g.id === id);
    if (group) return <GroupForm key={id} group={group} />;
  } else if (selectionKind === 'stage') {
    const stage = ast.stages.find((s) => s.name === id);
    if (stage) return <StageForm key={id} stage={stage} />;
  }

  return null;
}

// ── Component form ────────────────────────────────────────────────────────────

function ComponentForm({ comp }: { comp: ComponentNode }) {
  const setSelection = useFlowStore((s) => s.setSelection);
  const clearSelection = useFlowStore((s) => s.clearSelection);

  const commit = (updates: Parameters<typeof updateComponent>[3]) => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = updateComponent(sourceText, ast, comp.id, updates);
    if (next !== sourceText) setSourceText(next);
  };

  const commitRename = (raw: string) => {
    const newId = raw.trim();
    if (newId === comp.id || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newId)) return;
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const taken = new Set([...ast.components.map((c) => c.id), ...ast.groups.map((g) => g.id), ...ast.connections.map((c) => c.id), ...ast.flows.map((f) => f.name)]);
    taken.delete(comp.id);
    if (taken.has(newId)) return;
    const next = renameComponent(sourceText, ast, comp.id, newId);
    if (next !== sourceText) { setSourceText(next); setSelection(newId, 'component'); }
  };

  const cascadeDelete = () => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = deleteComponent(sourceText, ast, comp.id);
    if (next !== sourceText) setSourceText(next);
    clearSelection();
  };

  return (
    <>
      <KindBadge label="Component" id={comp.id} />
      <Field label="Name">
        <TextInput initial={comp.id} placeholder="alias" onCommit={commitRename} />
      </Field>
      <Field label="Display name">
        <TextInput initial={comp.displayName} placeholder="Display name" onCommit={(v) => commit({ displayName: v })} />
      </Field>
      <Field label="Color">
        <ColorInput value={comp.color} onCommit={(v) => commit({ color: v })} />
      </Field>
      <Field label="Stereotype">
        <TextInput initial={comp.stereotype ?? ''} placeholder="(none)" onCommit={(v) => commit({ stereotype: v.trim() === '' ? null : v.trim() })} />
      </Field>
      <PackageSelect comp={comp} />
      <DangerButton onClick={cascadeDelete}>Delete component</DangerButton>
    </>
  );
}

function PackageSelect({ comp }: { comp: ComponentNode }) {
  const groups = useFlowStore(selectGroups);
  const setSelection = useFlowStore((s) => s.setSelection);
  return (
    <Field label="Package">
      <select
        value={comp.parentGroup ?? ''}
        onChange={(e) => {
          const targetId = e.target.value === '' ? null : e.target.value;
          const { sourceText, setSourceText, ast } = useFlowStore.getState();
          if (!ast) return;
          const updated = moveComponent(sourceText, ast, comp.id, targetId);
          if (updated !== sourceText) { setSourceText(updated); setSelection(comp.id, 'component'); }
        }}
        disabled={groups.length === 0 && !comp.parentGroup}
        style={selectStyle}
      >
        <option value="">(no package)</option>
        {groups.map((g) => <option key={g.id} value={g.id}>{g.id}</option>)}
      </select>
    </Field>
  );
}

// ── Connection form ───────────────────────────────────────────────────────────

function ConnectionForm({ conn }: { conn: ConnectionNode }) {
  const flows = useFlowStore(selectFlows);
  const setSelection = useFlowStore((s) => s.setSelection);
  const clearSelection = useFlowStore((s) => s.clearSelection);

  const commit = (updates: Parameters<typeof updateConnection>[3]) => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = updateConnection(sourceText, ast, conn.id, updates);
    if (next !== sourceText) setSourceText(next);
  };

  const commitRename = (raw: string) => {
    const newId = raw.trim();
    if (newId === conn.id || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newId)) return;
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const taken = new Set([...ast.components.map((c) => c.id), ...ast.groups.map((g) => g.id), ...ast.connections.map((c) => c.id), ...ast.flows.map((f) => f.name)]);
    taken.delete(conn.id);
    if (taken.has(newId)) return;
    const next = renameConnection(sourceText, ast, conn.id, newId);
    if (next !== sourceText) { setSourceText(next); setSelection(newId, 'connection'); }
  };

  const cascadeDelete = () => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = deleteConnection(sourceText, ast, conn.id);
    if (next !== sourceText) setSourceText(next);
    clearSelection();
  };

  const arrowKey = arrowKeyFor(conn.lineStyle, conn.arrowStyle);
  const flowsOnThis = flows.filter((f) => f.connection === conn.id);
  const isAutoId = conn.id.startsWith('_conn_');

  return (
    <>
      <KindBadge label="Connection" id={`${conn.source} → ${conn.target}`} />
      <Field label="Name">
        <TextInput initial={isAutoId ? '' : conn.id} placeholder={isAutoId ? 'unnamed' : 'alias'} onCommit={commitRename} />
      </Field>
      <Field label="Label">
        <TextInput initial={conn.label ?? ''} placeholder="(none)" onCommit={(v) => commit({ label: v.trim() === '' ? null : v })} />
      </Field>
      <Field label="Arrow">
        <Segmented
          options={[
            { value: 'forward', label: '→', title: 'Solid forward (->)' },
            { value: 'long', label: '⟶', title: 'Long forward (-->)' },
            { value: 'dotted', label: '⇢', title: 'Dotted (..>)' },
            { value: 'bidirectional', label: '↔', title: 'Bidirectional (<->)' },
          ]}
          value={arrowKey}
          onChange={(next) => commit(arrowUpdatesFor(next))}
        />
      </Field>
      {flowsOnThis.length > 0 && (
        <Field label="Flows">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {flowsOnThis.map((f) => (
              <button key={f.name} type="button" onClick={() => setSelection(f.name, 'flow')} style={chipStyle}>
                {f.name}
              </button>
            ))}
          </div>
        </Field>
      )}
      <DangerButton onClick={cascadeDelete}>
        Delete{flowsOnThis.length > 0 ? ' + flows' : ''}
      </DangerButton>
    </>
  );
}

// ── Flow form ─────────────────────────────────────────────────────────────────

function FlowForm({ flow }: { flow: FlowNode }) {
  const stages = useFlowStore(selectStages);
  const setSelection = useFlowStore((s) => s.setSelection);
  const clearSelection = useFlowStore((s) => s.clearSelection);

  const commit = (updates: Parameters<typeof updateFlow>[3]) => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = updateFlow(sourceText, ast, flow.name, updates);
    if (next !== sourceText) setSourceText(next);
  };

  const commitRename = (rawNew: string) => {
    const newName = rawNew.trim();
    if (newName === flow.name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newName)) return;
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const taken = new Set([...ast.components.map((c) => c.id), ...ast.groups.map((g) => g.id), ...ast.connections.map((c) => c.id), ...ast.flows.map((f) => f.name)]);
    taken.delete(flow.name);
    if (taken.has(newName)) return;
    const next = renameFlow(sourceText, ast, flow.name, newName);
    if (next !== sourceText) { setSourceText(next); setSelection(newName, 'flow'); }
  };

  const deleteThis = () => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = deleteFlow(sourceText, ast, flow.name);
    if (next !== sourceText) setSourceText(next);
    clearSelection();
  };

  return (
    <>
      <KindBadge label="Flow" id={flow.name} />
      <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--ink-5)', marginBottom: 10, lineHeight: 1.5 }}>
        on{' '}
        <button type="button" onClick={() => setSelection(flow.connection, 'connection')} style={inlineLinkStyle}>
          {flow.connection}
        </button>
        {flow.stage && (
          <>
            {' · stage '}
            <button type="button" onClick={() => setSelection(flow.stage!, 'stage')} style={inlineLinkStyle}>
              {flow.stage}
            </button>
          </>
        )}
      </div>

      <Field label="Name">
        <TextInput initial={flow.name} placeholder="flow identifier" onCommit={commitRename} />
      </Field>

      <Field label="Stage">
        <select
          value={flow.stage ?? ''}
          onChange={(e) => {
            const targetName = e.target.value === '' ? null : e.target.value;
            const { sourceText, setSourceText, ast } = useFlowStore.getState();
            if (!ast) return;
            const updated = moveFlowToStage(sourceText, ast, flow.name, targetName);
            if (updated !== sourceText) { setSourceText(updated); setSelection(flow.name, 'flow'); }
          }}
          disabled={stages.length === 0 && !flow.stage}
          style={selectStyle}
        >
          <option value="">(no stage)</option>
          {stages.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
        </select>
      </Field>

      <Field label="Data label">
        <TextInput initial={flow.data ?? ''} placeholder="(none)" onCommit={(v) => commit({ data: v.trim() === '' ? null : v })} />
      </Field>
      <Field label="Color">
        <ColorInput value={flow.color} onCommit={(v) => commit({ color: v })} />
      </Field>
      <Field label="Direction">
        <Segmented
          options={[{ value: 'forward', label: 'Forward' }, { value: 'reverse', label: 'Reverse' }]}
          value={flow.direction}
          onChange={(v) => commit({ direction: v as 'forward' | 'reverse' })}
        />
      </Field>
      <Field label="Traverse time (ms)">
        <NumberInput initial={Math.round(flow.traverseTimeMs)} min={50} onCommit={(v) => commit({ traverseTimeMs: v })} />
      </Field>
      <Field label="Continuous">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={!!flow.hasRate} onChange={(e) => commit({ hasRate: e.target.checked })} />
          <span style={{ color: 'var(--ink-4)', fontSize: 'var(--fs-xs)' }}>Re-spawn on interval</span>
        </label>
      </Field>
      {flow.hasRate && (
        <Field label="Every (ms)">
          <NumberInput initial={Math.round(flow.intervalMs)} min={30} onCommit={(v) => commit({ intervalMs: v })} />
        </Field>
      )}
      <DangerButton onClick={deleteThis}>Delete flow</DangerButton>
    </>
  );
}

// ── Group form ────────────────────────────────────────────────────────────────

function GroupForm({ group }: { group: GroupNode }) {
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
    if (newId === group.id || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newId)) return;
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const taken = new Set([...ast.components.map((c) => c.id), ...ast.groups.map((g) => g.id), ...ast.connections.map((c) => c.id), ...ast.flows.map((f) => f.name)]);
    taken.delete(group.id);
    if (taken.has(newId)) return;
    const next = renameGroup(sourceText, ast, group.id, newId);
    if (next !== sourceText) { setSourceText(next); setSelection(newId, 'group'); }
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
      <KindBadge label="Package" id={group.id} />
      <Field label="Name">
        <TextInput initial={group.id} placeholder="alias" onCommit={commitRename} />
      </Field>
      <Field label="Display name">
        <TextInput initial={group.displayName} placeholder="Display name" onCommit={(v) => commit({ displayName: v })} />
      </Field>
      <Field label="Color">
        <ColorInput value={group.color} onCommit={(v) => commit({ color: v })} />
      </Field>
      <Field label="Collapse at (px)">
        <CollapseAtInput initial={group.collapseAtPx} onCommit={(v) => commit({ collapseAtPx: v })} />
      </Field>
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button type="button" onClick={ungroup} style={ghostButtonStyle}>Ungroup</button>
        <DangerButton onClick={cascadeDelete}>Delete with contents</DangerButton>
      </div>
    </>
  );
}

// ── Stage form ────────────────────────────────────────────────────────────────

function StageForm({ stage }: { stage: StageNode }) {
  const setSelection = useFlowStore((s) => s.setSelection);
  const clearSelection = useFlowStore((s) => s.clearSelection);
  const allStages = useFlowStore(selectStages);

  const commit = (updates: { after?: string[] | null; repeat?: boolean }) => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = updateStage(sourceText, ast, stage.name, updates);
    if (next !== sourceText) setSourceText(next);
  };

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

  const addableDeps = allStages.map((s) => s.name).filter((n) => n !== stage.name && !stage.after.includes(n));

  const cascadeDelete = () => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const next = deleteStage(sourceText, ast, stage.name);
    if (next !== sourceText) setSourceText(next);
    clearSelection();
  };

  return (
    <>
      <KindBadge label="Stage" id={stage.name} />

      <Field label="Repeat">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={stage.repeat} onChange={(e) => commit({ repeat: e.target.checked })} />
          <span style={{ color: 'var(--ink-4)', fontSize: 'var(--fs-xs)' }}>Restart after completion</span>
        </label>
      </Field>

      <Field label="After">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {stage.after.length === 0 ? (
            <span style={{ color: 'var(--ink-5)', fontSize: 'var(--fs-xs)' }}>(no dependencies)</span>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {stage.after.map((dep) => (
                <span key={dep} style={depChipStyle}>
                  <button type="button" onClick={() => setSelection(dep, 'stage')} style={{ ...inlineLinkStyle, color: 'var(--ink-3)' }}>
                    {dep}
                  </button>
                  <button type="button" onClick={() => commit({ after: stage.after.filter((x) => x !== dep) })} title={`Remove ${dep}`} style={chipXStyle}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {addableDeps.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const dep = e.target.value;
                if (dep && !stage.after.includes(dep) && dep !== stage.name)
                  commit({ after: [...stage.after, dep] });
              }}
              style={selectStyle}
            >
              <option value="">+ Add dependency…</option>
              {addableDeps.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
        </div>
      </Field>

      <Field label="Flows">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {stage.flowNames.length === 0 && (
            <span style={{ color: 'var(--ink-5)', fontSize: 'var(--fs-xs)' }}>(no flows in this stage)</span>
          )}
          {stage.flowNames.map((name, i) => (
            <div key={name} style={flowRowStyle}>
              <button type="button" onClick={() => setSelection(name, 'flow')} style={{ ...inlineLinkStyle, flex: 1, textAlign: 'left', color: 'var(--ink-2)', fontSize: 'var(--fs-xs)', textDecoration: 'none' }}>
                {name}
              </button>
              <button type="button" onClick={() => reorder(i, i - 1)} disabled={i === 0} title="Move up" style={reorderBtnStyle(i === 0)}>↑</button>
              <button type="button" onClick={() => reorder(i, i + 1)} disabled={i === stage.flowNames.length - 1} title="Move down" style={reorderBtnStyle(i === stage.flowNames.length - 1)}>↓</button>
            </div>
          ))}
        </div>
      </Field>

      <DangerButton onClick={cascadeDelete}>Delete stage</DangerButton>
    </>
  );
}

// ── Shared form primitives ────────────────────────────────────────────────────

function KindBadge({ label, id }: { label: string; id: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
      <span className="fd-label">{label}</span>
      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)', color: 'var(--ink-4)', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '65%' }}>
        {id}
      </code>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
      <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--ink-4)', letterSpacing: '0.08em' }}>{label}</span>
      {children}
    </label>
  );
}

function TextInput({ initial, placeholder, onCommit }: { initial: string; placeholder?: string; onCommit: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setValue(initial); }, [initial, focused]);
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); if (value !== initial) onCommit(value); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { setValue(initial); e.currentTarget.blur(); } }}
      style={inputStyle}
    />
  );
}

function NumberInput({ initial, min, onCommit }: { initial: number; min?: number; onCommit: (v: number) => void }) {
  const [value, setValue] = useState(String(initial));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setValue(String(initial)); }, [initial, focused]);
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
        if (!Number.isFinite(n)) { setValue(String(initial)); return; }
        const clamped = min !== undefined ? Math.max(min, n) : n;
        if (clamped !== initial) onCommit(clamped);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { setValue(String(initial)); e.currentTarget.blur(); } }}
      style={inputStyle}
    />
  );
}

function CollapseAtInput({ initial, onCommit }: { initial: number | undefined; onCommit: (v: number | null) => void }) {
  const [value, setValue] = useState(initial === undefined ? '' : String(initial));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setValue(initial === undefined ? '' : String(initial)); }, [initial, focused]);
  const commit = () => {
    const trimmed = value.trim();
    if (trimmed === '') { if (initial !== undefined) onCommit(null); return; }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) { setValue(initial === undefined ? '' : String(initial)); return; }
    if (n !== initial) onCommit(n);
  };
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input
        type="number" min={20} value={value} placeholder="(inherit default)"
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { setValue(initial === undefined ? '' : String(initial)); e.currentTarget.blur(); } }}
        style={{ ...inputStyle, flex: 1 }}
      />
      {initial !== undefined && (
        <button type="button" onClick={() => onCommit(null)} style={ghostButtonStyle}>Clear</button>
      )}
    </div>
  );
}

function Segmented({ options, value, onChange }: { options: { value: string; label: string; title?: string }[]; value: string; onChange: (next: string) => void }) {
  return (
    <div className="fd-seg" role="group">
      {options.map((opt) => (
        <button key={opt.value} type="button" title={opt.title} onClick={() => onChange(opt.value)} data-active={opt.value === value} style={{ flex: 1 }}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ColorInput({ value, onCommit }: { value: string | undefined; onCommit: (v: string | null) => void }) {
  const normalized = value ? '#' + value.replace(/^#/, '') : '#111114';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="color"
        value={normalized}
        onChange={(e) => onCommit(e.target.value.replace(/^#/, ''))}
        style={{ width: 28, height: 24, border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: 2, background: 'var(--surface-3)', cursor: 'pointer', flexShrink: 0 }}
      />
      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)', color: 'var(--ink-4)', flex: 1 }}>
        {value ? '#' + value.replace(/^#/, '') : '(none)'}
      </code>
      {value && <button type="button" onClick={() => onCommit(null)} style={ghostButtonStyle}>Clear</button>}
    </div>
  );
}

function DangerButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} style={dangerButtonStyle}>{children}</button>
  );
}

// ── Arrow style helpers ───────────────────────────────────────────────────────

function arrowKeyFor(lineStyle: 'solid' | 'dotted', arrowStyle: 'forward' | 'long' | 'bidirectional'): string {
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

// ── Style constants ───────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 'var(--fs-xs)',
  padding: '5px 8px',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-sm)',
  outline: 'none',
  background: 'var(--surface-3)',
  color: 'var(--ink-1)',
  width: '100%',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  padding: '5px 6px',
  cursor: 'pointer',
};

const chipStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 'var(--fs-micro)',
  padding: '2px 8px',
  border: '1px solid var(--line)',
  borderRadius: 10,
  background: 'transparent',
  color: 'var(--ink-3)',
  cursor: 'pointer',
};

const depChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: '2px 4px 2px 8px',
  border: '1px solid var(--line)',
  borderRadius: 10,
  background: 'var(--surface-3)',
  fontSize: 'var(--fs-micro)',
  color: 'var(--ink-3)',
};

const chipXStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--ink-5)',
  cursor: 'pointer',
  fontSize: 12,
  padding: '0 2px',
  lineHeight: 1,
};

const inlineLinkStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  background: 'transparent',
  border: 'none',
  padding: 0,
  color: '#60a5fa',
  cursor: 'pointer',
  textDecoration: 'underline',
  fontSize: 'inherit',
};

const ghostButtonStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 'var(--fs-xs)',
  background: 'transparent',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-sm)',
  padding: '4px 8px',
  cursor: 'pointer',
  color: 'var(--ink-3)',
};

const dangerButtonStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 'var(--fs-xs)',
  background: 'transparent',
  border: '1px solid var(--danger-line)',
  borderRadius: 'var(--r-sm)',
  padding: '5px 10px',
  cursor: 'pointer',
  color: 'var(--danger)',
  marginTop: 8,
};

const flowRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 6px',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--surface-3)',
};

const reorderBtnStyle = (disabled: boolean): React.CSSProperties => ({
  fontFamily: 'inherit',
  fontSize: 11,
  background: 'transparent',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-sm)',
  padding: '1px 6px',
  cursor: disabled ? 'default' : 'pointer',
  color: disabled ? 'var(--ink-5)' : 'var(--ink-3)',
  lineHeight: 1.4,
});
