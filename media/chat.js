(function () {
  const vscode = acquireVsCodeApi();
  const ui = window.AgentUI;
  let turnDelta = 0;

  ui.copy = (text, button) => {
    vscode.postMessage({ type: "copy", text });
    if (!button) return;
    const label = button.textContent;
    button.textContent = "Copié";
    button.classList.add("done");
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove("done");
    }, 1200);
  };

  ui.initTranscript(document.getElementById("log"));
  ui.initActivity();
  ui.initSheet(document.getElementById("sheet"), vscode);
  ui.initComposer(vscode);

  const known = document.getElementById("session")?.dataset.id;
  if (known) vscode.setState({ sessionId: known });

  document.addEventListener("click", (event) => {
    const target = event.target;
    const copyCode = target.closest(".copy-code");
    if (copyCode) {
      const code = copyCode.closest(".code")?.querySelector("pre");
      if (code) ui.copy(code.textContent || "", copyCode);
      return;
    }
    const diffId = target.closest("[data-diff-id]");
    if (diffId) {
      event.preventDefault();
      const model = ui.modelOf(diffId.dataset.diffId);
      if (!model) return;
      const input = model.input || {};
      vscode.postMessage({
        type: "openDiff",
        id: model.id,
        file: (model.edit && model.edit.file) || ui.tools.fileOf(input),
        old: typeof input.old_string === "string" ? input.old_string : undefined,
        new: typeof input.new_string === "string" ? input.new_string : undefined,
      });
      return;
    }
    const diffFile = target.closest("[data-diff-file]");
    if (diffFile) {
      event.preventDefault();
      vscode.postMessage({ type: "openDiff", file: diffFile.dataset.diffFile });
      return;
    }
    const action = target.closest("[data-action]");
    if (action) {
      event.preventDefault();
      vscode.postMessage({ type: action.dataset.action });
      return;
    }
    const pathBtn = target.closest("[data-path]");
    if (pathBtn) {
      event.preventDefault();
      vscode.postMessage({
        type: "openFile",
        path: pathBtn.dataset.path,
        line: Number(pathBtn.dataset.line) || undefined,
      });
      return;
    }
    const link = target.closest("[data-url]");
    if (link) {
      event.preventDefault();
      vscode.postMessage({ type: "openUrl", url: link.dataset.url });
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "state":
        ui.setState(msg);
        break;
      case "mode":
        ui.setMode(msg.mode);
        break;
      case "models":
        ui.setModels(msg.models);
        break;
      case "agents":
        ui.setAgents(msg.agents);
        break;
      case "sessions":
        ui.setSessions(msg.rows);
        break;
      case "title":
        document.getElementById("title").textContent = msg.text || "Session";
        break;
      case "block":
        ui.upsert(msg.block);
        break;
      case "blockPatch":
        ui.patch(msg.id, msg.patch);
        break;
      case "toolResult":
        ui.toolResult(msg.id, msg.output, msg.isError, msg.edit);
        break;
      case "toolProgress":
        ui.toolProgress(msg.id, msg.elapsed);
        break;
      case "result":
        turnDelta = msg.delta;
        ui.turnEnd({ turns: msg.turns, delta: turnDelta, seconds: ui.activity.turnSeconds() });
        if (msg.error) ui.error(msg.error);
        break;
      case "busy":
        ui.setBusy(msg.value);
        break;
      case "error":
        ui.error(msg.text);
        ui.setBusy(false);
        break;
      case "notice":
        ui.notice(msg.text);
        break;
      case "status":
        ui.activity.setStatus(msg.text);
        break;
      case "context":
        ui.setContext(msg);
        break;
      case "commands":
        ui.setCommands(msg.commands);
        break;
      case "files":
        ui.setFiles(msg.files);
        break;
      case "sheet":
        ui.showSheet(msg.sheet);
        break;
      case "sheetClose":
        ui.closeSheet(msg.id);
        break;
      case "attached":
        ui.addImages(msg.images || []);
        break;
      case "insert":
        ui.insert(msg.text || "");
        break;
      case "user":
        ui.userMessage(msg.text || "", []);
        break;
      case "resetLog":
        ui.clearTranscript();
        ui.activity.reset();
        break;
      case "persist":
        if (msg.id) vscode.setState({ sessionId: msg.id });
        break;
      case "cleared":
        ui.clearTranscript();
        ui.activity.reset();
        ui.notice("Contexte vidé.");
        ui.setBusy(false);
        ui.resetContext();
        ui.activity.setStatus(null);
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
