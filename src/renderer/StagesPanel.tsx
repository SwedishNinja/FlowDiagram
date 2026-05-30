import { useFlowStore } from '../store/flowStore';
import { createStage, generateUniqueStageName } from '../parser/textMutations';
import type { StageNode, FlowDocument } from '../types';

/** Stable empty array for the stages selector. A fresh `?? []` inside the
 *  selector closure would trigger an infinite re-render under React 19. */
const EMPTY_STAGES: ReadonlyArray<StageNode> = [];
function selectStages(s: { ast: FlowDocument | null }) {
  return s.ast?.stages ?? EMPTY_STAGES;
}

/**
 * Floating left-side panel that lists every @stage in the document. Opens
 * when the Stages button in the tool palette is toggled on. Persists until
 * it's toggled off again — independent of selection or tool mode.
 */
export default function StagesPanel() {
  const open = useFlowStore((s) => s.stagesPanelOpen);
  const stages = useFlowStore(selectStages);
  const setSelection = useFlowStore((s) => s.setSelection);
  const setStagesPanelOpen = useFlowStore((s) => s.setStagesPanelOpen);

  if (!open) return null;

  const create = () => {
    const { sourceText, setSourceText, ast } = useFlowStore.getState();
    if (!ast) return;
    const name = generateUniqueStageName(ast);
    const updated = createStage(sourceText, ast, { name });
    if (updated !== sourceText) {
      setSourceText(updated);
      setSelection(name, 'stage');
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 140, // sits below the tool palette
        left: 12,
        width: 240,
        background: '#ffffff',
        borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
        padding: 10,
        zIndex: 10,
        font: '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        color: '#1e293b',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
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
          Stages
        </span>
        <button
          type="button"
          onClick={() => setStagesPanelOpen(false)}
          title="Close stages panel"
          style={{
            font: '12px inherit',
            background: 'transparent',
            border: 'none',
            color: '#94a3b8',
            cursor: 'pointer',
            padding: '0 4px',
          }}
        >
          ×
        </button>
      </div>

      <button
        type="button"
        onClick={create}
        style={{
          font: '12px inherit',
          background: '#3b82f6',
          color: '#ffffff',
          border: 'none',
          borderRadius: 4,
          padding: '6px 10px',
          cursor: 'pointer',
          width: '100%',
          textAlign: 'left',
          marginBottom: 8,
        }}
      >
        + New stage
      </button>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {stages.length === 0 ? (
          <div style={{ fontSize: 11, color: '#94a3b8', padding: '4px 6px' }}>
            No stages yet — click "New stage" to add one.
          </div>
        ) : (
          stages.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setSelection(s.name, 'stage')}
              style={{
                font: '12px inherit',
                background: '#f8fafc',
                color: '#475569',
                border: '1px solid #e2e8f0',
                borderRadius: 4,
                padding: '6px 8px',
                cursor: 'pointer',
                textAlign: 'left',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>{s.name}</span>
              <span style={{ color: '#94a3b8', fontSize: 11 }}>
                {s.flowNames.length} flow{s.flowNames.length === 1 ? '' : 's'}
                {s.repeat && ' · ↻'}
                {s.after.length > 0 && ` · after ${s.after.join(', ')}`}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
