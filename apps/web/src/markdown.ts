/**
 * Minimal, XSS-safe Markdown renderer.
 * Strategy: escape ALL HTML first, then apply markdown transforms on the
 * escaped text — no raw model output ever reaches innerHTML unescaped.
 * Supports: headings, bold/italic, inline code, fenced code, lists,
 * blockquotes, hr, links (http/https only), tables.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(text: string): string {
  let out = escapeHtml(text);
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  out = out.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is a private sentinel that never appears in user text
    /\u0000(\d+)\u0000/g,
    (_m, i: string) => `<code>${codes[Number(i)] ?? ""}</code>`,
  );
  return out;
}

interface TableRows {
  head: string[] | null;
  body: string[][];
}

export function renderMarkdown(src: string): string {
  // Strip NULs: model output containing literal \u0000 would otherwise
  // collide with the inline-code sentinel below.
  const lines = (src ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping literal NULs that would collide with the inline-code sentinel below
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const html: string[] = [];
  let list: "ul" | "ol" | null = null;
  let inCode = false;
  const codeBuf: string[] = [];
  const para: string[] = [];
  let table: TableRows | null = null;

  const flushPara = () => {
    if (para.length > 0) {
      html.push(`<p>${inline(para.join(" "))}</p>`);
      para.length = 0;
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };
  const flushTable = () => {
    if (!table) return;
    const head = table.head;
    if (head) {
      html.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>`,
      );
    } else {
      html.push("<table><tbody>");
    }
    for (const row of table.body) {
      html.push(`<tr>${row.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
    }
    html.push("</tbody></table>");
    table = null;
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushTable();
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (line.trim().startsWith("```")) {
      flushAll();
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf.length = 0;
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }

    if (line.trim().length === 0) {
      flushAll();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1]?.length ?? 1, 4);
      html.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll();
      html.push("<hr/>");
      continue;
    }

    const quote = line.match(/^>\s?(.*)/);
    if (quote) {
      flushAll();
      html.push(`<blockquote>${inline(quote[1] ?? "")}</blockquote>`);
      continue;
    }

    const ulItem = line.match(/^\s*[-*•]\s+(.*)/);
    const olItem = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ulItem || olItem) {
      flushPara();
      flushTable();
      const want: "ul" | "ol" = ulItem ? "ul" : "ol";
      if (list !== want) {
        flushList();
        html.push(`<${want}>`);
        list = want;
      }
      html.push(`<li>${inline(ulItem?.[1] ?? olItem?.[1] ?? "")}</li>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      flushList();
      const cells = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
      const isSeparator = cells.every((c) => /^:?-{2,}:?$/.test(c));
      if (!isSeparator) {
        if (!table) table = { head: null, body: [] };
        if (table.head === null && table.body.length === 0) table.head = cells;
        else table.body.push(cells);
      }
      continue;
    }

    flushAll();
    para.push(line.trim());
  }

  if (inCode && codeBuf.length > 0) {
    html.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  flushAll();

  return html.join("\n");
}
