import React from "react";

export type SyntaxKind = "json" | "xml" | "text";

const MAX_HIGHLIGHT_CHARS = 120_000;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
}

function renderSyntaxSegment(value: string, className?: string) {
  if (!value) return "";
  const classAttr = className ? ` class="${className}"` : "";
  return `<span${classAttr} data-text="${escapeAttribute(value)}"></span>`;
}

function highlightJson(value: string) {
  const tokenPattern = /"(?:\\.|[^"\\])*"(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
  let result = "";
  let lastIndex = 0;

  value.replace(tokenPattern, (match, colon: string | undefined, literal: string | undefined, offset: number) => {
    result += renderSyntaxSegment(value.slice(lastIndex, offset));

    if (match.startsWith('"')) {
      const token = colon ? match.slice(0, -colon.length) : match;
      result += renderSyntaxSegment(token, colon ? "token key" : "token string");
      result += renderSyntaxSegment(colon ?? "");
    } else if (literal) {
      result += renderSyntaxSegment(match, "token literal");
    } else {
      result += renderSyntaxSegment(match, "token number");
    }

    lastIndex = offset + match.length;
    return match;
  });

  result += renderSyntaxSegment(value.slice(lastIndex));
  return result;
}

function highlightXml(value: string) {
  const tokenPattern = /(<\/?)([\w:.-]+)|([\w:.-]+)(=)(".*?")|(<![\s\S]*?>|<\?[\s\S]*?\?>|\/?>)/g;
  let result = "";
  let lastIndex = 0;

  value.replace(
    tokenPattern,
    (match, open: string | undefined, tag: string | undefined, attr: string | undefined, equals: string | undefined, attrValue: string | undefined, metaOrClose: string | undefined, offset: number) => {
      result += renderSyntaxSegment(value.slice(lastIndex, offset));

      if (open && tag) {
        result += renderSyntaxSegment(open, "token bracket");
        result += renderSyntaxSegment(tag, "token tag");
      } else if (attr && equals && attrValue) {
        result += renderSyntaxSegment(attr, "token attr");
        result += renderSyntaxSegment(equals);
        result += renderSyntaxSegment(attrValue, "token string");
      } else if (metaOrClose) {
        result += renderSyntaxSegment(metaOrClose, "token bracket");
      } else {
        result += renderSyntaxSegment(match);
      }

      lastIndex = offset + match.length;
      return match;
    },
  );

  result += renderSyntaxSegment(value.slice(lastIndex));
  return result;
}

function highlightCode(value: string, syntax: SyntaxKind) {
  if (syntax === "text") return renderSyntaxSegment(value);
  return syntax === "json" ? highlightJson(value) : highlightXml(value);
}

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

function CodeEditorBase({ label, value, syntax, placeholder, readOnly, error, actions, onChange }: CodeEditorProps) {
  const highlightRef = React.useRef<HTMLPreElement>(null);
  const disableHighlight = value.length > MAX_HIGHLIGHT_CHARS;

  const highlightedHtml = React.useMemo(
    () => (disableHighlight ? "" : error ? renderSyntaxSegment(value) : highlightCode(value, syntax)),
    [value, syntax, error, disableHighlight],
  );

  const syncScroll = (event: React.UIEvent<HTMLTextAreaElement>) => {
    if (!highlightRef.current) return;
    highlightRef.current.scrollTop = event.currentTarget.scrollTop;
    highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
  };

  return (
    <div className="editor-container">
      <div className="editor-header output-header">
        <span>{label}</span>
        {disableHighlight && <span className="editor-performance-note">大文本已关闭高亮</span>}
        {actions}
      </div>
      <div className={`code-surface ${error ? "has-error" : ""}`}>
        <pre
          ref={highlightRef}
          className="syntax-layer"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
        <textarea
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          onScroll={syncScroll}
          readOnly={readOnly}
          wrap="soft"
          spellCheck={false}
          className={`editor-textarea ${error ? "error" : ""} ${disableHighlight ? "plain-text" : ""}`}
          placeholder={placeholder}
        />
      </div>
    </div>
  );
}

export const CodeEditor = React.memo(CodeEditorBase);
