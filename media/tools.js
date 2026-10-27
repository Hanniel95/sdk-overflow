(function (root) {
  const ui = root.AgentUI;
  const esc = (value) => ui.escapeHtml(value == null ? "" : value);
  const PREVIEW_LINES = 12;
  const DIFF_LINES = 60;

  const SHELL = new Set(["Bash", "PowerShell", "BashOutput"]);
  const EDITS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);

  function isAgent(name) {
    return name === "Agent" || name === "Task";
  }

  function inputOf(model) {
    return model.input || {};
  }

  function fileOf(input) {
    return String(input.file_path || input.notebook_path || input.path || "");
  }

  function baseName(file) {
    const text = String(file).replace(/\\/g, "/");
    const index = text.lastIndexOf("/");
    return index >= 0 ? text.slice(index + 1) : text;
  }

  function pathChip(file, line) {
    const text = String(file).replace(/\\/g, "/");
    const shown = ui.relPath ? ui.relPath(text) : text;
    return `<button type="button" class="path" data-path="${esc(text)}" data-line="${esc(line || "")}" title="${esc(text + (line ? `:${line}` : ""))}">${esc(shown)}</button>`;
  }

  function firstLine(text) {
    return String(text || "").split("\n").find((line) => line.trim()) || "";
  }

  function lineCount(text) {
    const value = String(text || "").replace(/\n+$/, "");
    return value ? value.split("\n").length : 0;
  }

  function plural(n, word) {
    return `${n} ${word}${n > 1 ? "s" : ""}`;
  }

  /** Tronque à n lignes, avec un bouton qui déplie la suite (clé mémorisée sur le modèle). */
  function clipped(model, key, text, n, render) {
    const lines = String(text || "").replace(/\n+$/, "").split("\n");
    const open = model.expand && model.expand[key];
    const shown = open || lines.length <= n ? lines : lines.slice(0, n);
    const html = render ? render(shown) : esc(shown.join("\n"));
    const more = !open && lines.length > n
      ? `<button type="button" class="more" data-more="${key}">Afficher ${plural(lines.length - n, "ligne")} de plus</button>`
      : "";
    return { html, more };
  }

  // ---------- diff ----------

  function lcsRows(oldText, newText) {
    const a = String(oldText ?? "").split("\n");
    const b = String(newText ?? "").split("\n");
    if (a.length * b.length > 90000) {
      return [...a.map((l) => ({ t: "-", l })), ...b.map((l) => ({ t: "+", l }))];
    }
    const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const rows = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { rows.push({ t: " ", l: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) rows.push({ t: "-", l: a[i++] });
      else rows.push({ t: "+", l: b[j++] });
    }
    while (i < a.length) rows.push({ t: "-", l: a[i++] });
    while (j < b.length) rows.push({ t: "+", l: b[j++] });
    return rows;
  }

  /** Lignes du diff : numérotées depuis structuredPatch quand le résultat est là, sinon LCS sur l'entrée. */
  function diffRows(model) {
    const edit = model.edit;
    if (edit && Array.isArray(edit.hunks) && edit.hunks.length) {
      const rows = [];
      edit.hunks.forEach((hunk, index) => {
        if (index > 0) rows.push({ t: "…" });
        let oldNo = hunk.oldStart;
        let newNo = hunk.newStart;
        for (const raw of hunk.lines) {
          const t = raw[0] === "+" || raw[0] === "-" ? raw[0] : " ";
          const l = raw.slice(1);
          if (t === "+") rows.push({ t, l, n: newNo++ });
          else if (t === "-") rows.push({ t, l, n: oldNo++ });
          else { rows.push({ t, l, n: newNo }); oldNo++; newNo++; }
        }
      });
      return rows;
    }
    const input = inputOf(model);
    if (Array.isArray(input.edits)) {
      const rows = [];
      input.edits.forEach((item, index) => {
        if (index > 0) rows.push({ t: "…" });
        rows.push(...lcsRows(item.old_string || "", item.new_string || ""));
      });
      return rows;
    }
    if (model.name === "Write") {
      return String(input.content || "").split("\n").map((l, i) => ({ t: "+", l, n: i + 1 }));
    }
    return lcsRows(input.old_string || "", input.new_string || input.new_source || "");
  }

  function diffStats(model) {
    if (model.edit) return { added: model.edit.added || 0, removed: model.edit.removed || 0 };
    let added = 0;
    let removed = 0;
    for (const row of diffRows(model)) {
      if (row.t === "+") added++;
      else if (row.t === "-") removed++;
    }
    return { added, removed };
  }

  function statsHtml(stats) {
    return `<span class="stat add">+${stats.added}</span> <span class="stat del">−${stats.removed}</span>`;
  }

  function diffHtml(rows, model, key) {
    const render = (shown) => shown.map((row) => {
      if (row.t === "…") return `<div class="dl skip"><span class="ln"></span><span class="mk"></span><span class="tx">⋯</span></div>`;
      const cls = row.t === "+" ? "add" : row.t === "-" ? "del" : "ctx";
      return `<div class="dl ${cls}"><span class="ln">${row.n == null ? "" : row.n}</span><span class="mk">${row.t === " " ? "" : row.t === "-" ? "−" : "+"}</span><span class="tx">${esc(row.l)}</span></div>`;
    }).join("");
    if (!model) return `<div class="diff">${render(rows)}</div>`;
    const lines = rows.length;
    const open = model.expand && model.expand[key];
    const shown = open || lines <= DIFF_LINES ? rows : rows.slice(0, DIFF_LINES);
    const more = !open && lines > DIFF_LINES
      ? `<button type="button" class="more" data-more="${key}">Afficher ${plural(lines - DIFF_LINES, "ligne")} de plus</button>`
      : "";
    return `<div class="diff">${render(shown)}</div>${more}`;
  }

  // ---------- en-têtes ----------

  function head(model) {
    const input = inputOf(model);
    const name = model.name || "Outil";
    const file = fileOf(input);
    if (SHELL.has(name)) {
      return { name, arg: `<span class="mono">${esc(input.description || firstLine(input.command) || input.bash_id || "")}</span>` };
    }
    if (name === "Read") {
      const offset = Number(input.offset) || 0;
      const limit = Number(input.limit) || 0;
      const from = offset || 1;
      const range = limit ? `lignes ${from}–${from + limit - 1}` : offset ? `dès la ligne ${offset}` : "";
      const n = model.output && !model.isError ? lineCount(model.output) : 0;
      return {
        name,
        arg: file ? pathChip(file, offset || "") : "",
        meta: esc(range || (n ? plural(n, "ligne") : "")),
      };
    }
    if (EDITS.has(name) || name === "Write") {
      const created = model.edit ? model.edit.kind === "create" : false;
      const label = name === "Write" ? (created ? "Create" : "Write") : name === "MultiEdit" ? "Edit" : name;
      return { name: label, arg: file ? pathChip(file) : "", meta: statsHtml(diffStats(model)) };
    }
    if (name === "Grep" || name === "Glob") {
      const where = input.path ? ` <span class="dim">dans</span> ${pathChip(input.path)}` : input.glob ? ` <span class="dim">(${esc(input.glob)})</span>` : "";
      const n = model.output && !model.isError ? lineCount(model.output) : 0;
      return {
        name: name === "Grep" ? "Search" : "Glob",
        arg: `<span class="mono">${esc(input.pattern || "")}</span>${where}`,
        meta: n ? esc(plural(n, "résultat")) : "",
      };
    }
    if (name === "WebSearch") return { name: "Web Search", arg: `<span class="mono">${esc(input.query || "")}</span>` };
    if (name === "WebFetch") {
      const url = String(input.url || "");
      return { name: "Fetch", arg: url ? `<a href="#" data-url="${esc(url)}" class="mono">${esc(url)}</a>` : "" };
    }
    if (name === "TodoWrite") {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const done = todos.filter((todo) => todo.status === "completed").length;
      return { name: "Update Todos", arg: "", meta: todos.length ? esc(`${done}/${todos.length}`) : "" };
    }
    if (isAgent(name)) {
      const type = String(input.subagent_type || "agent");
      const children = model.children || 0;
      return {
        name: "Agent",
        arg: `<span class="chip">${esc(type)}</span> ${esc(input.description || "")}`,
        meta: children ? esc(plural(children, "outil")) : "",
      };
    }
    if (name === "AskUserQuestion") {
      const first = Array.isArray(input.questions) && input.questions[0];
      return { name: "Question", arg: esc(first ? first.question || "" : "") };
    }
    if (name === "ExitPlanMode") return { name: "Plan proposé", arg: "" };
    if (name === "Skill") return { name: "Skill", arg: `<span class="mono">${esc(input.skill || input.command || "")}</span>` };
    const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
    const label = mcp ? `${mcp[2]}` : name;
    const firstText = Object.values(input).find((value) => typeof value === "string" && value.trim());
    return {
      name: label,
      arg: (mcp ? `<span class="chip">${esc(mcp[1])}</span> ` : "") + `<span class="mono">${esc(firstLine(firstText || ""))}</span>`,
    };
  }

  // ---------- corps ----------

  function outputBlock(model, cls) {
    if (!model.output) return "";
    const part = clipped(model, "out", model.output, PREVIEW_LINES);
    return `<pre class="${cls || "out"}${model.isError ? " err" : ""}">${linkify(part.html)}</pre>${part.more}`;
  }

  function linkify(escaped) {
    return escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
      const clean = url.replace(/[),.;'"]+$/, "").replace(/&quot;$/, "");
      return `<a href="#" data-url="${clean}">${clean}</a>${url.slice(clean.length)}`;
    });
  }

  function shellBody(model) {
    const input = inputOf(model);
    let output = String(model.output || "");
    let code = null;
    const exit = /\n?exit (-?\d+)$/.exec(output);
    if (exit) {
      code = Number(exit[1]);
      output = output.slice(0, exit.index);
    }
    const cmd = clipped(model, "in", input.command || "", 8);
    let out;
    if (output) {
      const part = clipped(model, "out", output, PREVIEW_LINES);
      out = `<pre class="${model.isError || (code !== null && code !== 0) ? "err" : ""}">${linkify(part.html)}</pre>${part.more}`;
    } else if (model.running) {
      out = `<span class="dim">En cours…</span>`;
    } else {
      out = `<span class="dim">(aucune sortie)</span>`;
    }
    const badge = code !== null && code !== 0 ? `<span class="exit">exit ${code}</span>` : "";
    return `<div class="io"><div class="io-k">IN</div><div class="io-v"><pre>${cmd.html}</pre>${cmd.more}</div>` +
      `<div class="io-k">OUT</div><div class="io-v">${out}${badge}</div></div>`;
  }

  function editBody(model) {
    const input = inputOf(model);
    const file = fileOf(input);
    const actions = file && !model.running && !model.isError
      ? `<div class="tool-actions"><button type="button" class="link" data-diff-id="${esc(model.id)}">Ouvrir le diff</button>` +
        `<button type="button" class="link" data-path="${esc(file)}" data-line="">Ouvrir le fichier</button></div>`
      : "";
    if (model.isError && model.output) return `<pre class="out err">${esc(model.output)}</pre>`;
    return diffHtml(diffRows(model), model, "diff") + actions;
  }

  function todosHtml(todos) {
    return `<ul class="todos">${todos.map((todo) => {
      const status = todo.status || "pending";
      const box = status === "completed" ? "☑" : status === "in_progress" ? "◐" : "☐";
      const text = status === "in_progress" ? todo.activeForm || todo.content : todo.content;
      return `<li class="todo ${esc(status)}"><span class="box">${box}</span><span>${esc(text || "")}</span></li>`;
    }).join("")}</ul>`;
  }

  function pathList(model) {
    const part = clipped(model, "out", model.output, PREVIEW_LINES, (lines) => lines.map((line) => {
      const match = /^(.+?)(?::(\d+))?(?::(.*))?$/.exec(line);
      if (match && ui.looksLikePath(match[1])) {
        return `<div class="pl">${pathChip(match[1], match[2] || "")}${match[3] !== undefined ? `<span class="dim">:${esc(match[3])}</span>` : ""}</div>`;
      }
      return `<div class="pl">${esc(line)}</div>`;
    }).join(""));
    return `<div class="paths">${part.html}</div>${part.more}`;
  }

  function body(model) {
    const input = inputOf(model);
    const name = model.name || "";
    if (SHELL.has(name)) return shellBody(model);
    if (EDITS.has(name) || name === "Write") return editBody(model);
    if (name === "TodoWrite") return Array.isArray(input.todos) ? todosHtml(input.todos) : "";
    if (name === "ExitPlanMode") {
      return `<div class="md plan">${ui.renderMarkdown(String(input.plan || input.planText || ""))}</div>`;
    }
    if (name === "AskUserQuestion") {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      return `<div class="qa">${qs.map((q) => `<div class="qa-q">${esc(q.question || "")}</div>`).join("")}` +
        (model.output ? `<div class="qa-a">${esc(model.output)}</div>` : "") + `</div>`;
    }
    if (isAgent(name)) {
      if (!model.output) return input.prompt ? promptBlock(model) : "";
      const part = clipped(model, "out", model.output, 30, (lines) => ui.renderMarkdown(lines.join("\n")));
      return promptBlock(model) + `<div class="agent-result md${model.isError ? " err" : ""}">${part.html}</div>${part.more}`;
    }
    if (name === "Grep" || name === "Glob") {
      if (!model.output) return "";
      return model.isError ? outputBlock(model) : pathList(model);
    }
    if (name === "Read") return model.isError ? outputBlock(model) : outputBlock(model, "out code-out");
    if (name === "WebSearch" || name === "WebFetch") return outputBlock(model);
    const json = Object.keys(input).length ? `<pre class="json">${esc(JSON.stringify(input, null, 2))}</pre>` : "";
    return json + outputBlock(model);
  }

  function promptBlock(model) {
    const prompt = String(inputOf(model).prompt || "");
    if (!prompt) return "";
    const open = model.expand && model.expand.prompt;
    return open
      ? `<div class="agent-prompt"><div class="dim">Consigne</div><div class="md">${ui.renderMarkdown(prompt)}</div></div>`
      : `<button type="button" class="more" data-more="prompt">Voir la consigne du sous-agent</button>`;
  }

  function defaultOpen(model) {
    const name = model.name || "";
    if (isAgent(name)) return Boolean(model.running);
    if (model.isError) return true;
    return SHELL.has(name) || EDITS.has(name) || name === "Write" || name === "TodoWrite" ||
      name === "ExitPlanMode" || name === "AskUserQuestion";
  }

  /** Libellé de l'indicateur d'activité pour un outil en cours. */
  function activity(model) {
    const input = inputOf(model);
    const name = model.name || "";
    const file = baseName(fileOf(input));
    if (isAgent(name)) return `Sous-agent ${input.subagent_type || ""}${model.detail ? ` · ${model.detail}` : ""}`.trim();
    if (SHELL.has(name)) return `Exécution de ${input.description ? `« ${input.description} »` : name}`;
    if (name === "Read") return `Lecture de ${file}`;
    if (EDITS.has(name) || name === "Write") return `Modification de ${file}`;
    if (name === "Grep" || name === "Glob") return "Recherche dans le code";
    if (name === "WebSearch") return "Recherche sur le web";
    if (name === "WebFetch") return "Lecture d'une page web";
    if (name === "AskUserQuestion") return "En attente de ta réponse";
    return `${name}`;
  }

  ui.tools = { head, body, defaultOpen, isAgent, fileOf, diffStats, activity, todosHtml, baseName };
  ui.diffHtml = (oldText, newText) => diffHtml(lcsRows(oldText, newText));
})(window);
