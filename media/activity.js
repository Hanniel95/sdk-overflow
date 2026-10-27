(function (root) {
  const ui = root.AgentUI;
  const esc = (value) => ui.escapeHtml(value == null ? "" : value);
  const running = new Map();
  const files = new Map();
  let todos = [];
  let busy = false;
  let turnStart = 0;
  let statusText = null;
  let cwd = "";
  let filesOpen = false;
  let todosOpen = false;
  let timer = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function initActivity() {
    $("strips").addEventListener("click", (event) => {
      const head = event.target.closest("[data-strip]");
      if (!head) return;
      if (head.dataset.strip === "files") filesOpen = !filesOpen;
      else todosOpen = !todosOpen;
      renderFiles();
      renderTodos();
    });
  }

  function norm(file) {
    return String(file || "").replace(/\\/g, "/");
  }

  function relPath(file) {
    const text = norm(file);
    const base = norm(cwd).replace(/\/$/, "");
    if (base && text.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return text.slice(base.length + 1);
    return text;
  }

  function setCwd(value) {
    cwd = value || "";
  }

  // ---------- indicateur ----------

  function track(model) {
    const live = (model.kind === "tool" && model.running) || (model.kind === "thinking" && model.streaming);
    if (live) running.set(model.id, model);
    else running.delete(model.id);
    renderSpinner();
  }

  function forget(id) {
    running.delete(id);
    renderSpinner();
  }

  function label() {
    if (statusText) return statusText;
    const list = [...running.values()];
    const tool = list.reverse().find((model) => model.kind === "tool" && !model.streaming) ||
      list.find((model) => model.kind === "tool");
    if (tool) return `${ui.tools.activity(tool)}…`;
    if (list.some((model) => model.kind === "thinking")) return "Réflexion…";
    return "Travail en cours…";
  }

  function turnSeconds() {
    return turnStart ? (Date.now() - turnStart) / 1000 : 0;
  }

  function clock(sec) {
    const s = Math.floor(sec);
    if (s < 60) return `${s} s`;
    return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  }

  function renderSpinner() {
    const el = $("spinner");
    const show = busy || Boolean(statusText);
    el.hidden = !show;
    if (!show) return;
    if (!el.firstChild) {
      el.innerHTML = `<span class="spin-glyph" aria-hidden="true"></span><span class="spin-label"></span><span class="spin-meta"></span>`;
    }
    el.querySelector(".spin-label").textContent = label();
    el.querySelector(".spin-meta").textContent = busy ? `(${clock(turnSeconds())} · Échap pour interrompre)` : "";
  }

  function setBusy(value) {
    if (value && !busy) turnStart = Date.now();
    busy = value;
    if (!value) running.clear();
    clearInterval(timer);
    if (busy) timer = setInterval(renderSpinner, 1000);
    renderSpinner();
    renderTodos();
  }

  function setStatus(text) {
    statusText = text || null;
    renderSpinner();
  }

  // ---------- tâches ----------

  function setTodos(list) {
    todos = Array.isArray(list) ? list : [];
    renderTodos();
  }

  function renderTodos() {
    const el = $("todos");
    const done = todos.filter((todo) => todo.status === "completed").length;
    const finished = todos.length > 0 && done === todos.length;
    el.hidden = !todos.length || (finished && !busy);
    if (el.hidden) return;
    const current = todos.find((todo) => todo.status === "in_progress");
    const title = current ? current.activeForm || current.content : finished ? "Toutes les tâches sont faites" : "Tâches";
    el.classList.toggle("open", todosOpen);
    el.innerHTML = `<button type="button" class="strip-head" data-strip="todos">` +
      `<span class="chev">›</span><span class="strip-icon">${current ? "◐" : finished ? "☑" : "☐"}</span>` +
      `<span class="strip-title">${esc(title)}</span><span class="strip-meta">${done}/${todos.length}</span></button>` +
      (todosOpen ? `<div class="strip-body">${ui.tools.todosHtml(todos)}</div>` : "");
  }

  // ---------- fichiers modifiés ----------

  function fileChanged(model) {
    const name = model.name || "";
    if (!["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name) || model.isError) return;
    const abs = norm((model.edit && model.edit.file) || ui.tools.fileOf(model.input || {}));
    if (!abs) return;
    const key = abs.toLowerCase();
    const stats = ui.tools.diffStats(model);
    const row = files.get(key) || { abs, rel: (model.edit && model.edit.rel) || relPath(abs), added: 0, removed: 0, created: false };
    row.added += stats.added;
    row.removed += stats.removed;
    if (model.edit && model.edit.kind === "create") row.created = true;
    files.delete(key);
    files.set(key, row);
    renderFiles();
  }

  function renderFiles() {
    const el = $("files");
    el.hidden = files.size === 0;
    if (el.hidden) return;
    let added = 0;
    let removed = 0;
    for (const row of files.values()) {
      added += row.added;
      removed += row.removed;
    }
    const rows = [...files.values()].reverse();
    el.classList.toggle("open", filesOpen);
    el.innerHTML = `<button type="button" class="strip-head" data-strip="files">` +
      `<span class="chev">›</span><span class="strip-title">${files.size} fichier${files.size > 1 ? "s" : ""} modifié${files.size > 1 ? "s" : ""}</span>` +
      `<span class="strip-meta"><span class="stat add">+${added}</span> <span class="stat del">−${removed}</span></span></button>` +
      (filesOpen
        ? `<div class="strip-body files-list">${rows.map((row) =>
          `<div class="frow"><button type="button" class="path" data-path="${esc(row.abs)}" data-line="" title="${esc(row.abs)}">${esc(row.rel)}</button>` +
          (row.created ? `<span class="tag">nouveau</span>` : "") +
          `<span class="frow-stats"><span class="stat add">+${row.added}</span> <span class="stat del">−${row.removed}</span></span>` +
          `<button type="button" class="link" data-diff-file="${esc(row.abs)}">diff</button></div>`).join("")}</div>`
        : "");
  }

  function reset() {
    files.clear();
    todos = [];
    running.clear();
    renderFiles();
    renderTodos();
    renderSpinner();
  }

  ui.relPath = relPath;
  ui.initActivity = initActivity;
  ui.activity = {
    track,
    forget,
    todos: setTodos,
    fileChanged,
    setBusy,
    setStatus,
    setCwd,
    turnSeconds,
    reset,
  };
})(window);
