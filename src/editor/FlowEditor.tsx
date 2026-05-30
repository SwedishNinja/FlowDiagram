import { useRef, useEffect } from 'react';
import { EditorState, StateEffect, StateField, EditorSelection } from '@codemirror/state';
import { EditorView, Decoration, type DecorationSet, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { flowdiagramLanguageSupport } from './language/flowdiagramLanguage';
import { useFlowStore } from '../store/flowStore';

// --- Source range highlight (canvas click → editor) ---

const setSourceHighlight = StateEffect.define<{ from: number; to: number } | null>();

const sourceHighlightMark = Decoration.mark({ class: 'cm-sourceHighlight' });

const sourceHighlightField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSourceHighlight)) {
        if (effect.value === null) return Decoration.none;
        const { from, to } = effect.value;
        if (from >= to) return Decoration.none;
        return Decoration.set([sourceHighlightMark.range(from, to)]);
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- Error line highlighting ---

const setErrorLine = StateEffect.define<number | null>();

const errorLineMark = Decoration.line({ class: 'cm-errorLine' });

const errorLineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setErrorLine)) {
        if (effect.value === null) {
          return Decoration.none;
        }
        const lineNo = effect.value;
        if (lineNo >= 1 && lineNo <= tr.state.doc.lines) {
          const line = tr.state.doc.line(lineNo);
          return Decoration.set([errorLineMark.range(line.from)]);
        }
        return Decoration.none;
      }
    }
    return decorations.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- Theme ---

const darkTheme = EditorView.theme({
  '&': {
    backgroundColor: '#1e293b',
    color: '#e2e8f0',
    height: '100%',
    fontSize: '13px',
  },
  '.cm-content': {
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
    padding: '12px 0',
    caretColor: '#60a5fa',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#60a5fa',
  },
  '.cm-gutters': {
    backgroundColor: '#1e293b',
    color: '#475569',
    border: 'none',
    paddingRight: '8px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#1e293b40',
    color: '#94a3b8',
  },
  '.cm-activeLine': {
    backgroundColor: '#334155',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: '#3b82f640 !important',
  },
  '.cm-line': {
    padding: '0 12px',
  },
  '.cm-errorLine': {
    backgroundColor: '#dc262630',
    borderLeft: '3px solid #dc2626',
    paddingLeft: '9px',
  },
  '.cm-sourceHighlight': {
    backgroundColor: '#3b82f633',
    outline: '1px solid #3b82f666',
    borderRadius: '2px',
  },
  // Syntax colors
  '.ͼb': { color: '#60a5fa' },   // keyword - blue
  '.ͼc': { color: '#34d399' },   // string - green
  '.ͼd': { color: '#f59e0b' },   // number - amber
  '.ͼe': { color: '#94a3b8' },   // comment - gray
  '.ͼf': { color: '#c084fc' },   // operator - purple
}, { dark: true });

// --- Component ---

interface FlowEditorProps {
  onChange?: (value: string) => void;
}

export default function FlowEditor({ onChange }: FlowEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sourceText = useFlowStore((s) => s.sourceText);

  // Create editor once on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const value = update.state.doc.toString();
        onChange?.(value);
      }
    });

    const state = EditorState.create({
      doc: sourceText,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        flowdiagramLanguageSupport(),
        keymap.of([
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        darkTheme,
        errorLineField,
        sourceHighlightField,
        updateListener,
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external source text changes (e.g., from drag) into the editor
  useEffect(() => {
    return useFlowStore.subscribe(
      (s) => s.sourceText,
      (newText) => {
        const view = viewRef.current;
        if (!view) return;
        const currentText = view.state.doc.toString();
        if (currentText === newText) return;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: newText },
        });
      },
    );
  }, []);

  // Subscribe to parse errors and update the error line decoration
  useEffect(() => {
    return useFlowStore.subscribe(
      (s) => s.parseErrors,
      (errors) => {
        const view = viewRef.current;
        if (!view) return;
        const errorLine = errors.length > 0 && errors[0]!.line > 0 ? errors[0]!.line : null;
        view.dispatch({ effects: setErrorLine.of(errorLine) });
      },
    );
  }, []);

  // Highlight the source range of the selected canvas element
  useEffect(() => {
    return useFlowStore.subscribe(
      (s) => ({ ids: s.selectedIds, kind: s.selectionKind, ast: s.ast }),
      ({ ids, kind, ast }) => {
        const view = viewRef.current;
        if (!view) return;
        if (ids.length === 0 || !kind || !ast) {
          view.dispatch({ effects: setSourceHighlight.of(null) });
          return;
        }
        const id = ids[0]!;
        let loc: { start: number; end: number } | undefined;
        if (kind === 'component') loc = ast.components.find((c) => c.id === id)?.loc;
        else if (kind === 'connection') loc = ast.connections.find((c) => c.id === id)?.loc;
        else if (kind === 'flow') loc = ast.flows.find((f) => f.name === id)?.loc;
        else if (kind === 'group') loc = ast.groups.find((g) => g.id === id)?.loc;
        else if (kind === 'stage') loc = ast.stages.find((s) => s.name === id)?.loc;
        if (!loc) {
          view.dispatch({ effects: setSourceHighlight.of(null) });
          return;
        }
        const docLen = view.state.doc.length;
        const from = Math.min(loc.start, docLen);
        const to = Math.min(loc.end, docLen);
        view.dispatch({
          effects: setSourceHighlight.of({ from, to }),
          selection: EditorSelection.range(from, to),
          scrollIntoView: true,
        });
      },
      { equalityFn: (a, b) => a.ids === b.ids && a.kind === b.kind && a.ast === b.ast },
    );
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', overflow: 'auto' }}
    />
  );
}
