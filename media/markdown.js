(function (root) {
  const ui = root.AgentUI || (root.AgentUI = {});

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  const EXT = /\.(tsx?|jsx?|mjs|cjs|json|md|css|scss|html|vue|py|go|rs|java|kt|dart|ya?ml|toml|xml|svg|sql|sh|ps1|cs|cpp|c|h|hpp|rb|php|swift|gradle|lock|txt|env|ini|cfg|conf|arb|proto)$/i;

  function looksLikePath(raw) {
    const text = raw.trim();
    if (!text || text.length > 260 || /\s/.test(text) || /^https?:\/\//i.test(text)) return false;
    const file = text.replace(/(:\d+)+$/, "");
    const base = file.split(/[\\/]/).pop() || file;
    return EXT.test(base);
  }

  function splitPath(raw) {
    const text = raw.trim();
    const match = /^(.*?):(\d+)(?::\d+)?$/.exec(text);
    if (match && looksLikePath(match[1])) return { file: match[1], line: match[2] };
    return { file: text, line: "" };
  }

  function pathButton(raw, label) {
    const part = splitPath(raw);
    const shown = label === undefined ? raw.trim() : label;
    return `<button type="button" class="path" data-path="${escapeHtml(part.file)}" data-line="${escapeHtml(part.line)}" title="${escapeHtml(raw.trim())}">${escapeHtml(shown)}</button>`;
  }

  /** Lien Markdown : http(s) vers le navigateur, sinon chemin du projet (`src/a.ts#L42`). */
  function linkHtml(label, href) {
    if (/^https?:\/\//i.test(href)) {
      return `<a href="#" data-url="${escapeHtml(href)}" title="${escapeHtml(href)}">${label}</a>`;
    }
    if (/^(mailto|vscode|command):/i.test(href)) return label;
    const [file, hash = ""] = href.split("#");
    const line = (/^L(\d+)/.exec(hash) || [])[1] || "";
    let decoded = file;
    try { decoded = decodeURIComponent(file); } catch { /* chemin brut */ }
    return `<button type="button" class="path" data-path="${escapeHtml(decoded)}" data-line="${line}" title="${escapeHtml(decoded + (line ? `:${line}` : ""))}">${label}</button>`;
  }

  function emphasis(escaped) {
    return escaped
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
      .replace(/__(?=\S)([^_]*?\S)__/g, "<strong>$1</strong>")
      .replace(/~~(?=\S)([^~]*?\S)~~/g, "<del>$1</del>")
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, "$1<em>$2</em>")
      .replace(/(^|[^_\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![_\w])/g, "$1<em>$2</em>");
  }

  function renderInline(raw) {
    const re = /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
    let html = "";
    let last = 0;
    let match;
    while ((match = re.exec(raw))) {
      html += emphasis(escapeHtml(raw.slice(last, match.index)));
      if (match[1]) {
        const inner = match[2].trim();
        html += looksLikePath(inner) ? pathButton(inner) : `<code>${escapeHtml(inner)}</code>`;
      } else if (match[3]) {
        html += linkHtml(emphasis(escapeHtml(match[3])), match[4]);
      } else if (match[5]) {
        html += linkHtml(escapeHtml(match[5]), match[5]);
      }
      last = match.index + match[0].length;
    }
    html += emphasis(escapeHtml(raw.slice(last)));
    return html;
  }

  function codeBlock(lang, body) {
    const label = lang ? escapeHtml(lang) : "";
    return `<div class="code"><div class="code-head"><span class="code-lang">${label}</span>` +
      `<button type="button" class="copy-code" title="Copier">Copier</button></div>` +
      `<pre><code>${escapeHtml(body)}</code></pre></div>`;
  }

  const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w#+.-]*)/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const QUOTE = /^\s{0,3}>\s?/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function cells(line) {
    let text = line.trim();
    if (text.startsWith("|")) text = text.slice(1);
    if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
    return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  }

  function table(lines) {
    const head = cells(lines[0]);
    const aligns = cells(lines[1]).map((cell) =>
      cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "");
    const cls = (index) => (aligns[index] ? ` class="al-${aligns[index]}"` : "");
    const rows = lines.slice(2).map((line) => cells(line));
    return `<div class="tbl"><table><thead><tr>${head.map((cell, i) => `<th${cls(i)}>${renderInline(cell)}</th>`).join("")}</tr></thead>` +
      `<tbody>${rows.map((row) => `<tr>${head.map((_, i) => `<td${cls(i)}>${renderInline(row[i] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function indentOf(line) {
    const match = /^(\s*)/.exec(line);
    return match ? match[1].replace(/\t/g, "    ").length : 0;
  }

  function list(lines) {
    const base = indentOf(lines[0]);
    const ordered = /\d/.test(ITEM.exec(lines[0])[2]);
    const start = ordered ? parseInt(ITEM.exec(lines[0])[2], 10) : 1;
    const items = [];
    for (const line of lines) {
      const match = ITEM.exec(line);
      if (match && indentOf(line) <= base + 1) {
        items.push([match[3]]);
      } else if (items.length) {
        items[items.length - 1].push(line.slice(Math.min(indentOf(line), base + 2)));
      }
    }
    const tag = ordered ? "ol" : "ul";
    const startAttr = ordered && start !== 1 ? ` start="${start}"` : "";
    return `<${tag}${startAttr}>${items.map((item) => {
      const first = item[0];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(first);
      const head = task
        ? `<span class="task ${task[1] === " " ? "" : "done"}">${task[1] === " " ? "☐" : "☑"}</span> ${renderInline(task[2])}`
        : renderInline(first);
      const rest = item.slice(1);
      const nested = rest.some((line) => line.trim()) ? blocks(rest) : "";
      return `<li>${head}${nested}</li>`;
    }).join("")}</${tag}>`;
  }

  function blocks(lines) {
    const out = [];
    let para = [];
    const flush = () => {
      if (para.length) out.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = FENCE.exec(line);
      if (fence) {
        flush();
        const marker = fence[1];
        const body = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
        out.push(codeBlock(fence[2], body.join("\n")));
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        flush();
        const level = Math.min(heading[1].length + 1, 6);
        out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        continue;
      }
      if (RULE.test(line)) {
        flush();
        out.push("<hr>");
        continue;
      }
      if (QUOTE.test(line)) {
        flush();
        const quoted = [];
        while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE, ""));
        i -= 1;
        out.push(`<blockquote>${blocks(quoted)}</blockquote>`);
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
        flush();
        const rows = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(lines[i++]);
        i -= 1;
        out.push(table(rows));
        continue;
      }
      if (ITEM.test(line)) {
        flush();
        const items = [line];
        const base = indentOf(line);
        i += 1;
        while (i < lines.length) {
          const next = lines[i];
          if (!next.trim()) {
            const after = lines[i + 1];
            if (after && (indentOf(after) > base || (ITEM.test(after) && indentOf(after) >= base))) {
              items.push(next);
              i += 1;
              continue;
            }
            break;
          }
          if (ITEM.test(next) || indentOf(next) > base) {
            if (FENCE.test(next) && indentOf(next) <= base) break;
            items.push(next);
            i += 1;
            continue;
          }
          break;
        }
        i -= 1;
        out.push(list(items));
        continue;
      }
      para.push(line);
    }
    flush();
    return out.join("");
  }

  function renderMarkdown(text) {
    return blocks(String(text ?? "").replace(/\r\n?/g, "\n").split("\n"));
  }

  ui.escapeHtml = escapeHtml;
  ui.renderMarkdown = renderMarkdown;
  ui.renderInline = renderInline;
  ui.pathButton = pathButton;
  ui.looksLikePath = looksLikePath;
})(window);
