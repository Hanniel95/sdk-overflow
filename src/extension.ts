import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { listProjectSessions, readSessionInfo, removeSession, sessionTitle } from "./catalog";
import { ChatHost, ChatHooks } from "./chatHost";
import { BEFORE_SCHEME, beforeStore } from "./snapshots";

const SECRET_KEY = "agentDev.anthropicApiKey";
const VIEW_TYPE = "agentDev.session";

interface SessionRow {
  id: string;
  title: string;
  when: number;
  open: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
  const desk = new SessionDesk(context);
  const list = new SessionList(context, desk);
  desk.attachList(list);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("agentDev.chat", list, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, desk),
    vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, beforeStore),
    vscode.commands.registerCommand("agentDev.setApiKey", () => desk.promptApiKey()),
    vscode.commands.registerCommand("agentDev.clearApiKey", () => desk.clearApiKey()),
    vscode.commands.registerCommand("agentDev.newSession", () => desk.openNew()),
    vscode.commands.registerCommand("agentDev.sendSelection", () => desk.insertSelection()),
    { dispose: () => desk.dispose() },
  );
}

export function deactivate(): void {
  /* les ressources sont libérées via context.subscriptions */
}

class SessionDesk implements vscode.WebviewPanelSerializer, ChatHooks {
  private readonly tabs = new Map<string, ChatHost>();
  private active?: ChatHost;
  private list?: SessionList;
  private listToken = 0;
  private listError = "";

  constructor(private readonly context: vscode.ExtensionContext) {}

  attachList(list: SessionList): void {
    this.list = list;
  }

  onChanged(): void {
    void this.refresh();
  }

  onFocus(host: ChatHost): void {
    this.active = host;
  }

  listSessions(): void {
    void this.refresh();
  }

  openSession(id: string): void {
    void this.openExisting(id);
  }

  onDispose(host: ChatHost): void {
    for (const [id, tab] of this.tabs) {
      if (tab === host) this.tabs.delete(id);
    }
    if (this.active === host) this.active = undefined;
    void this.refresh();
  }

  onIdentity(host: ChatHost, id: string): void {
    for (const [key, tab] of this.tabs) {
      if (tab === host && key !== id) this.tabs.delete(key);
    }
    this.tabs.set(id, host);
    void this.refresh();
  }

  newSession(): void {
    this.openNew();
  }

  promptKey(): void {
    void this.promptApiKey();
  }

  clearKey(): void {
    void this.clearApiKey();
  }

  private async saveKey(raw: string): Promise<void> {
    await this.context.secrets.store(SECRET_KEY, raw.trim());
    for (const tab of this.tabs.values()) {
      tab.dropProcess();
      await tab.pushState();
    }
    if (this.active) {
      void this.active.panel.webview.postMessage({
        type: "notice",
        text: "Clé API enregistrée dans le stockage sécurisé de l'éditeur.",
      });
      return;
    }
    void vscode.window.showInformationMessage("Clé API enregistrée.");
  }

  async promptApiKey(): Promise<void> {
    const key = await vscode.window.showInputBox({
      title: "Clé API Claude Console",
      prompt: "Crée une clé sur platform.claude.com dans l'organisation qui porte ton crédit.",
      placeHolder: "sk-ant-...",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().startsWith("sk-ant-") ? undefined : "La clé commence par sk-ant-"),
    });
    if (key) await this.saveKey(key);
  }

  async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    for (const tab of this.tabs.values()) {
      tab.dropProcess();
      await tab.pushState();
    }
    if (this.active) {
      void this.active.panel.webview.postMessage({ type: "notice", text: "Clé API supprimée." });
      return;
    }
    void vscode.window.showInformationMessage("Clé API supprimée.");
  }

  openNew(): ChatHost | undefined {
    const cwd = workspaceRoot();
    if (!cwd) {
      void this.refresh();
      return;
    }
    const id = `draft-${randomUUID()}`;
    const host = ChatHost.open(this.context, cwd, "Nouvelle session", undefined, this);
    this.tabs.set(id, host);
    this.active = host;
    void this.refresh();
    return host;
  }

  async openExisting(id: string): Promise<void> {
    const open = this.tabs.get(id);
    if (open) {
      open.reveal();
      return;
    }
    const cwd = workspaceRoot();
    if (!cwd) {
      void this.refresh();
      return;
    }
    let title = "Session";
    let dir = cwd;
    try {
      const info = await readSessionInfo(cwd, id);
      if (info) {
        title = sessionTitle(info);
        if (info.cwd) dir = info.cwd;
      }
    } catch {
      /* le titre reste générique, la reprise affichera l'erreur */
    }
    const host = ChatHost.open(this.context, dir, title, id, this);
    this.tabs.set(id, host);
    this.active = host;
    void this.refresh();
  }

  async deleteSession(id: string): Promise<void> {
    const host = this.tabs.get(id);
    const cwd = host?.cwd ?? workspaceRoot();
    host?.dispose();
    if (!id.startsWith("draft-") && cwd) {
      try {
        await removeSession(cwd, id);
      } catch (err) {
        this.listError = err instanceof Error ? err.message : String(err);
      }
    }
    void this.refresh();
  }

  async insertSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) return;
    const host = this.active ?? this.openNew();
    if (!host) return;
    const sel = editor.selection;
    const file = host.relative(editor.document.uri).replace(/\\/g, "/");
    const lines = `${sel.start.line + 1}-${sel.end.line + 1}`;
    const lang = editor.document.languageId;
    const code = editor.document.getText(sel);
    host.insert(`Dans \`${file}\` (lignes ${lines}) :\n\`\`\`${lang}\n${code}\n\`\`\`\n`);
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const cwd = workspaceRoot();
    const sessionId = sessionIdOf(state);
    if (!cwd) {
      panel.dispose();
      return;
    }
    let title = "Session";
    let dir = cwd;
    if (sessionId) {
      try {
        const info = await readSessionInfo(cwd, sessionId);
        if (info) {
          title = sessionTitle(info);
          if (info.cwd) dir = info.cwd;
        }
      } catch {
        /* reprise avec le dossier ouvert */
      }
    }
    const host = ChatHost.restore(this.context, panel, dir, title, sessionId, this);
    this.tabs.set(sessionId ?? `draft-${randomUUID()}`, host);
    this.active = host;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const token = ++this.listToken;
    const cwd = workspaceRoot();
    if (!cwd) {
      this.list?.post({
        type: "sessions",
        rows: this.openRows(),
        hint: "Ouvre un dossier de projet.",
        error: this.listError,
      });
      this.listError = "";
      return;
    }
    let listed: Awaited<ReturnType<typeof listProjectSessions>> = [];
    let error = "";
    try {
      listed = await listProjectSessions(cwd);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (!/ENOENT|no such file|not found/i.test(text)) error = text;
    }
    if (token !== this.listToken) return;
    error = this.listError || error;
    this.listError = "";
    const listedIds = new Set(listed.map((info) => info.sessionId));
    const rows: SessionRow[] = listed.map((info) => ({
      id: info.sessionId,
      title: sessionTitle(info),
      when: info.lastModified,
      open: this.tabs.has(info.sessionId),
    }));
    for (const row of this.openRows()) {
      if (!listedIds.has(row.id)) rows.push(row);
    }
    rows.sort((a, b) => b.when - a.when);
    for (const host of this.tabs.values()) host.showSessions(rows);
    this.list?.post({
      type: "sessions",
      rows,
      hint: rows.length ? "" : "Aucune session pour ce dossier.",
      error,
    });
  }

  dispose(): void {
    for (const host of this.tabs.values()) host.dispose();
    this.tabs.clear();
  }

  private openRows(): SessionRow[] {
    return [...this.tabs.entries()].map(([id, host]) => ({
      id,
      title: host.panel.title,
      when: host.touched,
      open: true,
    }));
  }
}

class SessionList implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly desk: SessionDesk,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.desk.refresh();
    });
  }

  post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  private async onMessage(msg: { type?: string; id?: string }): Promise<void> {
    switch (msg.type) {
      case "ready":
      case "refresh":
        await this.desk.refresh();
        break;
      case "new":
        this.desk.openNew();
        break;
      case "open":
        if (msg.id) await this.desk.openExisting(msg.id);
        break;
      case "delete":
        if (msg.id) await this.desk.deleteSession(msg.id);
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const media = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("sessions.css")}">
<title>Sessions</title>
</head>
<body>
  <div class="bar">
    <button id="new" type="button">+ Nouvelle session</button>
    <span class="spacer"></span>
    <button id="refresh" class="ghost" type="button" title="Recharger la liste">↻</button>
  </div>
  <div id="list" class="list"></div>
  <script nonce="${nonce}" src="${media("sessions.js")}"></script>
</body>
</html>`;
  }
}

function workspaceRoot(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

function sessionIdOf(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const id = (state as { sessionId?: unknown }).sessionId;
  return typeof id === "string" && id ? id : undefined;
}
