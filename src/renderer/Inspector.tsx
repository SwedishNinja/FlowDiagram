import { useEffect, useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import { updateComponent } from '../parser/textMutations';

/**
 * Floating right-side panel that surfaces editable fields for the currently
 * selected component. Phase 4 covers components only; connection/flow/group
 * inspectors will follow in later phases.
 */
export default function Inspector() {
  const ast = useFlowStore((s) => s.ast);
  const selectedId = useFlowStore((s) => s.selectedId);
  const selectionKind = useFlowStore((s) => s.selectionKind);

  if (!ast || !selectedId || selectionKind !== 'component') return null;
  const comp = ast.components.find((c) => c.id === selectedId);
  if (!comp) return null;

  const commit = (updates: {
    displayName?: string;
    color?: string | null;
    stereotype?: string | null;
  }) => {
    const { sourceText, setSourceText, ast: latestAst } = useFlowStore.getState();
    if (!latestAst) return;
    const next = updateComponent(sourceText, latestAst, selectedId, updates);
    if (next !== sourceText) setSourceText(next);
  };

  return (
    <div
      key={selectedId}
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 240,
        background: '#ffffff',
        borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
        padding: 12,
        zIndex: 10,
        font: '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        color: '#1e293b',
      }}
    >
      <Header label="Component" id={comp.id} />
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
    </div>
  );
}

function Header({ label, id }: { label: string; id: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBottom: 10,
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
      <code style={{ font: '11px ui-monospace, SF Mono, Menlo, monospace', color: '#475569' }}>
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

/** Text input with local state; reflects the prop when not focused, commits
 *  on blur/Enter, reverts on Escape. */
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
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setValue(initial);
          e.currentTarget.blur();
        }
        // Native input target handles its own keys; the global canvas
        // shortcut listener already skips edits when focus is on INPUT.
      }}
      style={{
        font: 'inherit',
        padding: '6px 8px',
        border: '1px solid #cbd5e1',
        borderRadius: 4,
        outline: 'none',
        background: '#f8fafc',
      }}
    />
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
