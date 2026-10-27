(function () {
  const vscode = acquireVsCodeApi();
  const list = document.getElementById("list");
  const accountEl = document.getElementById("account");
  const query = document.getElementById("q");
  let armed = null;
  let rows = [];
  let hint = "";
  let error = "";
  let account = null;
  let showArchived = false;
  const saved = vscode.getState() || {};
  const closed = new Set(saved.closed || []);

  document.getElementById("new").addEventListener("click", () => vscode.postMessage({ type: "new" }));
  document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  document.getElementById("console").addEventListener("click", () => {
    if (account && account.consoleUrl) vscode.postMessage({ type: "openUrl", url: account.consoleUrl });
  });
  query.addEventListener("input", render);

  document.querySelectorAll("[data-sec]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.sec;
      if (closed.has(name)) closed.delete(name);
      else closed.add(name);
      vscode.setState({ closed: [...closed] });
      paintSections();
    });
  });

  function paintSections() {
    document.getElementById("sec-account").classList.toggle("open", !closed.has("account"));
    document.getElementById("sec-sessions").classList.toggle("open", !closed.has("sessions"));
  }

  accountEl.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (action) vscode.postMessage({ type: action.dataset.action });
  });

  list.addEventListener("click", (event) => {
    const del = event.target.closest("[data-delete]");
    if (del) {
      const id = del.dataset.delete;
      if (armed === id) {
        armed = null;
        vscode.postMessage({ type: "delete", id });
      } else {
        armed = id;
        render();
      }
      return;
    }
    const archive = event.target.closest("[data-archive]");
    if (archive) {
      vscode.postMessage({ type: archive.dataset.value === "1" ? "archive" : "unarchive", id: archive.dataset.archive });
      return;
    }
    if (event.target.closest("[data-toggle-archived]")) {
      showArchived = !showArchived;
      render();
      return;
    }
    const open = event.target.closest("[data-open]");
    if (!open) return;
    armed = null;
    vscode.postMessage({ type: "open", id: open.dataset.open });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "account") {
      account = msg;
      renderAccount();
      return;
    }
    if (msg.type !== "sessions") return;
    rows = msg.rows || [];
    hint = msg.hint || "";
    error = msg.error || "";
    if (armed && !rows.some((row) => row.id === armed)) armed = null;
    render();
  });

  function usd(value) {
    const n = Number(value) || 0;
    return `${n < 1 ? n.toFixed(3) : n.toFixed(2)} $`.replace(".", ",");
  }

  function renderAccount() {
    if (!account) return;
    const pct = account.maxUsd ? Math.min(100, (account.spent / account.maxUsd) * 100) : 0;
    accountEl.replaceChildren();
    const keyRow = document.createElement("div");
    keyRow.className = "kv";
    keyRow.innerHTML = `<span class="k">Clé API</span><span class="v ${account.hasKey ? "ok" : "warn"}">${account.hasKey ? "Enregistrée" : "Aucune"}</span>`;
    const spend = document.createElement("div");
    spend.className = "kv";
    spend.innerHTML = `<span class="k">Dépensé</span><span class="v num">${usd(account.spent)} / ${account.maxUsd} $</span>`;
    const bar = document.createElement("div");
    bar.className = `bar${pct >= 90 ? " hot" : ""}`;
    const fill = document.createElement("span");
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.innerHTML =
      `<button type="button" class="link" data-action="setKey">${account.hasKey ? "Changer la clé" : "Ajouter la clé"}</button>` +
      (account.hasKey ? `<button type="button" class="link danger" data-action="clearKey">Supprimer</button>` : "") +
      `<button type="button" class="link" data-action="resetSpent">Remettre à zéro</button>`;
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "Estimation locale. La Console fait foi.";
    accountEl.append(keyRow, spend, bar, actions, note);
  }

  function render() {
    list.replaceChildren();
    if (error) list.appendChild(note(error, "hint err"));
    const q = query.value.trim().toLowerCase();
    const match = (row) => !q || String(row.title || "").toLowerCase().includes(q);
    const active = rows.filter((row) => !row.archived && match(row));
    const archived = rows.filter((row) => row.archived && match(row));
    if (!active.length && !archived.length) {
      list.appendChild(note(q ? "Aucune session ne correspond." : hint || "Aucune session pour l'instant.", "hint"));
      return;
    }
    active.forEach((row) => list.appendChild(item(row)));
    if (!archived.length) return;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `archived-toggle${showArchived ? " open" : ""}`;
    toggle.dataset.toggleArchived = "1";
    toggle.innerHTML = `<span class="chev">›</span><span>Sessions archivées</span><span class="count">${archived.length}</span>`;
    list.appendChild(toggle);
    if (showArchived) archived.forEach((row) => list.appendChild(item(row)));
  }

  function item(row) {
    const el = document.createElement("div");
    el.className = `session${row.open ? " open" : ""}${row.archived ? " archived" : ""}`;
    const main = document.createElement("button");
    main.className = "open";
    main.type = "button";
    main.dataset.open = row.id;
    const title = document.createElement("span");
    title.className = "stitle";
    title.textContent = row.title || "Session";
    const meta = document.createElement("span");
    meta.className = "smeta";
    meta.textContent = ago(row.when);
    main.append(title, meta);
    const tools = document.createElement("span");
    tools.className = "stools";
    if (!row.open) {
      const arch = document.createElement("button");
      arch.type = "button";
      arch.className = "tool";
      arch.dataset.archive = row.id;
      arch.dataset.value = row.archived ? "0" : "1";
      arch.title = row.archived ? "Désarchiver" : "Archiver";
      arch.textContent = row.archived ? "↺" : "⊟";
      tools.appendChild(arch);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.dataset.delete = row.id;
    del.className = armed === row.id ? "tool del armed" : "tool del";
    del.textContent = armed === row.id ? "Supprimer" : "×";
    del.title = armed === row.id ? "Confirmer la suppression" : "Supprimer la session";
    tools.appendChild(del);
    el.append(main, tools);
    return el;
  }

  function note(text, className) {
    const p = document.createElement("p");
    p.className = className;
    p.textContent = text;
    return p;
  }

  function ago(ms) {
    if (!ms) return "";
    const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (min < 1) return "maint.";
    if (min < 60) return `${min}m`;
    const hours = Math.round(min / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}j`;
  }

  paintSections();
  vscode.postMessage({ type: "ready" });
})();
