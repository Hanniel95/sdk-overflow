(function (root) {
  const ui = root.AgentUI;
  const FALLBACK = [
    { name: "compact", description: "Résume le contexte pour réduire la consommation", argumentHint: "" },
    { name: "clear", description: "Vide la conversation", argumentHint: "" },
    { name: "cost", description: "Affiche le coût de la session", argumentHint: "" },
    { name: "usage", description: "Affiche l'usage", argumentHint: "" },
    { name: "help", description: "Liste les commandes", argumentHint: "" },
    { name: "review", description: "Relit les changements", argumentHint: "" },
  ];
  /** Commandes de l'extension : exécutées ici, jamais envoyées à l'agent. */
  const LOCAL = [
    { name: "api-key", description: "Changer la clé API Claude Console", argumentHint: "", local: "setKey" },
    { name: "reset-spend", description: "Remettre à zéro le compteur de dépense", argumentHint: "", local: "resetSpent" },
    { name: "new", description: "Ouvrir une nouvelle session", argumentHint: "", local: "newSession" },
  ];

  const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
  const ICON = {
    hand: svg('<path d="M8.5 12.5V6a1.5 1.5 0 0 1 3 0v5"/><path d="M11.5 10.5V4.5a1.5 1.5 0 0 1 3 0v6"/><path d="M14.5 10.5v-4a1.5 1.5 0 0 1 3 0V14a6.5 6.5 0 0 1-6.5 6.5h-.6a6.5 6.5 0 0 1-5-2.4L3 14.6a1.5 1.5 0 0 1 2.3-1.9l3.2 3.1"/>'),
    code: svg('<path d="m9 7-5 5 5 5M15 7l5 5-5 5"/>'),
    plan: svg('<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8 9h8M8 12.5h8M8 16h4.5"/>'),
    bolt: svg('<path d="M13 3 5 13.5h6l-1 7.5 8-10.5h-6l1-7.5z"/>'),
    upload: svg('<path d="M12 15V4.5M7.5 9 12 4.5 16.5 9"/><path d="M4.5 15v3A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-3"/>'),
    file: svg('<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M9 12.5h6M9 16h4"/>'),
    globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5z"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>'),
    chev: svg('<path d="m9 6 6 6-6 6"/>'),
    effort: svg('<path d="M6.5 7.5v9M17.5 7.5v9M3.5 10v4M20.5 10v4M6.5 12h11"/>'),
  };

  const MODES = [
    { value: "default", name: "Manuel", pill: "Manuel", icon: ICON.hand, description: "L'agent demande ton accord avant chaque modification" },
    { value: "acceptEdits", name: "Éditer automatiquement", pill: "Éditer auto", icon: ICON.code, description: "L'agent modifie les fichiers sans demander. Les commandes demandent encore." },
    { value: "plan", name: "Plan", pill: "Plan", icon: ICON.plan, description: "L'agent explore le code et présente un plan avant de modifier" },
    { value: "auto", name: "Auto", pill: "Auto", icon: ICON.bolt, description: "L'agent valide ce qui passe un contrôle de sécurité et s'arrête sur tout ce qui est risqué" },
  ];
  const EFFORTS = [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
    { value: "xhigh", name: "Extra" },
    { value: "max", name: "Max" },
  ];
  const FALLBACK_MODELS = [
    { value: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5 · Pour le travail difficile" },
    { value: "claude-sonnet-5-5", displayName: "Sonnet", description: "Sonnet 5.5 · Pour le travail courant" },
    { value: "claude-haiku-5-5", displayName: "Haiku", description: "Haiku 5.5 · Le plus rapide" },
  ];
  const HEAD_MENUS = new Set(["sessions"]);
  /**
   * Placement des menus de la saisie, comme dans Claude Code : les menus « larges » couvrent toute
   * la largeur de la zone, au-dessus d'elle ; les autres s'ouvrent juste au-dessus de leur bouton.
   */
  const ANCHORS = { plus: { button: "plus", side: "left" }, mode: { button: "modebtn", side: "right" } };
  const RING = 2 * Math.PI * 7;

  let vscode;
  let commands = FALLBACK.slice();
  let modelChoices = FALLBACK_MODELS.slice();
  let agents = [];
  let sessions = [];
  let sessionQuery = "";
  let actionQuery = "";
  let showArchived = false;
  let model = "sonnet";
  let mode = "default";
  let effort = "high";
  let account = { spent: 0, maxUsd: 0, hasKey: true };
  let context = null;
  let openMenu = null;
  let files = [];
  let pending = [];
  let busy = false;
  let web = false;
  let palMode = null;
  let palItems = [];
  let hi = 0;
  let mention = null;
  let timer = 0;
  let lastSent = "";
  let dragDepth = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function initComposer(api) {
    vscode = api;
    const input = $("input");
    $("send").addEventListener("click", send);
    $("stop").addEventListener("click", stop);
    $("newbtn").addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
    $("plus").addEventListener("click", () => toggleMenu("plus"));
    $("modelbtn").addEventListener("click", () => toggleMenu("model"));
    $("modebtn").addEventListener("click", () => toggleMenu("mode"));
    $("webchip").addEventListener("click", () => setWeb(false));
    $("slash").addEventListener("click", () => {
      closePalette();
      actionQuery = "";
      toggleMenu("actions");
    });
    $("history").addEventListener("click", () => {
      vscode.postMessage({ type: "listSessions" });
      sessionQuery = "";
      toggleMenu("sessions");
    });
    document.addEventListener("mousedown", (event) => {
      if (!event.target.closest(".composer, .top")) closeMenu();
    });
    window.addEventListener("resize", () => {
      const anchor = ANCHORS[openMenu];
      if (anchor) placeAt($("pop"), $(anchor.button), anchor.side);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && event.ctrlKey) {
        event.preventDefault();
        if (document.activeElement === input) vscode.postMessage({ type: "unfocus" });
        else focusInput();
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (openMenu) {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (busy && !ui.sheetOpen() && $("palette").hidden) {
        event.preventDefault();
        stop();
      }
    });

    input.addEventListener("keydown", onKey);
    input.addEventListener("input", () => {
      autosize();
      refreshPalette();
      paintSend();
    });
    input.addEventListener("paste", onPaste);
    initDrop();
    $("palette").addEventListener("mousedown", (event) => event.preventDefault());
    $("attachments").addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove]");
      if (remove) {
        pending.splice(Number(remove.dataset.remove), 1);
        renderPending();
        return;
      }
      const chip = event.target.closest("[data-preview]");
      if (chip) {
        const img = pending[Number(chip.dataset.preview)];
        if (img) ui.preview(`data:${img.mediaType};base64,${img.data}`, img.name);
      }
    });
    paintPills();
    paintSend();
  }

  function focusInput() {
    const input = $("input");
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function autosize() {
    const input = $("input");
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
  }

  function stop() {
    vscode.postMessage({ type: "stop" });
  }

  function formatUsd(value) {
    const n = Number(value) || 0;
    return n < 1 ? `${n.toFixed(3).replace(".", ",")} $` : `${n.toFixed(2).replace(".", ",")} $`;
  }

  function setState(msg) {
    if (msg.model) model = msg.model;
    if (msg.mode) mode = msg.mode;
    if (msg.effort) effort = msg.effort;
    account = { spent: Number(msg.spent) || 0, maxUsd: Number(msg.maxUsd) || 0, hasKey: Boolean(msg.hasKey) };
    if (ui.activity) ui.activity.setCwd(msg.cwd);
    ui.setWelcome(account.hasKey);
    paintPills();
    paintRing();
    if (openMenu) renderMenu();
  }

  function setContext(msg) {
    const max = Number(msg.max) || 0;
    if (!max) {
      context = null;
    } else {
      const pct = Math.max(0, Math.min(100, Number(msg.percentage) || (msg.used / max) * 100));
      context = { used: Number(msg.used) || 0, max, pct };
    }
    paintRing();
  }

  function paintRing() {
    const ring = $("ring");
    if (!context) {
      ring.hidden = true;
      return;
    }
    ring.hidden = false;
    const fill = $("ring-fill");
    fill.setAttribute("stroke-dasharray", `${RING}`);
    fill.setAttribute("stroke-dashoffset", `${RING * (1 - context.pct / 100)}`);
    ring.classList.toggle("hot", context.pct >= 75);
    ring.title = `Contexte : ${Math.round(context.pct)} % (${context.used.toLocaleString("fr-FR")} / ${context.max.toLocaleString("fr-FR")} tokens). /compact pour le réduire.\n` +
      `Dépensé : ${formatUsd(account.spent)} / ${account.maxUsd} $`;
  }

  function resetContext() {
    context = null;
    paintRing();
  }

  function setBusy(value) {
    busy = value;
    paintSend();
    if (ui.activity) ui.activity.setBusy(value);
  }

  function paintSend() {
    const empty = !$("input").value.trim() && pending.length === 0;
    $("stop").hidden = !(busy && empty);
    $("send").hidden = busy && empty;
    $("send").disabled = empty;
  }

  function setMode(value) {
    if (value) mode = value;
    paintPills();
  }

  function setModels(list) {
    if (Array.isArray(list) && list.length) modelChoices = list;
    paintPills();
    if (openMenu === "model") renderMenu();
  }

  function setAgents(list) {
    agents = Array.isArray(list) ? list : [];
  }

  function setSessions(rows) {
    sessions = Array.isArray(rows) ? rows : [];
    if (openMenu === "sessions") renderSessionRows();
  }

  function currentModel() {
    return modelChoices.find((item) => item.value === model || item.value === alias(model));
  }

  /** Nom court du modèle, comme dans la pastille de Claude Code (« Opus 5.5 »). */
  function modelLabel() {
    const found = currentModel();
    if (found) {
      const head = String(found.description || "").split("·")[0].trim();
      if (head && head.length <= 24 && /\d/.test(head)) return head;
      return found.displayName;
    }
    if (model === "opus") return "Opus 5.5";
    if (model === "haiku") return "Haiku 5.5";
    if (model === "sonnet") return "Sonnet 5.5";
    return model;
  }

  function alias(value) {
    if (value === "opus") return "claude-opus-5-5";
    if (value === "haiku") return "claude-haiku-5-5";
    if (value === "sonnet") return "claude-sonnet-5-5";
    return value;
  }

  function effortName() {
    return (EFFORTS.find((item) => item.value === effort) || EFFORTS[2]).name;
  }

  function currentMode() {
    return MODES.find((item) => item.value === mode) || MODES[0];
  }

  function paintPills() {
    const btn = $("modelbtn");
    btn.querySelector(".mname").textContent = modelLabel();
    btn.querySelector(".meffort").textContent = effortName();
    const current = currentMode();
    const modeBtn = $("modebtn");
    modeBtn.innerHTML = `${current.icon}<span>${ui.escapeHtml(current.pill)}</span>`;
    modeBtn.className = `modebtn mode-${current.value}`;
    modeBtn.title = `${current.name} : ${current.description} (Maj+Tab pour changer)`;
  }

  function applyMode(value) {
    mode = value;
    paintPills();
    vscode.postMessage({ type: "mode", value });
  }

  function cycleMode() {
    const index = MODES.findIndex((item) => item.value === mode);
    applyMode(MODES[(index + 1) % MODES.length].value);
    if (openMenu === "mode") renderMenu();
  }

  function applyEffort(value) {
    effort = value;
    paintPills();
    vscode.postMessage({ type: "effort", value });
    if (openMenu) renderMenu();
  }

  function setWeb(value) {
    web = value;
    $("webchip").hidden = !web;
    $("webchip").title = "Recherche web activée pour les prochains messages. Clic pour la couper.";
  }

  // ---------- menus ----------

  function toggleMenu(name) {
    openMenu = openMenu === name ? null : name;
    renderMenu();
  }

  function closeMenu() {
    if (!openMenu) return;
    openMenu = null;
    renderMenu();
  }

  function renderMenu() {
    const pop = $("pop");
    const head = $("headpop");
    for (const el of [pop, head]) {
      el.hidden = true;
      el.innerHTML = "";
    }
    for (const prop of ["left", "right", "bottom"]) pop.style[prop] = "";
    if (!openMenu) return;
    const target = HEAD_MENUS.has(openMenu) ? head : pop;
    const anchor = ANCHORS[openMenu];
    target.className = `pop ${HEAD_MENUS.has(openMenu) ? "head" : anchor ? "anchored" : "wide"} ${openMenu}`;
    target.hidden = false;
    if (anchor) placeAt(pop, $(anchor.button), anchor.side);
    if (openMenu === "plus") renderPlus(target);
    else if (openMenu === "model") renderModels(target);
    else if (openMenu === "mode") renderModes(target);
    else if (openMenu === "actions") renderActions(target);
    else renderSessions(target);
  }

  /** Bas du menu juste au-dessus du bouton, bord aligné sur le bouton (à gauche ou à droite). */
  function placeAt(pop, button, side) {
    const box = $("composer").getBoundingClientRect();
    const btn = button.getBoundingClientRect();
    pop.style.bottom = `${Math.round(box.bottom - btn.top + 6)}px`;
    if (side === "left") {
      pop.style.left = `${Math.round(btn.left - box.left)}px`;
      pop.style.right = "auto";
    } else {
      pop.style.right = `${Math.round(box.right - btn.right)}px`;
      pop.style.left = "auto";
    }
  }

  // ---------- menu d'actions (bouton /) ----------

  function shortModelName() {
    const found = currentModel();
    return found ? found.displayName : modelLabel();
  }

  function actionSections() {
    const input = $("input");
    const sections = [
      {
        title: "Contexte",
        items: [
          { label: "Joindre un fichier…", run: () => vscode.postMessage({ type: "pickImages" }) },
          {
            label: "Mentionner un fichier du projet…",
            run: () => {
              input.value = `${input.value}${input.value && !input.value.endsWith(" ") ? " " : ""}@`;
              input.focus();
              refreshPalette();
            },
          },
          { label: "Vider la conversation", run: () => vscode.postMessage({ type: "clear" }) },
          { label: "Compacter la conversation", run: () => sendCommand("/compact") },
          { label: "Exporter la conversation", run: () => vscode.postMessage({ type: "export" }) },
        ],
      },
      {
        title: "Modèle",
        items: [
          { label: "Changer de modèle…", meta: shortModelName(), keep: true, run: () => toggleMenu("model") },
          { label: "Changer de mode…", meta: currentMode().pill, keep: true, run: () => toggleMenu("mode") },
          { effort: true, label: "Effort" },
        ],
      },
      {
        title: "Compte",
        items: [
          { label: account.hasKey ? "Changer la clé API…" : "Ajouter la clé API…", run: () => vscode.postMessage({ type: "setKey" }) },
          { label: "Remettre à zéro le compteur de dépense", meta: formatUsd(account.spent), run: () => vscode.postMessage({ type: "resetSpent" }) },
          { label: "Nouvelle session", run: () => vscode.postMessage({ type: "newSession" }) },
        ],
      },
      {
        title: "Commandes",
        items: commands.map((cmd) => ({
          label: `/${cmd.name}`,
          meta: cmd.description,
          mono: true,
          run: () => {
            input.value = `/${cmd.name} `;
            input.focus();
            paintSend();
          },
        })),
      },
    ];
    return sections;
  }

  function sendCommand(text) {
    ui.stick(true);
    ui.userMessage(text, [], Date.now());
    vscode.postMessage({ type: "send", text, images: [] });
    if (!busy) setBusy(true);
  }

  function renderActions(pop) {
    const search = document.createElement("label");
    search.className = "menu-filter";
    search.innerHTML = `<input id="action-q" type="text" placeholder="Filtrer les actions…" autocomplete="off">`;
    pop.appendChild(search);
    const field = search.querySelector("input");
    field.value = actionQuery;
    const body = document.createElement("div");
    body.className = "action-list";
    pop.appendChild(body);
    const paint = () => {
      body.innerHTML = "";
      const q = actionQuery.trim().toLowerCase();
      let first = true;
      for (const section of actionSections()) {
        const items = section.items.filter((item) =>
          !q || `${item.label} ${item.meta || ""}`.toLowerCase().includes(q));
        if (!items.length) continue;
        if (!first) divider(body);
        first = false;
        const title = document.createElement("div");
        title.className = "menu-section";
        title.textContent = section.title;
        body.appendChild(title);
        for (const item of items) {
          if (item.effort) {
            effortSlider(body);
            continue;
          }
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `act${item.mono ? " mono-label" : ""}`;
          btn.innerHTML = `<span class="act-label">${ui.escapeHtml(item.label)}</span>` +
            (item.meta ? `<span class="act-meta">${ui.escapeHtml(item.meta)}</span>` : "");
          btn.addEventListener("click", () => {
            if (!item.keep) closeMenu();
            item.run();
          });
          body.appendChild(btn);
        }
      }
      if (first) {
        const empty = document.createElement("div");
        empty.className = "menu-empty";
        empty.textContent = "Aucune action ne correspond.";
        body.appendChild(empty);
      }
    };
    field.addEventListener("input", () => {
      actionQuery = field.value;
      paint();
    });
    field.addEventListener("keydown", (event) => {
      const items = [...body.querySelectorAll(".act")];
      if (event.key === "Enter") {
        event.preventDefault();
        items[0]?.click();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        items[0]?.focus();
      }
    });
    body.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...body.querySelectorAll(".act")];
      const index = items.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = index + (event.key === "ArrowDown" ? 1 : -1);
      if (next < 0) field.focus();
      else items[Math.min(next, items.length - 1)].focus();
    });
    paint();
    setTimeout(() => field.focus(), 0);
  }

  function menuHead(parent, title, hint) {
    const el = document.createElement("div");
    el.className = "menu-head";
    el.innerHTML = `<span>${ui.escapeHtml(title)}</span>${hint || ""}`;
    parent.appendChild(el);
  }

  function divider(parent) {
    const el = document.createElement("div");
    el.className = "divider";
    parent.appendChild(el);
  }

  /** Ligne de menu : icône facultative, titre, description, coche à droite. */
  function row(parent, opts) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `row${opts.selected ? " on" : ""}${opts.cls ? ` ${opts.cls}` : ""}`;
    btn.innerHTML =
      (opts.icon ? `<span class="row-icon">${opts.icon}</span>` : "") +
      `<span class="row-main"><span class="name">${ui.escapeHtml(opts.title)}</span>` +
      (opts.description ? `<span class="desc">${ui.escapeHtml(opts.description)}</span>` : "") +
      `</span>` +
      (opts.meta ? `<span class="row-meta">${ui.escapeHtml(opts.meta)}</span>` : "") +
      (opts.selected ? `<span class="row-check">${ICON.check}</span>` : "");
    btn.addEventListener("click", opts.onClick);
    parent.appendChild(btn);
    return btn;
  }

  /** Curseur d'effort à cinq crans, comme dans Claude Code. */
  function effortSlider(parent) {
    const wrap = document.createElement("div");
    wrap.className = "effort-row";
    wrap.innerHTML = `<span class="row-icon">${ICON.effort}</span><span class="effort-label">Effort <span class="dim">(${ui.escapeHtml(effortName())})</span></span>`;
    const track = document.createElement("div");
    track.className = "dots";
    track.setAttribute("role", "slider");
    track.setAttribute("tabindex", "0");
    track.setAttribute("aria-label", "Effort");
    track.setAttribute("aria-valuetext", effortName());
    const index = Math.max(0, EFFORTS.findIndex((item) => item.value === effort));
    EFFORTS.forEach((item, i) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = i === index ? "dot on" : "dot";
      dot.title = item.name;
      dot.tabIndex = -1;
      dot.addEventListener("click", () => applyEffort(item.value));
      track.appendChild(dot);
    });
    track.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = Math.min(EFFORTS.length - 1, Math.max(0, index + (event.key === "ArrowRight" ? 1 : -1)));
      applyEffort(EFFORTS[next].value);
      document.querySelector(".pop .dots")?.focus();
    });
    wrap.appendChild(track);
    parent.appendChild(wrap);
  }

  function renderPlus(pop) {
    row(pop, {
      icon: ICON.upload,
      title: "Importer depuis l'ordinateur",
      onClick: () => {
        closeMenu();
        vscode.postMessage({ type: "pickImages" });
      },
    });
    row(pop, {
      icon: ICON.file,
      title: "Ajouter du contexte",
      onClick: () => {
        closeMenu();
        const input = $("input");
        input.value = `${input.value}${input.value && !input.value.endsWith(" ") ? " " : ""}@`;
        input.focus();
        refreshPalette();
      },
    });
    row(pop, {
      icon: ICON.globe,
      title: "Rechercher sur le web",
      selected: web,
      onClick: () => {
        closeMenu();
        setWeb(!web);
        $("input").focus();
      },
    });
  }

  function renderModels(pop) {
    menuHead(pop, "Choisir un modèle");
    for (const item of modelChoices) {
      row(pop, {
        title: item.displayName,
        description: item.description,
        selected: item.value === model || item.value === alias(model),
        onClick: () => {
          model = item.value;
          paintPills();
          closeMenu();
          vscode.postMessage({ type: "model", value: item.value });
        },
      });
    }
    effortSlider(pop);
  }

  function renderModes(pop) {
    menuHead(pop, "Modes", `<span class="kbd-hint"><kbd>⇧</kbd> + <kbd>tab</kbd> pour changer</span>`);
    for (const item of MODES) {
      row(pop, {
        icon: item.icon,
        title: item.name,
        description: item.description,
        selected: item.value === mode,
        cls: `mode-row mode-${item.value}`,
        onClick: () => {
          closeMenu();
          applyMode(item.value);
        },
      });
    }
    divider(pop);
    effortSlider(pop);
  }

  function renderSessions(pop) {
    const search = document.createElement("label");
    search.className = "menu-search";
    search.innerHTML = `${ICON.search}<input id="session-q" type="text" placeholder="Rechercher une session…" autocomplete="off">`;
    pop.appendChild(search);
    const field = search.querySelector("input");
    field.value = sessionQuery;
    field.addEventListener("input", () => {
      sessionQuery = field.value;
      renderSessionRows();
    });
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        pop.querySelector(".session-list .row")?.click();
      }
    });
    const listEl = document.createElement("div");
    listEl.className = "session-list";
    pop.appendChild(listEl);
    renderSessionRows();
    setTimeout(() => field.focus(), 0);
  }

  function renderSessionRows() {
    const listEl = document.querySelector("#headpop .session-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    const q = sessionQuery.trim().toLowerCase();
    const match = (item) => !q || String(item.title || "").toLowerCase().includes(q);
    const active = sessions.filter((item) => !item.archived && match(item));
    const archived = sessions.filter((item) => item.archived && match(item));
    const add = (item) => row(listEl, {
      title: item.title || "Session",
      meta: ago(item.when),
      selected: false,
      cls: item.open ? "current" : "",
      onClick: () => {
        closeMenu();
        vscode.postMessage({ type: "openSession", id: item.id });
      },
    });
    if (!active.length && !archived.length) {
      const empty = document.createElement("div");
      empty.className = "menu-empty";
      empty.textContent = q ? "Aucune session ne correspond." : "Aucune session pour l'instant.";
      listEl.appendChild(empty);
      return;
    }
    active.forEach(add);
    if (!archived.length) return;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `archived-toggle${showArchived ? " open" : ""}`;
    toggle.innerHTML = `<span class="chev">${ICON.chev}</span><span>Sessions archivées</span><span class="count">${archived.length}</span>`;
    toggle.addEventListener("click", () => {
      showArchived = !showArchived;
      renderSessionRows();
    });
    listEl.appendChild(toggle);
    if (showArchived) archived.forEach(add);
  }

  /** Durée courte comme dans Claude Code : 17m, 3h, 1d. */
  function ago(ms) {
    if (!ms) return "";
    const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (min < 1) return "maint.";
    if (min < 60) return `${min}m`;
    const hours = Math.round(min / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}j`;
  }

  // ---------- palette / et @ ----------

  function setCommands(list) {
    if (Array.isArray(list) && list.length) commands = list;
    if (palMode === "slash") refreshPalette();
  }

  function setFiles(list) {
    files = Array.isArray(list) ? list : [];
    if (palMode !== "files") return;
    renderPalette(files.length
      ? files.map((file) => ({ name: file, description: "" }))
      : [{ name: "Aucun fichier", description: "", placeholder: true }]);
  }

  /** Texte venu de l'hôte : sélection de code (nouvelle ligne) ou mention de fichier (à la suite). */
  function insert(text, inline) {
    const input = $("input");
    if (inline) {
      const pos = input.selectionStart ?? input.value.length;
      const before = input.value.slice(0, pos);
      const sep = before && !/\s$/.test(before) ? " " : "";
      input.value = `${before}${sep}${text}${input.value.slice(pos)}`;
      const caret = before.length + sep.length + text.length;
      input.focus();
      input.setSelectionRange(caret, caret);
    } else {
      input.value = (input.value ? `${input.value}\n` : "") + text;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    autosize();
    refreshPalette();
    paintSend();
  }

  function send() {
    if (ui.sheetOpen()) return;
    const input = $("input");
    const text = input.value.trim();
    if (!text && pending.length === 0) return;
    const local = LOCAL.find((cmd) => text === `/${cmd.name}`);
    if (local) {
      vscode.postMessage({ type: local.local });
      input.value = "";
      closePalette();
      autosize();
      paintSend();
      return;
    }
    closePalette();
    ui.stick(true);
    ui.userMessage(text, pending, Date.now());
    vscode.postMessage({ type: "send", text, images: pending, web });
    if (text) lastSent = text;
    input.value = "";
    pending = [];
    renderPending();
    autosize();
    if (!busy) setBusy(true);
    paintSend();
  }

  function slashQuery() {
    const value = $("input").value;
    if (!value.startsWith("/") || /[\s\n]/.test(value)) return null;
    return value.slice(1);
  }

  function mentionQuery() {
    const input = $("input");
    const upto = input.value.slice(0, input.selectionStart);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(upto);
    if (!match) return null;
    return { query: match[1], start: input.selectionStart - match[1].length - 1 };
  }

  function refreshPalette() {
    const slash = slashQuery();
    if (slash !== null) {
      const q = slash.toLowerCase();
      palMode = "slash";
      const all = [...commands.filter((cmd) => !LOCAL.some((own) => own.name === cmd.name)), ...LOCAL];
      palItems = all.filter((cmd) =>
        cmd.name.toLowerCase().includes(q) || (cmd.description || "").toLowerCase().includes(q)).slice(0, 12);
      hi = 0;
      renderPalette(palItems);
      return;
    }
    const found = mentionQuery();
    if (found && found.query) {
      palMode = "files";
      if (mention !== found.query) {
        mention = found.query;
        files = [];
        clearTimeout(timer);
        timer = setTimeout(() => vscode.postMessage({ type: "searchFiles", query: found.query }), 120);
      }
      const items = files.length
        ? files.map((file) => ({ name: file, description: "" }))
        : [{ name: "Recherche…", description: "", placeholder: true }];
      renderPalette(items);
      return;
    }
    closePalette();
  }

  function renderPalette(items) {
    const palette = $("palette");
    palette.innerHTML = "";
    palItems = items;
    if (!items.length) {
      palette.hidden = true;
      return;
    }
    palette.hidden = false;
    if (hi >= items.length) hi = 0;
    items.forEach((item, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = index === hi ? "pal on" : "pal";
      const hint = item.argumentHint ? ` ${item.argumentHint}` : "";
      btn.innerHTML = `<span class="pal-name">${ui.escapeHtml(palMode === "files" ? item.name : `/${item.name}`)}</span>` +
        `<span class="pal-desc">${ui.escapeHtml((item.description || "") + hint)}</span>`;
      btn.addEventListener("click", () => choose(index));
      palette.appendChild(btn);
    });
    palette.querySelector(".pal.on")?.scrollIntoView({ block: "nearest" });
  }

  function choose(index) {
    const item = palItems[index];
    if (!item || item.placeholder) return;
    const input = $("input");
    if (palMode === "slash") {
      if (item.local) {
        input.value = "";
        closePalette();
        paintSend();
        vscode.postMessage({ type: item.local });
        return;
      }
      input.value = `/${item.name} `;
      closePalette();
      input.focus();
      paintSend();
      return;
    }
    const found = mentionQuery();
    const start = found ? found.start : input.value.lastIndexOf("@");
    const pos = input.selectionStart;
    const file = item.name.includes(" ") ? `\`${item.name}\`` : `@${item.name}`;
    input.value = `${input.value.slice(0, start)}${file} ${input.value.slice(pos)}`;
    const caret = start + file.length + 1;
    input.setSelectionRange(caret, caret);
    closePalette();
    input.focus();
    paintSend();
  }

  function closePalette() {
    palMode = null;
    palItems = [];
    mention = null;
    $("palette").hidden = true;
    $("palette").innerHTML = "";
  }

  function onKey(event) {
    const input = $("input");
    if (event.key === "Escape" && !event.ctrlKey && !$("palette").hidden) {
      event.preventDefault();
      closePalette();
      return;
    }
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      cycleMode();
      return;
    }
    if (!$("palette").hidden && palItems.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      hi = (hi + (event.key === "ArrowDown" ? 1 : palItems.length - 1)) % palItems.length;
      renderPalette(palItems);
      return;
    }
    if (event.key === "ArrowUp" && !input.value && lastSent) {
      event.preventDefault();
      input.value = lastSent;
      autosize();
      paintSend();
      return;
    }
    if (event.key === "Tab" && !$("palette").hidden && palItems.length) {
      event.preventDefault();
      choose(hi);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      if (ui.sheetOpen()) {
        event.preventDefault();
        return;
      }
      if (!$("palette").hidden && palItems.length) {
        const exact = palMode === "slash" && palItems.some((cmd) => cmd.name === slashQuery() && !cmd.local);
        if (!exact) {
          event.preventDefault();
          choose(hi);
          return;
        }
      }
      event.preventDefault();
      send();
    }
  }

  // ---------- images et fichiers ----------

  const SUPPORTED = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const MAX_BYTES = 3.75 * 1024 * 1024;

  function readImage(file) {
    if (!file || !SUPPORTED.includes(file.type)) return false;
    if (file.size > MAX_BYTES) {
      ui.notice(`${file.name || "image"} dépasse 3,75 Mo, réduis-la avant de la joindre.`);
      return true;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      pending.push({
        name: file.name || "capture.png",
        mediaType: file.type,
        data: result.slice(result.indexOf(",") + 1),
      });
      renderPending();
    };
    reader.readAsDataURL(file);
    return true;
  }

  function renderPending() {
    const host = $("attachments");
    host.innerHTML = pending.map((img, index) =>
      `<div class="chip attach" data-preview="${index}" title="Aperçu de ${ui.escapeHtml(img.name)}">` +
      `<img src="data:${img.mediaType};base64,${img.data}" alt="">` +
      `<span>${ui.escapeHtml(img.name)}</span>` +
      `<button type="button" data-remove="${index}" title="Retirer">×</button></div>`).join("");
    paintSend();
  }

  function onPaste(event) {
    const items = event.clipboardData ? Array.from(event.clipboardData.items) : [];
    const images = items.filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
    if (!images.length) return;
    event.preventDefault();
    images.forEach(readImage);
  }

  /**
   * URIs déposées. L'explorateur de Cursor/VS Code les fournit sous plusieurs formats selon
   * la version ; un fichier venu du système arrive en général en text/uri-list.
   */
  function droppedUris(data) {
    const out = [];
    const json = (raw) => {
      try {
        const value = JSON.parse(raw);
        return Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : item && (item.uri || item.resource || ""))) : [];
      } catch {
        return raw.split(/\r?\n/);
      }
    };
    const vsList = data.getData("application/vnd.code.uri-list");
    if (vsList) out.push(...json(vsList));
    const resources = data.getData("resourceurls");
    if (resources) out.push(...json(resources));
    const uriList = data.getData("text/uri-list");
    if (uriList) out.push(...uriList.split(/\r?\n/).filter((line) => line && !line.startsWith("#")));
    if (!out.length) {
      const text = data.getData("text/plain").trim();
      if (/^(file:\/\/|[a-zA-Z]:[\\/]|\/)/.test(text) && !text.includes("\n")) out.push(text);
    }
    return [...new Set(out.map((item) => String(item || "").trim()).filter(Boolean))];
  }

  function initDrop() {
    const hint = $("drophint");
    const composer = $("composer");
    const show = (value) => {
      composer.classList.toggle("drop", value);
      hint.hidden = !value;
    };
    document.addEventListener("dragenter", (event) => {
      event.preventDefault();
      dragDepth += 1;
      show(true);
    });
    document.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    document.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) show(false);
    });
    document.addEventListener("drop", (event) => {
      event.preventDefault();
      dragDepth = 0;
      show(false);
      const data = event.dataTransfer;
      if (!data) return;
      const uris = droppedUris(data);
      if (uris.length) {
        vscode.postMessage({ type: "dropUris", uris });
        return;
      }
      const list = data.files ? Array.from(data.files) : [];
      const skipped = list.filter((file) => !readImage(file));
      if (skipped.length) {
        ui.notice(`${skipped.map((file) => file.name).join(", ")} : glisse ce fichier depuis l'explorateur de Cursor en maintenant Maj pour l'ajouter.`);
      }
    });
  }

  function addImages(images) {
    pending.push(...images);
    renderPending();
  }

  ui.initComposer = initComposer;
  ui.focusInput = focusInput;
  ui.setState = setState;
  ui.setContext = setContext;
  ui.resetContext = resetContext;
  ui.setBusy = setBusy;
  ui.setCommands = setCommands;
  ui.setMode = setMode;
  ui.setModels = setModels;
  ui.setAgents = setAgents;
  ui.setSessions = setSessions;
  ui.setFiles = setFiles;
  ui.insert = insert;
  ui.addImages = addImages;
  ui.formatUsd = formatUsd;
})(window);
