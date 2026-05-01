export function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const parts = [];
  const paragraphLines = [];
  let listType = null;
  let inCodeBlock = false;
  let codeLines = [];

  function flushParagraph() {
    if (!paragraphLines.length) return;
    parts.push(`<p>${renderInline(paragraphLines.join("\n")).replaceAll("\n", "<br>")}</p>`);
    paragraphLines.length = 0;
  }

  function closeList() {
    if (!listType) return;
    parts.push(`</${listType}>`);
    listType = null;
  }

  function flushCodeBlock() {
    parts.push(codeLines.length
      ? `<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`
      : "<pre><code></code></pre>"
    );
    codeLines = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalized = normalizeLine(line);

    if (normalized.startsWith("__HTML__")) {
      flushParagraph();
      closeList();
      parts.push(normalized.slice(8));
      continue;
    }

    if (normalized.trim().startsWith("```")) {
      flushParagraph();
      closeList();
      if (inCodeBlock) flushCodeBlock();
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) { codeLines.push(line); continue; }

    if (!normalized.trim()) { flushParagraph(); closeList(); continue; }

    const headingMatch = normalized.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      closeList();
      parts.push(`<h${headingMatch[1].length}>${renderInline(headingMatch[2])}</h${headingMatch[1].length}>`);
      continue;
    }

    if (isTableHeaderRow(normalized, normalizeLine(lines[index + 1] || ""))) {
      flushParagraph();
      closeList();
      const tableLines = [normalized];
      index += 2;
      while (index < lines.length && isTableBodyRow(normalizeLine(lines[index] || ""))) {
        tableLines.push(normalizeLine(lines[index]));
        index += 1;
      }
      index -= 1;
      parts.push(renderTable(tableLines));
      continue;
    }

    if (/^---+$/.test(normalized.trim())) {
      flushParagraph();
      closeList();
      parts.push("<hr>");
      continue;
    }

    const unorderedMatch = normalized.match(/^[-*]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      if (listType !== "ul") { closeList(); listType = "ul"; parts.push("<ul>"); }
      parts.push(`<li>${renderInline(unorderedMatch[1])}</li>`);
      continue;
    }

    const orderedMatch = normalized.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      if (listType !== "ol") { closeList(); listType = "ol"; parts.push("<ol>"); }
      parts.push(`<li>${renderInline(orderedMatch[1])}</li>`);
      continue;
    }

    closeList();
    paragraphLines.push(normalized);
  }

  flushParagraph();
  closeList();
  if (inCodeBlock) flushCodeBlock();

  return parts.join("");
}

function normalizeLine(line) {
  return String(line || "").replace(/^[​-‍﻿]+/, "");
}

function isTableHeaderRow(line, nextLine) {
  return isTableRow(line) && isTableSeparatorRow(nextLine);
}

function isTableBodyRow(line) {
  return isTableRow(line) && !isTableSeparatorRow(line);
}

function isTableRow(line) {
  return Boolean(line?.includes("|")) && parseTableCells(line).length >= 2;
}

function isTableSeparatorRow(line) {
  if (!line) return false;
  const cells = parseTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseTableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderTable(lines) {
  const headerCells = parseTableCells(lines[0]);
  const bodyRows = lines.slice(1).map(parseTableCells);
  const headerHtml = headerCells.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
  const bodyHtml = bodyRows
    .map((cells) => `<tr>${cells.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
