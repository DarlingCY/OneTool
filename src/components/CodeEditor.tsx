import React from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers, placeholder } from "@codemirror/view";

export type SyntaxKind = "json" | "xml" | "text";

interface CodeEditorProps {
  label: string;
  value: string;
  syntax: SyntaxKind;
  placeholder: string;
  readOnly?: boolean;
  error?: boolean;
  actions?: React.ReactNode;
  onChange?: (value: string) => void;
}

const languageCompartment = new Compartment();
const editableCompartment = new Compartment();
const placeholderCompartment = new Compartment();
const performanceCompartment = new Compartment();
const LARGE_DOC_CHARS = 500_000;
const HUGE_DOC_CHARS = 2_000_000;
const LONG_LINE_CHARS = 20_000;
const LARGE_DOC_SYNC_DELAY_MS = 350;

type PerfMode = "normal" | "large" | "huge";

interface PerfProfile {
  mode: PerfMode;
  hasLongLine: boolean;
}

function languageExtension(syntax: SyntaxKind) {
  if (syntax === "json") return json();
  if (syntax === "xml") return xml();
  return [];
}

function editableExtensions(readOnly?: boolean) {
  return [EditorState.readOnly.of(Boolean(readOnly)), EditorView.editable.of(!readOnly)];
}

function hasVeryLongLine(value: string) {
  let lineLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10 || code === 13) {
      lineLength = 0;
    } else {
      lineLength += 1;
      if (lineLength > LONG_LINE_CHARS) return true;
    }
  }
  return false;
}

function getPerfMode(length: number): PerfMode {
  if (length > HUGE_DOC_CHARS) return "huge";
  if (length > LARGE_DOC_CHARS) return "large";
  return "normal";
}

function getPerfProfile(value: string): PerfProfile {
  return {
    mode: getPerfMode(value.length),
    hasLongLine: hasVeryLongLine(value),
  };
}

function getPerfProfileFromState(state: EditorState, previous: PerfProfile): PerfProfile {
  const mode = getPerfMode(state.doc.length);
  if (mode !== "normal" || previous.hasLongLine) {
    return { mode, hasLongLine: previous.hasLongLine };
  }

  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    if (line.length > LONG_LINE_CHARS) return { mode, hasLongLine: true };
  }

  return { mode, hasLongLine: false };
}

function samePerfProfile(left: PerfProfile, right: PerfProfile) {
  return left.mode === right.mode && left.hasLongLine === right.hasLongLine;
}

function performanceExtensions(profile: PerfProfile, syntax: SyntaxKind): Extension[] {
  const isLarge = profile.mode !== "normal";
  const isHuge = profile.mode === "huge";
  const disableWrapping = isLarge || profile.hasLongLine;
  const extensions: Extension[] = [drawSelection(), keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap])];

  if (!isHuge) {
    extensions.push(lineNumbers());
  }

  if (!isLarge) {
    extensions.push(bracketMatching(), highlightActiveLine(), highlightSelectionMatches());
  }

  if (!isHuge && syntax !== "text") {
    extensions.push(syntaxHighlighting(defaultHighlightStyle, { fallback: true }));
  }

  if (!disableWrapping) {
    extensions.push(EditorView.lineWrapping);
  }

  return extensions;
}

function CodeEditorBase({ label, value, syntax, placeholder: placeholderText, readOnly, error, actions, onChange }: CodeEditorProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const onChangeRef = React.useRef(onChange);
  const syncTimerRef = React.useRef<number | null>(null);
  const perfFrameRef = React.useRef<number | null>(null);
  const perfProfileRef = React.useRef<PerfProfile>(getPerfProfile(value));
  const syntaxRef = React.useRef(syntax);

  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const flushPendingChange = React.useCallback(() => {
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }

    const view = viewRef.current;
    if (!view) return;
    onChangeRef.current?.(view.state.doc.toString());
  }, []);

  const scheduleChange = React.useCallback(() => {
    const view = viewRef.current;
    if (!view) return;

    if (view.state.doc.length <= LARGE_DOC_CHARS) {
      flushPendingChange();
      return;
    }

    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
    }

    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      onChangeRef.current?.(view.state.doc.toString());
    }, LARGE_DOC_SYNC_DELAY_MS);
  }, [flushPendingChange]);

  const updatePerformanceProfile = React.useCallback((state: EditorState) => {
    const nextProfile = getPerfProfileFromState(state, perfProfileRef.current);
    if (samePerfProfile(nextProfile, perfProfileRef.current)) return;

    perfProfileRef.current = nextProfile;
    if (perfFrameRef.current !== null) return;

    perfFrameRef.current = window.requestAnimationFrame(() => {
      perfFrameRef.current = null;
      viewRef.current?.dispatch({
        effects: performanceCompartment.reconfigure(performanceExtensions(perfProfileRef.current, syntaxRef.current)),
      });
    });
  }, []);

  React.useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              scheduleChange();
              updatePerformanceProfile(update.state);
            }
          }),
          EditorView.domEventHandlers({
            blur: () => {
              flushPendingChange();
            },
          }),
          languageCompartment.of(languageExtension(syntax)),
          editableCompartment.of(editableExtensions(readOnly)),
          placeholderCompartment.of(placeholder(placeholderText)),
          performanceCompartment.of(performanceExtensions(perfProfileRef.current, syntax)),
          EditorView.theme({
            "&": {
              height: "100%",
              backgroundColor: "transparent",
              color: "var(--text-main)",
              fontSize: "13px",
            },
            "&.cm-focused": {
              outline: "none",
            },
            ".cm-scroller": {
              fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
              lineHeight: "1.5",
              overflow: "auto",
            },
            ".cm-content": {
              padding: "16px 16px 16px 0",
              caretColor: "var(--text-main)",
              minHeight: "100%",
            },
            ".cm-gutters": {
              backgroundColor: "transparent",
              color: "var(--text-muted)",
              border: "none",
              paddingTop: "16px",
            },
            ".cm-lineNumbers .cm-gutterElement": {
              padding: "0 10px 0 12px",
              minWidth: "34px",
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: "rgba(150, 150, 150, 0.08)",
            },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor: "rgba(0, 102, 204, 0.22)",
            },
            ".cm-placeholder": {
              color: "var(--text-muted)",
              opacity: "0.55",
            },
          }),
        ],
      }),
    });

    viewRef.current = view;
    return () => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      if (perfFrameRef.current !== null) {
        window.cancelAnimationFrame(perfFrameRef.current);
        perfFrameRef.current = null;
      }
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    perfProfileRef.current = getPerfProfile(value);
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    view.dispatch({ effects: performanceCompartment.reconfigure(performanceExtensions(perfProfileRef.current, syntaxRef.current)) });
  }, [value]);

  React.useEffect(() => {
    syntaxRef.current = syntax;
    viewRef.current?.dispatch({
      effects: [
        languageCompartment.reconfigure(languageExtension(syntax)),
        performanceCompartment.reconfigure(performanceExtensions(perfProfileRef.current, syntax)),
      ],
    });
  }, [syntax]);

  React.useEffect(() => {
    viewRef.current?.dispatch({ effects: editableCompartment.reconfigure(editableExtensions(readOnly)) });
  }, [readOnly]);

  React.useEffect(() => {
    viewRef.current?.dispatch({ effects: placeholderCompartment.reconfigure(placeholder(placeholderText)) });
  }, [placeholderText]);

  return (
    <div className="editor-container">
      <div className="editor-header output-header">
        <span>{label}</span>
        {actions}
      </div>
      <div className={`codemirror-surface ${error ? "has-error" : ""}`} ref={containerRef} />
    </div>
  );
}

export const CodeEditor = React.memo(CodeEditorBase);
export default CodeEditor;
