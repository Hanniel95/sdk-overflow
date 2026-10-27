import * as path from "path";
import * as vscode from "vscode";
import { readSession } from "./catalog";
import { historyEvents } from "./history";
import { beforeStore } from "./snapshots";
import {
  AgentSession,
  Effort,
  ImageAttachment,
  PermMode,
  SheetAnswer,
  SheetModel,
  UiEvent,
} from "./session";

const SECRET_KEY = "agentDev.anthropicApiKey";
const SPENT_KEY = "agentDev.spentUsd";
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;
const MODES: PermMode[] = ["default", "acceptEdits", "plan", "auto"];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const TAIL = 200;

export interface ChatHooks {
  onChanged(): void;
  onIdentity(host: ChatHost, id: string): void;
  onDispose(host: ChatHost): void;
  onFocus(host: ChatHost): void;
  promptKey(): void;
  clearKey(): void;
  newSession(): void;
  listSessions(): void;
  openSession(id: string): void;
}

export class ChatHost {
  resumeId?: string;
  touched = Date.now();
  private session?: AgentSession;
  private modelKey: string;
  private mode: PermMode = "default";
  private effort: Effort = "high";
  private fileSearch = 0;
  private generation = 0;
  private dirty = false;
  private ready = false;
  private pendingInsert = "";
  private sheetWaiters = new Map<string, (answer: SheetAnswer) => void>();
  /** Contenu d'un fichier avant chaque modification, par outil, puis avant la première de la session. */
  private snapshots = new Map<string, { file: string; before: string }>();
  private firstBefore = new Map<string, string>();

  private constructor(
    private readonly context: vscode.ExtensionContext,
    readonly panel: vscode.WebviewPanel,
    readonly cwd: string,
    resumeId: string | undefined,
    private readonly hooks: ChatHooks,
  ) {
    this.resumeId = resumeId;
    this.modelKey = vscode.workspace.getConfiguration("agentDev").get("model", "sonnet");
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = this.html(panel.webview);
    const subs = [
      panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      panel.onDidChangeViewState(() => {
        if (panel.active) this.hooks.onFocus(this);
      }),
    ];
    panel.onDidDispose(() => {
      this.session?.dispose();
      for (const sub of subs) sub.dispose();
      this.hooks.onDispose(this);
    });
    this.hooks.onFocus(this);
  }

  static open(
    context: vscode.ExtensionContext,
    cwd: string,
    title: string,
    resumeId: string | undefined,
    hooks: ChatHooks,
  ): ChatHost {
    const panel = vscode.window.createWebviewPanel("agentDev.session", title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    return new ChatHost(context, panel, cwd, resumeId, hooks);
  }

  static restore(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    cwd: string,
    title: string,
    resumeId: string | undefined,
    hooks: ChatHooks,
  ): ChatHost {
    panel.title = title;
    return new ChatHost(context, panel, cwd, resumeId, hooks);
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active);
    this.hooks.onFocus(this);
  }

  insert(text: string): void {
    this.pendingInsert += text;
    this.reveal();
    this.flushInsert();
  }

  /** Coupe le processus. Le transcript affiché reste en place. */
  dropProcess(): void {
    this.session?.dispose();
    this.session = undefined;
    for (const [id, waiter] of this.sheetWaiters) {
      waiter({ decision: "deny" });
      this.post({ type: "sheetClose", id });
    }
    this.sheetWaiters.clear();
  }

  dispose(): void {
    this.panel.dispose();
  }

  relative(uri: vscode.Uri): string {
    return path.relative(this.cwd, uri.fsPath) || uri.fsPath;
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private get spent(): number {
    return this.context.globalState.get<number>(SPENT_KEY, 0);
  }

  private get maxUsd(): number {
    return vscode.workspace.getConfiguration("agentDev").get<number>("maxUsd", 50);
  }

  async pushState(): Promise<void> {
    const hasKey = Boolean(await this.context.secrets.get(SECRET_KEY));
    this.post({ type: "title", text: this.panel.title });
    this.post({
      type: "state",
      model: this.modelKey,
      mode: this.mode,
      effort: this.effort,
      spent: this.spent,
      maxUsd: this.maxUsd,
      hasKey,
      cwd: this.cwd,
    });
  }

  private async onMessage(msg: { type?: string; [key: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.onReady();
        break;
      case "send":
        await this.send(String(msg.text ?? ""), (msg.images ?? []) as ImageAttachment[]);
        break;
      case "stop":
        await this.session?.interrupt();
        break;
      case "clear":
        this.clearConversation();
        break;
      case "model":
        if (typeof msg.value === "string" && msg.value.trim() && !/\s/.test(msg.value)) {
          this.modelKey = msg.value.trim();
          await this.session?.setModel(this.modelKey);
          await this.pushState();
        }
        break;
      case "effort":
        if (isEffort(msg.value)) {
          this.effort = msg.value;
          await this.session?.setEffort(msg.value);
          await this.pushState();
        }
        break;
      case "listSessions":
        this.hooks.listSessions();
        break;
      case "openSession":
        if (typeof msg.id === "string" && msg.id) this.hooks.openSession(msg.id);
        break;
      case "mode":
        if (isMode(msg.value)) {
          this.mode = msg.value;
          await this.session?.setMode(msg.value);
          await this.pushState();
        }
        break;
      case "sheetAnswer":
        this.resolveSheet(String(msg.id ?? ""), msg.answer);
        break;
      case "setKey":
        this.hooks.promptKey();
        break;
      case "clearKey":
        this.hooks.clearKey();
        break;
      case "newSession":
        this.hooks.newSession();
        break;
      case "copy":
        await vscode.env.clipboard.writeText(String(msg.text ?? ""));
        break;
      case "openDiff":
        await this.openDiff(
          typeof msg.id === "string" ? msg.id : undefined,
          String(msg.file ?? ""),
          typeof msg.old === "string" ? msg.old : undefined,
          typeof msg.new === "string" ? msg.new : undefined,
        );
        break;
      case "resetSpent":
        await this.context.globalState.update(SPENT_KEY, 0);
        await this.pushState();
        break;
      case "pickImages":
        await this.pickImages();
        break;
      case "dropUris":
        await this.handleDroppedUris((msg.uris ?? []) as string[]);
        break;
      case "searchFiles":
        await this.searchFiles(String(msg.query ?? ""));
        break;
      case "openFile":
        await this.openFile(String(msg.path ?? ""), Number(msg.line) || undefined);
        break;
      case "openUrl":
        await this.openUrl(String(msg.url ?? ""));
        break;
    }
  }

  private async onReady(): Promise<void> {
    const gen = ++this.generation;
    this.dirty = false;
    this.ready = true;
    await this.pushState();
    if (this.resumeId) this.post({ type: "persist", id: this.resumeId });
    this.flushInsert();
    if (!this.resumeId) return;
    try {
      const messages = await readSession(this.cwd, this.resumeId);
      if (gen !== this.generation || this.dirty) return;
      const tail = messages.slice(-TAIL);
      this.post({ type: "resetLog" });
      if (!tail.length) {
        this.post({ type: "notice", text: "Cette session n'a pas encore de messages." });
        return;
      }
      if (messages.length > tail.length) {
        this.post({
          type: "notice",
          text: `${messages.length - tail.length} messages plus anciens ne sont pas affichés. L'agent reprend tout le fil.`,
        });
      }
      for (const event of historyEvents(tail)) this.post(event);
    } catch (err) {
      if (gen !== this.generation) return;
      this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }

  private flushInsert(): void {
    if (!this.ready || !this.pendingInsert) return;
    this.post({ type: "insert", text: this.pendingInsert });
    this.pendingInsert = "";
  }

  private resolveSheet(id: string, answer: unknown): void {
    const waiter = this.sheetWaiters.get(id);
    const parsed = asAnswer(answer);
    if (!waiter || !parsed) return;
    this.sheetWaiters.delete(id);
    waiter(parsed);
  }

  private askSheet(sheet: SheetModel, signal: AbortSignal): Promise<SheetAnswer> {
    if (signal.aborted) return Promise.resolve({ decision: "deny" });
    return new Promise((resolve) => {
      const finish = (answer: SheetAnswer) => {
        this.sheetWaiters.delete(sheet.id);
        resolve(answer);
      };
      this.sheetWaiters.set(sheet.id, finish);
      this.post({ type: "sheet", sheet });
      signal.addEventListener("abort", () => {
        this.post({ type: "sheetClose", id: sheet.id });
        finish({ decision: "deny" });
      }, { once: true });
    });
  }

  private async send(text: string, images: ImageAttachment[]): Promise<void> {
    this.dirty = true;
    this.touched = Date.now();
    this.retitle(text);
    if (this.spent >= this.maxUsd) {
      this.post({
        type: "error",
        text: `Plafond de ${this.maxUsd} $ atteint (${this.spent.toFixed(2)} $ dépensés). ` +
          "Augmente le réglage agentDev.maxUsd ou réinitialise le compteur.",
      });
      return;
    }
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      this.post({ type: "error", text: "Aucune clé API. Clique sur « Clé API » pour la définir." });
      return;
    }

    if (!this.session || !this.session.isAlive) {
      this.session?.dispose();
      const config = vscode.workspace.getConfiguration("agentDev");
      this.session = new AgentSession(
        {
          cwd: this.cwd,
          apiKey,
          modelKey: this.modelKey,
          mode: this.mode,
          effort: this.effort,
          claudePath: config.get<string>("claudePath") || undefined,
          confirmShell: config.get<boolean>("confirmShell", true),
          resume: this.resumeId,
        },
        (event) => this.onSessionEvent(event),
        (sheet, signal) => this.askSheet(sheet, signal),
      );
      try {
        await this.session.start();
      } catch (err) {
        this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
        this.session = undefined;
        return;
      }
    }
    this.session.send(text, images);
  }

  private retitle(text: string): void {
    if (this.panel.title !== "Nouvelle session" && this.panel.title !== "Session") return;
    const line = text.split("\n").map((part) => part.trim()).find(Boolean);
    if (!line) return;
    this.panel.title = line.length > 72 ? `${line.slice(0, 72)}…` : line;
    this.post({ type: "title", text: this.panel.title });
    this.hooks.onChanged();
  }

  showSessions(rows: { id: string; title: string; when: number; open: boolean }[]): void {
    this.post({ type: "sessions", rows });
  }

  private onSessionEvent(event: UiEvent): void {
    if (event.type === "session") {
      this.adopt(event.id);
      return;
    }
    if (event.type === "result") {
      this.touched = Date.now();
      if (event.delta > 0) {
        void this.context.globalState
          .update(SPENT_KEY, this.spent + event.delta)
          .then(() => this.pushState());
      }
      this.hooks.onChanged();
    }
    if (event.type === "effort") {
      this.effort = event.effort;
      void this.pushState();
      return;
    }
    if (event.type === "mode") this.mode = event.mode;
    if (event.type === "toolResult" && event.edit) {
      const { before, ...rest } = event;
      const file = this.absolute(event.edit.file);
      if (typeof before === "string") {
        this.snapshots.set(event.id, { file, before });
        if (!this.firstBefore.has(file)) this.firstBefore.set(file, before);
      }
      this.post({ ...rest, edit: { ...event.edit, rel: this.relative(vscode.Uri.file(file)).replace(/\\/g, "/") } });
      return;
    }
    this.post(event);
    if (event.type === "mode") void this.pushState();
  }

  private adopt(id: string): void {
    this.post({ type: "persist", id });
    if (this.resumeId === id) return;
    this.resumeId = id;
    this.hooks.onIdentity(this, id);
  }

  private clearConversation(): void {
    if (this.session?.isAlive) {
      this.session.send("/clear", []);
      return;
    }
    this.post({ type: "cleared" });
  }

  private async searchFiles(query: string): Promise<void> {
    const token = ++this.fileSearch;
    const safe = query.replace(/[*?[\]{}]/g, "").trim();
    if (!safe) {
      this.post({ type: "files", files: [] });
      return;
    }
    const glob = safe.includes("/") ? `**/${safe.replace(/\\/g, "/")}*` : `**/*${safe}*`;
    const uris = await vscode.workspace.findFiles(
      glob,
      "{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}",
      30,
    );
    if (token !== this.fileSearch) return;
    const files = uris
      .map((uri) => this.relative(uri).replace(/\\/g, "/"))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, 20);
    this.post({ type: "files", files });
  }

  private async openFile(filePath: string, line?: number): Promise<void> {
    if (!filePath) return;
    const target = path.isAbsolute(filePath) ? filePath : path.join(this.cwd, filePath);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      this.post({ type: "notice", text: `Impossible d'ouvrir ${filePath}` });
    }
  }

  private absolute(filePath: string): string {
    return path.normalize(path.isAbsolute(filePath) ? filePath : path.join(this.cwd, filePath));
  }

  /**
   * Diff natif : avant la modification (ou avant la première de la session pour
   * le bandeau des fichiers) contre le fichier actuel. Une session relue n'a
   * pas d'instantané : on le reconstruit en défaisant le remplacement d'Edit.
   */
  private async openDiff(id: string | undefined, filePath: string, oldText?: string, newText?: string): Promise<void> {
    if (!filePath) return;
    const file = this.absolute(filePath);
    let before = id ? this.snapshots.get(id)?.before : this.firstBefore.get(file);
    if (before === undefined && typeof oldText === "string" && typeof newText === "string" && newText) {
      try {
        const current = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(file))).toString("utf8");
        const at = current.indexOf(newText);
        if (at >= 0) before = current.slice(0, at) + oldText + current.slice(at + newText.length);
      } catch {
        /* fichier supprimé depuis : on tente l'ouverture simple */
      }
    }
    if (before === undefined) {
      await this.openFile(file);
      return;
    }
    const name = path.basename(file);
    await vscode.commands.executeCommand(
      "vscode.diff",
      beforeStore.uriFor(file, before),
      vscode.Uri.file(file),
      `${name} (avant ↔ maintenant)`,
      { preview: true },
    );
  }

  private async openUrl(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) return;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private async pickImages(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
      defaultUri: vscode.Uri.file(this.cwd),
    });
    if (uris?.length) await this.attachUris(uris);
  }

  private async handleDroppedUris(raw: string[]): Promise<void> {
    const uris = raw
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (item.includes("://") ? vscode.Uri.parse(item) : vscode.Uri.file(item)));
    await this.attachUris(uris);
  }

  private async attachUris(uris: vscode.Uri[]): Promise<void> {
    const images: ImageAttachment[] = [];
    const mentions: string[] = [];
    for (const uri of uris) {
      const ext = path.extname(uri.fsPath).toLowerCase();
      const mediaType = IMAGE_TYPES[ext];
      if (!mediaType) {
        mentions.push(this.relative(uri));
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        this.post({
          type: "notice",
          text: `${path.basename(uri.fsPath)} dépasse 3,75 Mo : je donne son chemin à l'agent à la place.`,
        });
        mentions.push(this.relative(uri));
        continue;
      }
      images.push({
        name: path.basename(uri.fsPath),
        mediaType,
        data: Buffer.from(bytes).toString("base64"),
      });
    }
    if (images.length) this.post({ type: "attached", images });
    if (mentions.length) this.post({ type: "insert", text: `${mentions.map(mentionText).join(" ")} ` });
  }

  private html(webview: vscode.Webview): string {
    const media = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const script = (file: string) => `<script nonce="${nonce}" src="${media(file)}"></script>`;
    const sessionId = esc(this.resumeId ?? "");
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta id="session" data-id="${sessionId}">
<link rel="stylesheet" href="${media("chat.css")}">
<title>SDK Overflow</title>
</head>
<body>
  <header class="top">
    <h1 id="title">${esc(this.panel.title)}</h1>
    <span id="cost" class="cost"></span>
    <button id="newbtn" class="icon" type="button" title="Nouvelle session">${ICONS.plus}</button>
    <button id="history" class="icon" type="button" title="Sessions">${ICONS.history}</button>
    <button id="more" class="icon" type="button" title="Plus d'options">${ICONS.more}</button>
    <div id="headpop" class="pop head" hidden></div>
  </header>
  <div class="stage">
    <main id="log" class="log"></main>
    <button id="jump" class="jump" type="button" hidden>↓ Aller en bas</button>
  </div>
  <footer class="dock">
    <div id="strips" class="strips">
      <div id="files" class="strip" hidden></div>
      <div id="todos" class="strip" hidden></div>
    </div>
    <div id="spinner" class="spinner" hidden></div>
    <div id="sheet" class="sheet" hidden></div>
    <div class="composer" id="composer">
      <div id="palette" class="palette" hidden></div>
      <div id="pop" class="pop" hidden></div>
      <div id="attachments" class="attachments"></div>
      <textarea id="input" rows="1" placeholder="Demande quelque chose à l'agent…  (/ commandes, @ fichiers)"></textarea>
      <div class="crow">
        <button id="plus" class="icon" type="button" title="Joindre">${ICONS.plus}</button>
        <button id="modebtn" class="pill mode" type="button" title="Mode (Maj+Tab)">Manuel</button>
        <button id="slash" class="icon mono" type="button" title="Commandes">/</button>
        <span class="spacer"></span>
        <button id="modelbtn" class="pill" type="button">Sonnet 5.5 · High</button>
        <span id="ring" class="ring" hidden><svg viewBox="0 0 20 20" aria-hidden="true"><circle class="ring-bg" cx="10" cy="10" r="7"></circle><circle id="ring-fill" class="ring-fill" cx="10" cy="10" r="7"></circle></svg><span id="ring-text"></span></span>
        <button id="stop" class="stopbtn" type="button" title="Arrêter (Échap)" hidden>${ICONS.stop}</button>
        <button id="send" class="sendbtn" type="button" title="Envoyer (Entrée)">${ICONS.send}</button>
      </div>
    </div>
  </footer>
  ${script("markdown.js")}
  ${script("tools.js")}
  ${script("transcript.js")}
  ${script("activity.js")}
  ${script("sheet.js")}
  ${script("composer.js")}
  ${script("chat.js")}
</body>
</html>`;
  }
}

const ICONS = {
  plus: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`,
  history: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/></svg>`,
  more: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/></svg>`,
  send: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>`,
  stop: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>`,
};

function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as string[]).includes(value);
}

function isMode(value: unknown): value is PermMode {
  return typeof value === "string" && (MODES as string[]).includes(value);
}

function asAnswer(value: unknown): SheetAnswer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const answer = value as { decision?: string; answers?: unknown };
  if (answer.decision === "allow" || answer.decision === "always" || answer.decision === "deny") {
    return { decision: answer.decision };
  }
  if (answer.decision === "submit" && answer.answers && typeof answer.answers === "object") {
    const answers: Record<string, string> = {};
    for (const [key, item] of Object.entries(answer.answers as Record<string, unknown>)) {
      if (typeof item === "string") answers[key] = item;
    }
    return { decision: "submit", answers };
  }
  return undefined;
}

function mentionText(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return /\s/.test(normalized) ? `\`${normalized}\`` : `@${normalized}`;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}
