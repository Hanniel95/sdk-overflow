(function (root) {
  const ui = root.AgentUI;
  let el;
  let vscode;
  let current = null;
  /** Choix numérotés de la feuille ouverte, déclenchables au clavier (1, 2, 3…). */
  let shortcuts = [];

  function initSheet(sheetEl, api) {
    el = sheetEl;
    vscode = api;
    window.addEventListener("keydown", (event) => {
      if (el.hidden || !current) return;
      const typing = event.target.closest && event.target.closest("input, textarea");
      if (event.key === "Escape" && !event.ctrlKey) {
        const palette = document.getElementById("palette");
        if (palette && !palette.hidden) return;
        event.preventDefault();
        reply({ decision: "deny" });
        return;
      }
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && shortcuts[index]) {
        event.preventDefault();
        shortcuts[index]();
      }
    });
  }

  function reply(answer) {
    if (!current) return;
    const id = current;
    current = null;
    shortcuts = [];
    el.hidden = true;
    el.innerHTML = "";
    vscode.postMessage({ type: "sheetAnswer", id, answer });
  }

  function add(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    el.appendChild(node);
    return node;
  }

  /** Liste d'options numérotées, comme l'invite d'autorisation de Claude Code. */
  function choices(items) {
    const list = add("div", "choices");
    shortcuts = [];
    items.forEach((item, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `choice${item.kind ? ` ${item.kind}` : ""}`;
      btn.innerHTML = `<span class="num">${index + 1}</span><span class="choice-label">${ui.escapeHtml(item.label)}</span>` +
        (item.hint ? `<span class="choice-hint">${ui.escapeHtml(item.hint)}</span>` : "");
      btn.addEventListener("click", item.run);
      list.appendChild(btn);
      shortcuts.push(item.run);
    });
    list.querySelector(".choice")?.focus();
    return list;
  }

  function show(sheet) {
    current = sheet.id;
    el.hidden = false;
    el.innerHTML = "";
    el.className = `sheet sheet-${sheet.kind}`;
    if (sheet.kind === "question") renderQuestion(sheet);
    else if (sheet.kind === "plan") renderPlan(sheet);
    else if (sheet.kind === "refusal") renderRefusal(sheet);
    else renderPermission(sheet);
    ui.stick(true);
  }

  function close(id) {
    if (id && id !== current) return;
    current = null;
    shortcuts = [];
    el.hidden = true;
    el.innerHTML = "";
  }

  function toolTitle(sheet) {
    const tool = sheet.tool || "";
    if (tool === "Bash" || tool === "PowerShell") return `Exécuter cette commande ${tool} ?`;
    if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") return "Appliquer cette modification ?";
    if (tool === "Write") return "Écrire ce fichier ?";
    if (tool === "WebFetch") return "Ouvrir cette page web ?";
    return sheet.title || `Autoriser ${tool} ?`;
  }

  function renderPermission(sheet) {
    const head = add("div", "sheet-head");
    head.innerHTML = `<span class="sheet-tool">${ui.escapeHtml(sheet.tool || "Outil")}</span><span class="sheet-title">${ui.escapeHtml(toolTitle(sheet))}</span>`;
    if (sheet.description) add("p", "sheet-desc", sheet.description);
    const preview = add("div", "sheet-preview");
    if (sheet.file) {
      const row = document.createElement("div");
      row.className = "file-row";
      row.innerHTML = ui.pathButton(String(sheet.file), ui.relPath ? ui.relPath(String(sheet.file)) : undefined);
      preview.appendChild(row);
    }
    if (sheet.mono) {
      const pre = document.createElement("pre");
      pre.className = "cmd";
      pre.textContent = sheet.mono;
      preview.appendChild(pre);
    }
    if (sheet.diff) {
      const wrap = document.createElement("div");
      wrap.innerHTML = ui.diffHtml(sheet.diff.old || "", sheet.diff.new || "");
      preview.appendChild(wrap.firstElementChild);
    }
    if (sheet.write) {
      const wrap = document.createElement("div");
      wrap.innerHTML = ui.diffHtml("", sheet.write);
      preview.appendChild(wrap.firstElementChild);
    }
    if (sheet.detail) {
      const pre = document.createElement("pre");
      pre.className = "cmd";
      pre.textContent = sheet.detail;
      preview.appendChild(pre);
    }
    if (!preview.childElementCount) preview.remove();
    const items = [{ label: "Oui", run: () => reply({ decision: "allow" }) }];
    if (sheet.canAlways) {
      const what = sheet.tool === "Bash" || sheet.tool === "PowerShell" ? "cette commande" : sheet.file ? "ce fichier" : sheet.tool;
      items.push({ label: `Oui, et ne plus demander pour ${what} dans cette session`, run: () => reply({ decision: "always" }) });
    }
    items.push({ label: "Non, et dire à l'agent quoi faire autrement", hint: "Échap", kind: "no", run: () => reply({ decision: "deny" }) });
    choices(items);
  }

  function renderPlan(sheet) {
    const head = add("div", "sheet-head");
    head.innerHTML = `<span class="sheet-tool">Plan</span><span class="sheet-title">${ui.escapeHtml(sheet.title || "Voici le plan proposé. On y va ?")}</span>`;
    const body = add("div", "sheet-body md");
    body.innerHTML = ui.renderMarkdown(sheet.body || "");
    choices([
      { label: "Oui, approuver le plan et commencer", run: () => reply({ decision: "allow" }) },
      { label: "Non, rester en mode plan", hint: "Échap", kind: "no", run: () => reply({ decision: "deny" }) },
    ]);
  }

  function renderRefusal(sheet) {
    const head = add("div", "sheet-head");
    head.innerHTML = `<span class="sheet-tool">Modèle</span><span class="sheet-title">${ui.escapeHtml(sheet.title || "Réessayer ?")}</span>`;
    if (sheet.body) add("p", "sheet-desc", sheet.body);
    choices([
      { label: "Réessayer", run: () => reply({ decision: "allow" }) },
      { label: "Non", hint: "Échap", kind: "no", run: () => reply({ decision: "deny" }) },
    ]);
  }

  function renderQuestion(sheet) {
    const head = add("div", "sheet-head");
    const count = (sheet.questions || []).length;
    head.innerHTML = `<span class="sheet-tool">Question</span><span class="sheet-title">L'agent a besoin de ta réponse${count > 1 ? ` (${count} questions)` : ""}</span>`;
    const form = add("div", "qform");
    const single = count === 1 && !sheet.questions[0].multiSelect;
    shortcuts = [];
    (sheet.questions || []).forEach((question) => {
      const block = document.createElement("section");
      block.className = "q";
      const top = document.createElement("div");
      top.className = "q-head";
      if (question.header) {
        const chip = document.createElement("span");
        chip.className = "q-chip";
        chip.textContent = question.header;
        top.appendChild(chip);
      }
      const text = document.createElement("p");
      text.className = "q-text";
      text.textContent = question.question;
      top.appendChild(text);
      block.appendChild(top);
      const preview = document.createElement("pre");
      preview.className = "preview";
      preview.hidden = true;
      (question.options || []).forEach((opt, index) => {
        const choice = document.createElement("button");
        choice.type = "button";
        choice.className = "opt";
        choice.innerHTML = `<span class="num">${question.multiSelect ? "☐" : index + 1}</span><span class="opt-main"><span class="opt-label">${ui.escapeHtml(opt.label)}</span>` +
          (opt.description ? `<span class="opt-desc">${ui.escapeHtml(opt.description)}</span>` : "") + `</span>`;
        const pick = () => {
          if (question.multiSelect) {
            choice.classList.toggle("on");
            choice.querySelector(".num").textContent = choice.classList.contains("on") ? "☑" : "☐";
          } else {
            block.querySelectorAll(".opt").forEach((item) => item.classList.remove("on"));
            choice.classList.add("on");
            const field = block.querySelector(".other-input");
            if (field) field.value = "";
          }
          if (opt.preview) {
            preview.hidden = false;
            preview.textContent = opt.preview;
          }
        };
        choice.addEventListener("click", () => {
          pick();
          if (single) submit();
        });
        if (single) shortcuts.push(() => { pick(); submit(); });
        block.appendChild(choice);
      });
      const other = document.createElement("label");
      other.className = "other";
      const caption = document.createElement("span");
      caption.textContent = "Autre";
      const field = document.createElement("input");
      field.className = "other-input";
      field.type = "text";
      field.placeholder = "Précise ta réponse…";
      field.addEventListener("input", () => {
        if (!question.multiSelect && field.value.trim()) {
          block.querySelectorAll(".opt").forEach((item) => item.classList.remove("on"));
        }
      });
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      });
      other.append(caption, field);
      block.append(preview, other);
      form.appendChild(block);
    });

    function submit() {
      const answers = {};
      let valid = true;
      form.querySelectorAll(".q").forEach((block, index) => {
        const question = sheet.questions[index];
        const labels = [...block.querySelectorAll(".opt.on .opt-label")].map((node) => node.textContent || "");
        const otherText = block.querySelector(".other-input").value.trim();
        const parts = labels.filter(Boolean);
        if (otherText) parts.push(otherText);
        if (parts.length === 0) valid = false;
        answers[question.question] = question.multiSelect ? parts.join(", ") : (parts[0] || "");
      });
      if (!valid) {
        let hint = form.querySelector(".q-hint");
        if (!hint) {
          hint = document.createElement("p");
          hint.className = "q-hint";
          hint.textContent = "Choisis une réponse pour chaque question.";
          form.appendChild(hint);
        }
        return;
      }
      reply({ decision: "submit", answers });
    }

    const bar = add("div", "sheet-actions");
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "ghost";
    skip.textContent = "Ignorer (Échap)";
    skip.addEventListener("click", () => reply({ decision: "deny" }));
    const send = document.createElement("button");
    send.type = "button";
    send.className = "primary";
    send.textContent = "Envoyer";
    send.addEventListener("click", submit);
    bar.append(skip, send);
    form.querySelector(".opt")?.focus();
  }

  ui.initSheet = initSheet;
  ui.showSheet = show;
  ui.closeSheet = close;
  ui.sheetOpen = () => Boolean(current);
})(window);
