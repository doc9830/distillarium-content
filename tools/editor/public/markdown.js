// Минимальный безопасный Markdown-рендерер для предпросмотра.
// Поддерживает то, что реально используется в контенте: заголовки, списки,
// таблицы, цитаты, код, ссылки и wiki-ссылки [[id|подпись]].
// HTML экранируется: контент не должен выполнять код.

const SAFE_URL = /^(https?:\/\/|mailto:|\/|\.\/|media\/|wiki\/|#)/i;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(url) {
  const value = String(url).trim();
  if (!SAFE_URL.test(value)) return "";
  return escapeHtml(value);
}

function slugify(value, index) {
  const base = String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `h-${base || "section"}-${index}`;
}

function inline(text, knownIds) {
  const tokens = [];
  const protect = (html) => {
    const key = `\u0000${tokens.length}\u0000`;
    tokens.push(html);
    return key;
  };

  let value = escapeHtml(text);
  value = value.replace(/`([^`]+)`/g, (_, code) => protect(`<code>${code}</code>`));
  value = value.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, url) => {
    const safe = safeUrl(url);
    if (!safe) return escapeHtml(alt);
    return protect(`<img src="${safe}" alt="${alt}" loading="lazy" />`);
  });
  value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const safe = safeUrl(url);
    if (!safe) return label;
    return protect(`<a href="${safe}" target="_blank" rel="noreferrer">${label}</a>`);
  });

  value = value.replace(/\[\[([^\]]+)\]\]/g, (_, raw) => {
    const [targetRaw, labelRaw] = raw.split("|");
    const target = targetRaw.trim();
    const label = (labelRaw ?? targetRaw).trim();
    const known = knownIds?.has(target);
    return protect(
      `<span class="${known ? "wikilink" : "broken-wikilink"}" title="${known ? "Ссылка на статью" : "Нет такой статьи"}">${label}</span>`,
    );
  });

  value = value.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  value = value.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  value = value.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  value = value.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");
  value = value.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] ?? "");
  return value;
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

export function renderMarkdown(source, knownIds = new Set()) {
  const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let headingIndex = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join(" ").trim(), knownIds)}</p>`);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const language = trimmed.slice(3).trim();
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      html.push(
        `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`,
      );
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (trimmed.startsWith("::: tabs")) {
      flushParagraph();
      const content = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== ":::") {
        content.push(lines[i]);
        i += 1;
      }
      html.push(
        `<div class="tabs"><span class="tabs-title">Варианты</span>${renderTabContent(content, knownIds)}</div>`,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = slugify(text, headingIndex++);
      html.push(`<h${level} id="${id}">${inline(text, knownIds)}</h${level}>`);
      continue;
    }

    if (trimmed === "---" || trimmed === "***") {
      flushParagraph();
      html.push("<hr />");
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      const quote = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      i -= 1;
      html.push(`<blockquote>${renderMarkdown(quote.join("\n"), knownIds)}</blockquote>`);
      continue;
    }

    if (isTableSeparator(lines[i + 1] ?? "") && trimmed.includes("|")) {
      flushParagraph();
      const head = splitTableRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      const headHtml = head.map((cell) => `<th>${inline(cell, knownIds)}</th>`).join("");
      const bodyHtml = rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${inline(cell, knownIds)}</td>`).join("")}</tr>`,
        )
        .join("");
      html.push(`<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`);
      continue;
    }

    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const tag = unordered ? "ul" : "ol";
      const items = [];
      while (i < lines.length) {
        const match =
          tag === "ul"
            ? /^\s*[-*+]\s+(.+)$/.exec(lines[i])
            : /^\s*\d+[.)]\s+(.+)$/.exec(lines[i]);
        if (!match) break;
        items.push(`<li>${inline(match[1].trim(), knownIds)}</li>`);
        i += 1;
      }
      i -= 1;
      html.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  return html.join("\n");
}

function renderTabContent(lines, knownIds) {
  const html = [];
  let bucket = [];
  const flush = () => {
    if (!bucket.length) return;
    html.push(renderMarkdown(bucket.join("\n"), knownIds));
    bucket = [];
  };
  for (const line of lines) {
    const tab = /^==\s*(.+?)\s*==$/.exec(line.trim());
    if (tab) {
      flush();
      html.push(`<h4>${inline(tab[1], knownIds)}</h4>`);
    } else {
      bucket.push(line);
    }
  }
  flush();
  return html.join("");
}

export function extractOutline(source) {
  const outline = [];
  let index = 0;
  for (const line of String(source ?? "").split("\n")) {
    const match = /^(#{1,4})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const text = match[2].trim();
    outline.push({ level: match[1].length, text, id: slugify(text, index++) });
  }
  return outline;
}

