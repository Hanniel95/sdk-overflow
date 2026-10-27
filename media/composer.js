(function (root) {
  const ui = root.AgentUI;
  const FALLBACK = [
    { name: "compact", description: "Résume le contexte pour réduire la consommation", argumentHint: "" },
    { name: "clear", description: "Vide la conversation", argumentHint: "" },
    { name: "cost", description: "Affiche le coût de la session", argumentHint: "" },
    { name: "usage", description: "Affiche l'usage", argumentHint: "" },
    { name: "help", description: "Liste les commandes", argumentHint: "" },
    { name: "review", description: "Relit les changements", argumentHint: "" },
    { name: "diff", description: "Montre le diff git", argumentHint: "" },
  ];

  const MODES = [
    { value: "default", name: "Manuel", pill: "Demander avant", description: "Demande avant chaque modification et chaque commande" },
    { value: "acceptEdits", name: "Éditer automatiquement", pill: "⏵⏵ Éditer auto", description: "Modifie les fichiers sans demander. Les commandes demandent encore." },
    { value: "plan", name: "Plan", pill: "⏸ Plan", description: "Explore le code et propose un plan avant de modifier" },
    { value: "auto", name: "Auto", pill: "⏵⏵ Auto", description: "Autorise ce qui passe un contrôle, et s'arrête si c'est risqué" },
  ];
  const EFFORTS = [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
    { value: "xhigh", name: "Extra" },
  ];
  const FALLBACK_MODELS = [
    { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "Pour le travail difficile" },
    { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Pour le travail courant" },
    { value: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "Le plus rapide" },
  ];
  const HEAD_MENUS = new Set(["more", "sessions"]);
  const RING = 2 * Math.PI * 7;

  let vscode;
  let commands = FALLBACK.slice();
  let modelChoices = FALLBACK_MODELS.slice();
  let agents = [];
  let sessions = [];
  let model = "sonnet";
  let mode = "default";
  let effort = "high";
  let account = { spent: 0, maxUsd: 0, hasKey: true };
  let context = null;
  let openMenu = null;
  let files = [];
  let pending = [];
  let busy = false;
  let palMode = null;
  let palItems = [];
  let hi = 0;
  let mention = null;
  let timer = 0;
  let lastSent = "";

  function $(id) {
    return document.getElementById(id);
  }

  function initComposer(api) {
    vscode = api;
    const input = $("input");
    const composer = $("composer");
    $("send").addEventListener("click", send);
    $("stop").addEventListener("click", stop);
    $("newbtn").addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
    $("more").addEventListener("click", () => toggleMenu("more"));
    $("plus").addEventListener("click", () => toggleMenu("plus"));
    $("modelbtn").addEventListener("click", () => toggleMenu("model"));
    $("modebtn").addEventListener("click", () => toggleMenu("mode"));
    $("slash").addEventListener("click", () => {
      closeMenu();
      if (!input.value.startsWith("/")) input.value = `/${input.value}`;
      input.focus();
      input.setSelectionRange(1, 1);
      refreshPalette();
    });
    $("history").addEventListener("click", () => {
      vscode.postMessage({ type: "listSessions" });
      toggleMenu("sessions");
    });
    document.addEventListener("mousedown", (event) => {
      if (!event.target.closest(".composer, .top")) closeMenu();
    });
    document.addEventListener("keydown", (event) => {
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
    ["dragenter", "dragover"].forEach((name) => composer.addEventListener(name, (event) => {
      event.preventDefault();
      composer.classList.add("drop");
    }));
    ["dragleave", "drop"].forEach((name) => composer.addEventListener(name, () => composer.classList.remove("drop")));
    composer.addEventListener("drop", onDrop);
    $("palette").addEventListener("mousedown", (event) => event.preventDefault());
    paintSend();
  }

  function autosize() {
    const input = $("input");
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
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
    const cost = $("cost");
    cost.textContent = account.hasKey ? formatUsd(account.spent) : "aucune clé API";
    cost.title = account.hasKey
      ? `Dépense cumulée suivie par l'extension : ${formatUsd(account.spent)} sur ${account.maxUsd} $. Remise à zéro dans le menu ⋯.`
      : "Ajoute une clé API depuis le menu ⋯";
    cost.classList.toggle("warn", !account.hasKey || account.spent >= account.maxUsd * 0.9);
    paintRing();
    if (openMenu === "more") renderMenu();
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
    $("ring-text").textContent = context.pct >= 50 ? `${Math.round(context.pct)} %` : "";
    ring.title = `Contexte : ${Math.round(context.pct)} % (${context.used.toLocaleString("fr-FR")} / ${context.max.toLocaleString("fr-FR")} tokens). /compact pour le réduire.`;
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
    if (openMenu === "plus") renderMenu();
  }

  function setSessions(rows) {
    sessions = Array.isArray(rows) ? rows : [];
    if (openMenu === "sessions") renderMenu();
  }

  function paintPills() {
    $("modelbtn").textContent = `${modelLabel()} · ${effortName()}`;
    const current = MODES.find((item) => item.value === mode) || MODES[0];
    const btn = $("modebtn");
    btn.textContent = current.pill;
    btn.className = `pill mode mode-${current.value}`;
    btn.title = `${current.name} : ${current.description} (Maj+Tab pour changer)`;
  }

  function modelLabel() {
    const found = modelChoices.find((item) => item.value === model || item.value === alias(model));
    if (found) return found.displayName;
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

  function applyMode(value) {
    mode = value;
    paintPills();
    vscode.postMessage({ type: "mode", value });
  }

  function cycleMode() {
    const index = MODES.findIndex((item) => item.value === mode);
    applyMode(MODES[(index + 1) % MODES.length].value);
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
    if (!openMenu) return;
    const target = HEAD_MENUS.has(openMenu) ? head : pop;
    target.className = `pop ${HEAD_MENUS.has(openMenu) ? "head" : ""} ${openMenu}`;
    target.hidden = false;
    if (openMenu === "plus") renderPlus(target);
    else if (openMenu === "model") renderModels(target);
    else if (openMenu === "mode") renderModes(target);
    else if (openMenu === "more") renderMore(target);
    else renderSessions(target);
  }

  function row(parent, title, description, onClick, selected, extraClass) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `row${selected ? " on" : ""}${extraClass ? ` ${extraClass}` : ""}`;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = title;
    btn.appendChild(name);
    if (description) {
      const desc = document.createElement("span");
      desc.className = "desc";
      desc.textContent = description;
      btn.appendChild(desc);
    }
    btn.addEventListener("click", onClick);
    parent.appendChild(btn);
    return btn;
  }

  function separator(parent, label) {
    const el = document.createElement("div");
    el.className = "sep";
    if (label) el.textContent = label;
    parent.appendChild(el);
  }

  function renderPlus(pop) {
    row(pop, "Importer une image", "Depuis l'ordinateur (ou colle une capture avec Ctrl+V)", () => {
      closeMenu();
      vscode.postMessage({ type: "pickImages" });
    });
    row(pop, "Mentionner un fichier", "Ajoute un fichier au contexte avec @", () => {
      closeMenu();
      const input = $("input");
      input.value = `${input.value}${input.value && !input.value.endsWith(" ") ? " " : ""}@`;
      input.focus();
      refreshPalette();
    });
    if (agents.length) {
      separator(pop, "Sous-agents disponibles");
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = agents.map((agent) => agent.name).join(", ");
      pop.appendChild(note);
    }
  }

  function renderModels(pop) {
    separator(pop, "Modèle");
    for (const item of modelChoices) {
      row(pop, item.displayName, item.description, () => {
        model = item.value;
        paintPills();
        closeMenu();
        vscode.postMessage({ type: "model", value: item.value });
      }, item.value === model || item.value === alias(model));
    }
    separator(pop, "Effort");
    const bar = document.createElement("div");
    bar.className = "effort";
    for (const item of EFFORTS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = item.value === effort ? "on" : "";
      btn.textContent = item.name;
      btn.addEventListener("click", () => {
        effort = item.value;
        paintPills();
        vscode.postMessage({ type: "effort", value: item.value });
        renderMenu();
      });
      bar.appendChild(btn);
    }
    pop.appendChild(bar);
  }

  function renderModes(pop) {
    separator(pop, "Mode · Maj+Tab pour passer au suivant");
    for (const item of MODES) {
      row(pop, item.name, item.description, () => {
        closeMenu();
        applyMode(item.value);
      }, item.value === mode, `mode-${item.value}`);
    }
  }

  function renderMore(pop) {
    separator(pop, "Compte");
    row(pop, account.hasKey ? "Changer la clé API…" : "Ajouter la clé API…", "Clé Claude Console, stockée dans le coffre de l'éditeur", () => {
      closeMenu();
      vscode.postMessage({ type: "setKey" });
    });
    if (account.hasKey) {
      row(pop, "Supprimer la clé API", "", () => {
        closeMenu();
        vscode.postMessage({ type: "clearKey" });
      }, false, "danger");
    }
    separator(pop, `Dépensé : ${formatUsd(account.spent)} / ${account.maxUsd} $`);
    row(pop, "Remettre le compteur à zéro", "Estimation locale : la Console fait foi", () => {
      closeMenu();
      vscode.postMessage({ type: "resetSpent" });
    });
    separator(pop, "Conversation");
    row(pop, "Vider le contexte", "Commande /clear, sans relancer l'agent", () => {
      closeMenu();
      vscode.postMessage({ type: "clear" });
    });
    row(pop, "Compacter le contexte", "Commande /compact : résume l'historique", () => {
      closeMenu();
      sendText("/compact");
    });
  }

  function renderSessions(pop) {
    separator(pop, "Sessions du dossier");
    if (!sessions.length) {
      row(pop, "Aucune session", "Le bouton + ouvre une nouvelle session", () => closeMenu());
      return;
    }
    for (const item of sessions) {
      const btn = row(pop, item.title || "Session", item.open ? "Ouverte" : "", () => {
        closeMenu();
        vscode.postMessage({ type: "openSession", id: item.id });
      }, item.open);
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = ago(item.when);
      btn.querySelector(".name").appendChild(when);
    }
  }

  function ago(ms) {
    if (!ms) return "";
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return "à l'instant";
    if (min < 60) return `${min} min`;
    const hours = Math.round(min / 60);
    if (hours < 24) return `${hours} h`;
    return `${Math.round(hours / 24)} j`;
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

  function insert(text) {
    const input = $("input");
    input.value = (input.value ? `${input.value}\n` : "") + text;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    autosize();
    refreshPalette();
    paintSend();
  }

  function sendText(text) {
    ui.stick(true);
    ui.userMessage(text, []);
    vscode.postMessage({ type: "send", text, images: [] });
    if (!busy) setBusy(true);
  }

  function send() {
    if (ui.sheetOpen()) return;
    const input = $("input");
    const text = input.value.trim();
    if (!text && pending.length === 0) return;
    closePalette();
    ui.stick(true);
    ui.userMessage(text, pending);
    vscode.postMessage({ type: "send", text, images: pending });
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
      palItems = commands.filter((cmd) =>
        cmd.name.toLowerCase().includes(q) || (cmd.description || "").toLowerCase().includes(q)).slice(0, 10);
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
    if (event.key === "Escape" && !$("palette").hidden) {
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
        const exact = palMode === "slash" && palItems.some((cmd) => cmd.name === slashQuery());
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

  // ---------- images ----------

  const SUPPORTED = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const MAX_BYTES = 3.75 * 1024 * 1024;

  function readImage(file) {
    if (!file || !SUPPORTED.includes(file.type)) return;
    if (file.size > MAX_BYTES) {
      ui.notice(`${file.name || "image"} dépasse 3,75 Mo, réduis-la avant de la joindre.`);
      return;
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
  }

  function renderPending() {
    const host = $("attachments");
    host.innerHTML = "";
    pending.forEach((img, index) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.innerHTML = `<img src="data:${img.mediaType};base64,${img.data}" alt=""><span>${ui.escapeHtml(img.name)}</span><button type="button" title="Retirer">×</button>`;
      chip.querySelector("button").addEventListener("click", () => {
        pending.splice(index, 1);
        renderPending();
      });
      host.appendChild(chip);
    });
    paintSend();
  }

  function onPaste(event) {
    const items = event.clipboardData ? Array.from(event.clipboardData.items) : [];
    const images = items.filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
    if (!images.length) return;
    event.preventDefault();
    images.forEach(readImage);
  }

  function onDrop(event) {
    event.preventDefault();
    const data = event.dataTransfer;
    if (!data) return;
    if (data.files && data.files.length) {
      Array.from(data.files).forEach(readImage);
      return;
    }
    const uris = (data.getData("text/uri-list") || data.getData("text/plain") || "")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"));
    if (uris.length) vscode.postMessage({ type: "dropUris", uris });
  }

  function addImages(images) {
    pending.push(...images);
    renderPending();
  }

  ui.initComposer = initComposer;
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
