import React from 'react';
import { isSafeHttpUrl } from './chatUrlUtils';

const LINE_URL_RE = /https?:\/\/[^\s\])>'"<]+/gi;

function linkifyLine(line: string, lineKey: number): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  const re = new RegExp(LINE_URL_RE.source, LINE_URL_RE.flags);
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) {
      parts.push(<React.Fragment key={`t-${lineKey}-${i++}`}>{line.slice(last, m.index)}</React.Fragment>);
    }
    let href = m[0].replace(/[),.;:]+$/g, '');
    if (isSafeHttpUrl(href)) {
      parts.push(
        <a
          key={`a-${lineKey}-${i++}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="chat-inline-link"
          onClick={(event) => {
            const openExternalUrl = window.butlerElectron?.openExternalUrl;
            if (!openExternalUrl) return;
            event.preventDefault();
            void openExternalUrl(href);
          }}
        >
          {href}
        </a>,
      );
    } else {
      parts.push(<React.Fragment key={`r-${lineKey}-${i++}`}>{m[0]}</React.Fragment>);
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) {
    parts.push(<React.Fragment key={`t-${lineKey}-end`}>{line.slice(last)}</React.Fragment>);
  }
  return parts.length ? parts : line;
}

/** Renders assistant/user plain text with clickable http(s) links. */
export function ChatBubbleRichText({ text }: { text: string }) {
  const lines = String(text || '').split('\n');
  return (
    <>
      {lines.map((line, idx) => (
        <p key={idx}>{linkifyLine(line, idx)}</p>
      ))}
    </>
  );
}
