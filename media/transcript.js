(function (root) {
  const ui = root.AgentUI;
  const esc = (value) => ui.escapeHtml(value == null ? "" : value);
  const models = new Map();
  let log;
  let jump;
  let stick = true;
  let hasKey = true;

  function initTranscript(logEl) {
    log = logEl;
    jump = document.getElementById("jump");
    log.addEventListener("scroll", () => {
      stick = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
      if (stick) jump.hidden = true;
    });
    jump.addEventListener("click", () => {
      stick = true;
      jump.hidden = true;
      log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
    });
    log.addEventListener("click", onClick);
    setInterval(tick, 1000);
    renderEmpty();
  }

  // ---------- utilitaires ----------

  function follow() {
    if (stick) {
      log.scrollTop = log.scrollHeight;
    } else {
      jump.hidden = false;
    }
  }

  function node(id) {
    return log.querySelector(`[data-bid="${CSS.escape(id)}"]`);
  }

  function seconds(value) {
    if (value == null || !isFinite(value)) return "";
    if (value < 1) return "";
    if (value < 10) return `${value.toFixed(1).replace(".", ",")} s`;
    if (value < 60) return `${Math.round(value)} s`;
    const min = Math.floor(value / 60);
    const sec = Math.round(value % 60);
    return `${min} min${sec ? ` ${sec} s` : ""}`;
  }

  function elapsedOf(model) {
    if (model.duration != null) return model.duration;
    if (model.running && model.startedAt) return Math.max(model.elapsed || 0, (Date.now() - model.startedAt) / 1000);
    if (model.streaming && model.startedAt) return (Date.now() - model.startedAt) / 1000;
    return model.elapsed;
  }

  // ---------- état vide / accueil ----------

  function hasContent() {
    return Boolean(log.querySelector(".item, .user-msg"));
  }

  function renderEmpty() {
    let empty = document.getElementById("empty");
    if (hasContent()) {
      if (empty) empty.remove();
      return;
    }
    if (!empty) {
      empty = document.createElement("div");
      empty.id = "empty";
      empty.className = "empty";
      log.appendChild(empty);
    }
    const tips = `<ul class="tips">
        <li><kbd>/</kbd><span>commandes (compact, clear, cost…)</span></li>
        <li><kbd>@</kbd><span>mentionner un fichier du projet</span></li>
        <li><kbd>Maj</kbd>+<kbd>Tab</kbd><span>changer de mode</span></li>
        <li><kbd>Échap</kbd><span>interrompre l'agent</span></li>
      </ul>`;
    empty.innerHTML = hasKey
      ? `<div class="logo">✻</div><h2>SDK Overflow</h2><p>Décris une tâche. Les commandes, les fichiers modifiés et les réflexions s'affichent ici au fil de l'eau.</p>${tips}`
      : `<div class="logo">✻</div><h2>Bienvenue dans SDK Overflow</h2>
        <div class="onboard">
          <p>Pour commencer, connecte une clé API de la Claude Console. Elle est rangée dans le coffre sécurisé de l'éditeur, jamais dans un fichier.</p>
          <button type="button" class="primary" data-action="setKey">Ajouter la clé API</button>
          <a href="#" data-url="https://platform.claude.com/settings/keys">Créer une clé sur la Console ↗</a>
        </div>${tips}`;
  }

  function setWelcome(value) {
    hasKey = Boolean(value);
    if (!hasContent()) renderEmpty();
  }

  // ---------- création des items ----------

  function hostFor(model) {
    if (!model.parent) return log;
    const parent = node(model.parent);
    return (parent && parent.querySelector(":scope > .sublog")) || log;
  }

  function ensure(model) {
    let el = node(model.id);
    if (el) return el;
    document.getElementById("empty")?.remove();
    el = document.createElement("div");
    el.dataset.bid = model.id;
    if (model.kind === "thinking") {
      el.className = "item think";
      el.innerHTML = `<span class="dot glyph">∴</span><div class="think-head"></div><div class="think-body" hidden></div>`;
    } else if (model.kind === "tool") {
      el.className = "item tool";
      el.innerHTML = `<span class="dot"></span><div class="tool-head"></div><div class="tool-sub" hidden></div><div class="tool-body" hidden></div>`;
      if (ui.tools.isAgent(model.name)) {
        const sub = document.createElement("div");
        sub.className = "sublog";
        el.appendChild(sub);
      }
    } else {
      el.className = "item text";
      el.innerHTML = `<span class="dot"></span><div class="md"></div><button type="button" class="copy-msg" title="Copier la réponse">Copier</button>`;
    }
    hostFor(model).appendChild(el);
    if (model.parent) {
      const parent = models.get(model.parent);
      if (parent && model.kind === "tool") {
        parent.children = (parent.children || 0) + 1;
        paint(parent);
      }
    }
    return el;
  }

  function adoptChildren(model, el) {
    const sub = el.querySelector(":scope > .sublog");
    if (!sub) return;
    for (const child of models.values()) {
      if (child.parent !== model.id) continue;
      const childEl = node(child.id);
      if (childEl && childEl.parentElement !== sub) sub.appendChild(childEl);
    }
  }

  // ---------- rendu ----------

  function paintThinking(model, el) {
    const text = String(model.text || "").trim();
    const time = seconds(elapsedOf(model));
    const tokens = model.tokens ? `${model.tokens.toLocaleString("fr-FR")} tokens` : "";
    const meta = [time, model.streaming ? tokens : ""].filter(Boolean).join(" · ");
    const empty = !text && !model.streaming;
    el.classList.toggle("live", Boolean(model.streaming));
    el.classList.toggle("empty-think", empty);
    el.classList.toggle("open", Boolean(model.open) && !empty);
    el.querySelector(".think-head").innerHTML =
      `<span class="tlabel">${model.streaming ? "Réflexion…" : "Réflexion"}</span>` +
      (meta ? `<span class="tmeta">${esc(meta)}</span>` : "") +
      (empty ? `<span class="tmeta">détail non publié par le modèle</span>` : text ? `<span class="chev">›</span>` : "");
    const body = el.querySelector(".think-body");
    body.hidden = !model.open || !text;
    if (!body.hidden) body.textContent = text;
  }

  function paintTool(model, el) {
    const tools = ui.tools;
    if (model.open === undefined || (!model.touched && tools.isAgent(model.name))) model.open = tools.defaultOpen(model);
    el.classList.toggle("run", Boolean(model.running));
    el.classList.toggle("err", Boolean(model.isError));
    el.classList.toggle("ok", model.running === false && !model.isError);
    el.classList.toggle("agent", tools.isAgent(model.name));
    el.classList.toggle("open", Boolean(model.open));
    const h = tools.head(model);
    el.querySelector(".tool-head").innerHTML =
      `<span class="tname">${esc(h.name)}</span>` +
      `<span class="targ">${h.arg || ""}</span>` +
      (h.meta ? `<span class="tmeta">${h.meta}</span>` : "") +
      `<span class="elapsed">${esc(seconds(elapsedOf(model)))}</span>` +
      `<span class="chev">›</span>`;
    const sub = el.querySelector(".tool-sub");
    const detail = tools.isAgent(model.name) && model.running ? model.detail : "";
    sub.hidden = !detail;
    sub.textContent = detail ? `⎿ ${detail}` : "";
    const body = el.querySelector(".tool-body");
    const html = model.open ? tools.body(model) : "";
    body.hidden = !html;
    if (html) body.innerHTML = html;
    const sublog = el.querySelector(":scope > .sublog");
    if (sublog) {
      adoptChildren(model, el);
      sublog.hidden = !model.open || !sublog.childElementCount;
    }
  }

  function paint(model) {
    const el = ensure(model);
    el.classList.toggle("sub", Boolean(model.parent));
    if (model.kind === "thinking") {
      paintThinking(model, el);
    } else if (model.kind === "tool") {
      paintTool(model, el);
    } else {
      el.classList.toggle("live", Boolean(model.streaming));
      el.querySelector(".md").innerHTML = ui.renderMarkdown(model.text || "");
    }
    if (ui.activity) ui.activity.track(model);
  }

  function tick() {
    for (const model of models.values()) {
      const live = (model.kind === "tool" && model.running && model.startedAt) ||
        (model.kind === "thinking" && model.streaming && model.startedAt);
      if (!live) continue;
      const el = node(model.id);
      if (!el) continue;
      if (model.kind === "tool") {
        const span = el.querySelector(":scope > .tool-head .elapsed");
        if (span) span.textContent = seconds(elapsedOf(model));
      } else {
        paintThinking(model, el);
      }
    }
  }

  // ---------- événements de l'hôte ----------

  function upsert(block) {
    const prev = models.get(block.id);
    const model = Object.assign({}, prev || {}, block);
    if (!prev && (block.running || block.streaming)) model.startedAt = Date.now();
    models.set(block.id, model);
    paint(model);
    if (model.name === "TodoWrite" && ui.activity) ui.activity.todos(model.input && model.input.todos);
    follow();
  }

  function patch(id, change) {
    if (change.remove) {
      node(id)?.remove();
      models.delete(id);
      if (ui.activity) ui.activity.forget(id);
      if (!hasContent()) renderEmpty();
      return;
    }
    const model = models.get(id) || { id, kind: "text", text: "" };
    if (change.append) model.text = (model.text || "") + change.append;
    if (change.text !== undefined) model.text = change.text;
    if (change.streaming !== undefined) {
      if (model.streaming && !change.streaming && model.kind === "thinking" && model.startedAt && model.duration == null) {
        model.duration = (Date.now() - model.startedAt) / 1000;
      }
      model.streaming = change.streaming;
    }
    if (change.running !== undefined) model.running = change.running;
    if (change.tokens !== undefined) model.tokens = change.tokens;
    if (change.input) model.input = change.input;
    if (change.detail !== undefined) model.detail = change.detail;
    models.set(id, model);
    paint(model);
    if (model.name === "TodoWrite" && change.input && ui.activity) ui.activity.todos(model.input.todos);
    follow();
  }

  function toolResult(id, output, isError, edit) {
    const model = models.get(id) || { id, kind: "tool", name: "Outil", input: {} };
    model.output = output;
    model.isError = isError;
    if (edit) model.edit = edit;
    if (model.running && model.startedAt) model.duration = (Date.now() - model.startedAt) / 1000;
    model.running = false;
    model.streaming = false;
    models.set(id, model);
    paint(model);
    if (ui.activity) ui.activity.fileChanged(model);
    follow();
  }

  function toolProgress(id, elapsed) {
    const model = models.get(id);
    if (!model) return;
    model.elapsed = elapsed;
    if (model.running === false) return;
    model.running = true;
    const span = node(id)?.querySelector(":scope > .tool-head .elapsed");
    if (span) span.textContent = seconds(elapsedOf(model));
  }

  function append(className, html) {
    document.getElementById("empty")?.remove();
    const el = document.createElement("div");
    el.className = className;
    el.innerHTML = html;
    log.appendChild(el);
    follow();
    return el;
  }

  function userMessage(text, images) {
    const thumbs = (images || []).map((img) =>
      `<img class="thumb" src="data:${img.mediaType};base64,${img.data}" alt="${esc(img.name)}">`).join("");
    append("user-msg", (thumbs ? `<div class="thumbs">${thumbs}</div>` : "") + `<div class="user-text">${esc(text || "")}</div>`);
    stick = true;
    jump.hidden = true;
    follow();
  }

  function turnEnd(info) {
    const parts = [];
    if (info.turns) parts.push(`${info.turns} étape${info.turns > 1 ? "s" : ""}`);
    if (info.delta) parts.push(`+${ui.formatUsd(info.delta)}`);
    const time = seconds(info.seconds);
    if (time) parts.push(time);
    if (parts.length) append("turn", esc(parts.join(" · ")));
  }

  function clear() {
    models.clear();
    log.innerHTML = "";
    stick = true;
    jump.hidden = true;
    renderEmpty();
  }

  // ---------- clics dans le fil ----------

  function onClick(event) {
    const target = event.target;
    if (target.closest(".path, a, [data-diff-id], [data-path], [data-url], [data-action]")) return;
    const item = target.closest("[data-bid]");
    const more = target.closest("[data-more]");
    if (more && item) {
      const model = models.get(item.dataset.bid);
      if (!model) return;
      model.expand = Object.assign({}, model.expand, { [more.dataset.more]: true });
      paint(model);
      return;
    }
    const copy = target.closest(".copy-msg");
    if (copy && item) {
      const model = models.get(item.dataset.bid);
      if (model) ui.copy(model.text || "", copy);
      return;
    }
    const head = target.closest(".tool-head, .think-head");
    if (head && item && head.parentElement === item) {
      const model = models.get(item.dataset.bid);
      if (!model) return;
      if (model.kind === "thinking" && !String(model.text || "").trim()) return;
      model.open = !model.open;
      model.touched = true;
      paint(model);
    }
  }

  ui.initTranscript = initTranscript;
  ui.upsert = upsert;
  ui.patch = patch;
  ui.toolResult = toolResult;
  ui.toolProgress = toolProgress;
  ui.userMessage = userMessage;
  ui.turnEnd = turnEnd;
  ui.setWelcome = setWelcome;
  ui.modelOf = (id) => models.get(id);
  ui.notice = (text) => append("item notice", `<span class="dot"></span>${esc(text)}`);
  ui.error = (text) => append("item error", `<span class="dot"></span>${esc(text)}`);
  ui.clearTranscript = clear;
  ui.stick = (value) => { stick = value; if (value) { jump.hidden = true; follow(); } };
})(window);
