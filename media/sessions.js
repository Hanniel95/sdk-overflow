(function () {
  const vscode = acquireVsCodeApi();
  const list = document.getElementById("list");
  let armed = null;
  let rows = [];
  let hint = "";
  let error = "";

  document.getElementById("new").addEventListener("click", () => {
    vscode.postMessage({ type: "new" });
  });
  document.getElementById("refresh").addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
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
    const open = event.target.closest("[data-open]");
    if (!open) return;
    armed = null;
    vscode.postMessage({ type: "open", id: open.dataset.open });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type !== "sessions") return;
    rows = msg.rows || [];
    hint = msg.hint || "";
    error = msg.error || "";
    if (armed && !rows.some((row) => row.id === armed)) armed = null;
    render();
  });

  function render() {
    list.replaceChildren();
    if (error) list.appendChild(note(error, "hint err"));
    if (!rows.length) {
      list.appendChild(note(hint || "Aucune session pour ce dossier.", "hint"));
      return;
    }
    for (const row of rows) {
      const item = document.createElement("div");
      item.className = row.open ? "session open" : "session";
      const main = document.createElement("button");
      main.className = "open";
      main.type = "button";
      main.dataset.open = row.id;
      const title = document.createElement("span");
      title.className = "stitle";
      title.textContent = row.title || "Session";
      const meta = document.createElement("span");
      meta.className = "smeta";
      meta.textContent = `${row.open ? "Ouverte · " : ""}${ago(row.when)}`;
      main.append(title, meta);
      const del = document.createElement("button");
      del.type = "button";
      del.dataset.delete = row.id;
      del.className = armed === row.id ? "del armed" : "del";
      del.textContent = armed === row.id ? "Supprimer" : "×";
      del.title = armed === row.id ? "Confirmer la suppression" : "Supprimer la session";
      item.append(main, del);
      list.appendChild(item);
    }
  }

  function note(text, className) {
    const p = document.createElement("p");
    p.className = className;
    p.textContent = text;
    return p;
  }

  function ago(ms) {
    if (!ms) return "";
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return "à l'instant";
    if (min < 60) return `il y a ${min} min`;
    const hours = Math.round(min / 60);
    if (hours < 24) return `il y a ${hours} h`;
    const days = Math.round(hours / 24);
    return `il y a ${days} j`;
  }

  vscode.postMessage({ type: "ready" });
})();
