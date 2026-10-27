import type {
  CanUseTool,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  UserDialogRequest,
  UserDialogResult,
} from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

function resolveModel(key: string | undefined): string {
  if (!key) return MODELS.sonnet;
  return MODELS[key] ?? key;
}

function taskCard(msg: {
  tool_use_id?: string;
  task_id: string;
  description: string;
  subagent_type?: string;
  task_type?: string;
  prompt?: string;
  parent_task_id?: string;
}): UiEvent {
  return {
    type: "block",
    block: {
      id: msg.tool_use_id || msg.task_id,
      kind: "tool",
      name: "Agent",
      parent: msg.parent_task_id,
      sub: Boolean(msg.parent_task_id),
      input: {
        description: msg.description,
        subagent_type: msg.subagent_type || msg.task_type || "agent",
        prompt: msg.prompt || "",
      },
      streaming: false,
      running: true,
    },
  };
}

export const MODELS: Record<string, string> = {
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  haiku: "claude-haiku-5-5",
};

export type PermMode = "default" | "acceptEdits" | "plan" | "auto";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ImageAttachment {
  name: string;
  mediaType: string;
  data: string;
}

export interface SlashItem {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionModel {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface DiffModel {
  old: string;
  new: string;
}

export type SheetModel =
  | {
      id: string;
      kind: "permission";
      tool: string;
      title: string;
      description?: string;
      mono?: string;
      file?: string;
      diff?: DiffModel;
      write?: string;
      detail?: string;
      canAlways: boolean;
    }
  | { id: string; kind: "question"; questions: QuestionModel[] }
  | { id: string; kind: "plan"; title: string; body: string }
  | { id: string; kind: "refusal"; title: string; body: string };

export type SheetAnswer =
  | { decision: "allow" }
  | { decision: "always" }
  | { decision: "deny" }
  | { decision: "submit"; answers: Record<string, string> };

export interface TranscriptBlock {
  id: string;
  kind: "text" | "thinking" | "tool";
  /** Outil Agent qui a produit ce bloc. Le panneau l'imbrique dans sa carte. */
  parent?: string;
  sub?: boolean;
  text?: string;
  streaming?: boolean;
  running?: boolean;
  redacted?: boolean;
  tokens?: number;
  name?: string;
  input?: Record<string, unknown>;
  detail?: string;
}

export interface EditHunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

/** Résultat structuré d'Edit ou Write, pour le diff numéroté et le bandeau des fichiers. */
export interface EditInfo {
  file: string;
  kind: "create" | "update";
  hunks: EditHunk[];
  added: number;
  removed: number;
}

export interface BlockPatch {
  append?: string;
  text?: string;
  streaming?: boolean;
  running?: boolean;
  tokens?: number;
  input?: Record<string, unknown>;
  detail?: string;
  remove?: boolean;
}

export type UiEvent =
  | { type: "block"; block: TranscriptBlock }
  | { type: "blockPatch"; id: string; patch: BlockPatch }
  | { type: "toolResult"; id: string; output: string; isError: boolean; edit?: EditInfo; before?: string | null }
  | { type: "toolProgress"; id: string; elapsed: number }
  | { type: "result"; delta: number; turns: number; isError: boolean; error?: string }
  | { type: "busy"; value: boolean }
  | { type: "error"; text: string }
  | { type: "notice"; text: string }
  | { type: "status"; text: string | null }
  | { type: "cleared" }
  | { type: "commands"; commands: SlashItem[] }
  | { type: "models"; models: { value: string; displayName: string; description: string }[] }
  | { type: "agents"; agents: { name: string; description: string }[] }
  | { type: "effort"; effort: Effort }
  | { type: "context"; used: number; max: number; percentage: number }
  | { type: "mode"; mode: PermMode }
  | { type: "sheet"; sheet: SheetModel }
  | { type: "sheetClose"; id: string }
  | { type: "user"; text: string }
  | { type: "resetLog" }
  | { type: "session"; id: string };

export interface SessionConfig {
  cwd: string;
  apiKey: string;
  modelKey: string;
  mode: PermMode;
  effort?: Effort;
  claudePath?: string;
  confirmShell: boolean;
  /** Session déjà enregistrée à reprendre. Absent pour une session neuve. */
  resume?: string;
}

type ToolOpts = Parameters<CanUseTool>[2];
type AskSheet = (sheet: SheetModel, signal: AbortSignal) => Promise<SheetAnswer>;

const CLIP = 20_000;

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;

  push(msg: SDKUserMessage): void {
    this.items.push(msg);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }
  }
}

interface Slot {
  key: string;
  kind: "text" | "thinking" | "tool";
  parent: string | null;
  toolId?: string;
  created: boolean;
  done: boolean;
}

interface LooseEvent {
  type?: string;
  index?: number;
  message?: { id?: string };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    text?: string;
    thinking?: string;
    input?: Record<string, unknown>;
  };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
}

interface LooseBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Une conversation avec l'agent (un processus Claude Code sous-jacent). */
export class AgentSession {
  private queue = new MessageQueue();
  private query?: Query;
  private alive = false;
  private lastCumulativeCost = 0;
  private messageId = "stream";
  private seq: Slot[] = [];
  private partialJson = new Map<string, string>();
  private openThinking = new Map<string, string>();
  private sawThinking = false;

  constructor(
    private config: SessionConfig,
    private emit: (e: UiEvent) => void,
    private ask: AskSheet,
  ) {}

  get isAlive(): boolean {
    return this.alive;
  }

  async start(): Promise<void> {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const env: Record<string, string | undefined> = {
      ...process.env,
      ANTHROPIC_API_KEY: this.config.apiKey,
      CLAUDE_AGENT_SDK_CLIENT_APP: "sdk-overflow/0.1.4",
    };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const options: Options = {
      cwd: this.config.cwd,
      model: resolveModel(this.config.modelKey),
      tools: { type: "preset", preset: "claude_code" },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "Tu travailles dans l'éditeur Cursor de l'utilisateur. Réponds en français, " +
          "sois concis dans tes explications et va droit au code. " +
          "Délègue à un sous-agent avec l'outil Agent dès qu'une recherche ou une tâche peut avancer à part.",
      },
      settingSources: ["user", "project", "local"],
      permissionMode: this.config.mode,
      effort: this.config.effort ?? "high",
      agentProgressSummaries: true,
      includePartialMessages: true,
      forwardSubagentText: true,
      thinking: { type: "adaptive" },
      canUseTool: (toolName, input, opts) => this.canUseTool(toolName, input, opts),
      ...(this.config.resume ? { resume: this.config.resume } : {}),
      supportedDialogKinds: ["refusal_fallback_prompt"],
      onUserDialog: (request, ctx) => this.onDialog(request, ctx),
      env,
    };
    if (this.config.claudePath) {
      options.pathToClaudeCodeExecutable = this.config.claudePath;
    }

    this.query = sdk.query({ prompt: this.queue, options });
    this.alive = true;
    void this.consume(this.query);
    void this.loadCatalog();
  }

  /**
   * AskUserQuestion n'est pas une autorisation oui/non : le CLI lit `answers`
   * dans updatedInput. Une feuille qui se contente d'autoriser laisse le
   * modèle croire que l'utilisateur n'a pas répondu.
   */
  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: ToolOpts,
  ): Promise<PermissionResult> {
    const toolUseID = options.toolUseID;
    if (options.signal.aborted) {
      return { behavior: "deny", message: "Annulé.", toolUseID, decisionClassification: "user_reject" };
    }
    if (toolName === "AskUserQuestion") {
      return this.answerQuestion(input, options);
    }
    const shell = toolName === "Bash" || toolName === "PowerShell";
    if (!this.config.confirmShell && shell) {
      return { behavior: "allow", updatedInput: input, toolUseID, decisionClassification: "user_permanent" };
    }

    const sheet = buildSheet(options.requestId || toolUseID, toolName, input, options);
    const answer = await this.ask(sheet, options.signal);
    if (options.signal.aborted || answer.decision === "deny") {
      return {
        behavior: "deny",
        message: "Refusé par l'utilisateur.",
        toolUseID,
        decisionClassification: "user_reject",
      };
    }
    const always = answer.decision === "always" && sheet.kind === "permission" && sheet.canAlways;
    return {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: always ? permissionsFor(toolName, input, options.suggestions) : undefined,
      toolUseID,
      decisionClassification: always ? "user_permanent" : "user_temporary",
    };
  }

  private async answerQuestion(input: Record<string, unknown>, options: ToolOpts): Promise<PermissionResult> {
    const questions = normalizeQuestions(input.questions);
    const toolUseID = options.toolUseID;
    if (questions.length === 0) {
      return {
        behavior: "deny",
        message: "La question envoyée par l'agent est vide.",
        toolUseID,
        decisionClassification: "user_reject",
      };
    }
    const answer = await this.ask(
      { id: options.requestId || toolUseID, kind: "question", questions },
      options.signal,
    );
    if (answer.decision !== "submit" || options.signal.aborted) {
      return {
        behavior: "deny",
        message: "L'utilisateur n'a pas répondu à la question.",
        toolUseID,
        decisionClassification: "user_reject",
      };
    }
    return {
      behavior: "allow",
      updatedInput: { ...input, answers: answer.answers },
      toolUseID,
      decisionClassification: "user_temporary",
    };
  }

  private async onDialog(
    request: UserDialogRequest,
    ctx: { signal: AbortSignal; requestId: string },
  ): Promise<UserDialogResult | null> {
    if (request.dialogKind !== "refusal_fallback_prompt") {
      return null;
    }
    const payload = request.payload ?? {};
    const title = firstString(payload, ["title", "header"]) || "Réessayer avec un autre modèle ?";
    const body = firstString(payload, ["message", "prompt", "content", "description"]);
    const answer = await this.ask({ id: ctx.requestId, kind: "refusal", title, body }, ctx.signal);
    if (ctx.signal.aborted) {
      return { behavior: "cancelled" };
    }
    const accepted = answer.decision === "allow";
    return { behavior: "completed", result: { accepted, retry: accepted } };
  }

  private async loadCatalog(): Promise<void> {
    const q = this.query;
    if (!q) return;
    const [cmds, models, agents] = await Promise.all([
      q.supportedCommands().catch(() => undefined),
      q.supportedModels().catch(() => undefined),
      q.supportedAgents().catch(() => undefined),
    ]);
    if (cmds?.length) this.emit({ type: "commands", commands: cmds.map(toSlash) });
    if (models?.length) {
      this.emit({
        type: "models",
        models: models.map((item) => ({
          value: item.value,
          displayName: item.displayName,
          description: item.description,
        })),
      });
    }
    const list = agents ?? [];
    this.emit({
      type: "agents",
      agents: list.map((item) => ({ name: item.name, description: item.description })),
    });
    if (!list.length) {
      this.emit({
        type: "notice",
        text: "Aucun sous-agent n'est chargé pour cette session. L'outil Agent n'a donc personne à lancer.",
      });
    }
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        this.handle(msg);
      }
    } catch (err) {
      this.emit({ type: "error", text: formatError(err) });
    } finally {
      this.alive = false;
      this.emit({ type: "busy", value: false });
      this.emit({ type: "status", text: null });
    }
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case "stream_event":
        this.onStream(msg);
        break;
      case "assistant":
        this.onAssistant(msg);
        break;
      case "user":
        this.onUser(msg);
        break;
      case "tool_progress":
        this.emit({ type: "toolProgress", id: msg.tool_use_id, elapsed: msg.elapsed_time_seconds });
        break;
      case "result":
        this.onResult(msg);
        break;
      case "conversation_reset":
        this.seq = [];
        this.partialJson.clear();
        this.openThinking.clear();
        this.sawThinking = false;
        this.emit({ type: "cleared" });
        this.emit({ type: "busy", value: false });
        this.emit({ type: "status", text: null });
        if (msg.new_conversation_id) this.emit({ type: "session", id: msg.new_conversation_id });
        break;
      case "system":
        this.onSystem(msg);
        break;
      default:
        break;
    }
  }

  private onStream(msg: SDKPartialAssistantMessage): void {
    const ev = msg.event as LooseEvent;
    const parent = msg.parent_tool_use_id;
    if (ev.type === "message_start") {
      this.messageId = ev.message?.id || msg.uuid;
      return;
    }
    if (ev.type === "content_block_start") {
      this.onBlockStart(parent, ev);
      return;
    }
    if (ev.type === "content_block_delta") {
      this.onBlockDelta(parent, ev);
      return;
    }
    if (ev.type === "content_block_stop") {
      const slot = this.slotAt(parent, ev.index);
      if (slot && slot.kind !== "tool") {
        this.emit({ type: "blockPatch", id: this.uiId(slot), patch: { streaming: false } });
        if (slot.kind === "thinking") this.openThinking.delete(parentKey(parent));
      }
    }
  }

  private onBlockStart(parent: string | null, ev: LooseEvent): void {
    const block = ev.content_block;
    if (!block?.type || ev.index === undefined) return;
    const kind = blockKind(block.type);
    if (kind === "other") return;
    const key = `${parentKey(parent)}:${this.messageId}:${ev.index}`;
    const slot: Slot = {
      key,
      kind,
      parent,
      toolId: kind === "tool" ? block.id || key : undefined,
      created: false,
      done: false,
    };
    this.seq.push(slot);
    if (kind === "thinking") {
      this.sawThinking = true;
      this.emit({ type: "blockPatch", id: meterId(parent), patch: { remove: true } });
      slot.created = true;
      this.openThinking.set(parentKey(parent), key);
      this.emit({
        type: "block",
        block: {
          id: key,
          kind: "thinking",
          parent: parent || undefined,
          sub: parent !== null,
          text: block.thinking || "",
          streaming: true,
          redacted: block.type === "redacted_thinking",
        },
      });
      return;
    }
    if (kind === "text") {
      if (block.text) {
        slot.created = true;
        this.emit({
          type: "block",
          block: { id: key, kind: "text", parent: parent || undefined, sub: parent !== null, text: block.text, streaming: true },
        });
      }
      return;
    }
    slot.created = true;
    this.emit({
      type: "block",
      block: {
        id: slot.toolId || key,
        kind: "tool",
        parent: parent || undefined,
        sub: parent !== null,
        name: block.name || "Outil",
        input: clipRecord(block.input),
        streaming: true,
        running: true,
      },
    });
  }

  private onBlockDelta(parent: string | null, ev: LooseEvent): void {
    const slot = this.slotAt(parent, ev.index);
    const delta = ev.delta;
    if (!slot || !delta) return;
    if (delta.type === "text_delta" && delta.text) {
      this.ensureText(slot, parent);
      this.emit({ type: "blockPatch", id: slot.key, patch: { append: delta.text } });
    } else if (delta.type === "thinking_delta" && delta.thinking) {
      this.emit({ type: "blockPatch", id: slot.key, patch: { append: delta.thinking, streaming: true } });
    } else if (delta.type === "input_json_delta" && delta.partial_json && slot.kind === "tool") {
      const buf = (this.partialJson.get(slot.key) ?? "") + delta.partial_json;
      this.partialJson.set(slot.key, buf);
      const input = liveInput(buf);
      if (input) {
        this.emit({ type: "blockPatch", id: this.uiId(slot), patch: { input: clipRecord(input) } });
      }
    }
  }

  private ensureText(slot: Slot, parent: string | null): void {
    if (slot.created) return;
    slot.created = true;
    this.emit({
      type: "block",
      block: { id: slot.key, kind: "text", parent: parent || undefined, sub: parent !== null, text: "", streaming: true },
    });
  }

  private onAssistant(msg: SDKAssistantMessage): void {
    const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
    const parent = msg.parent_tool_use_id;
    for (const raw of content) {
      const block = raw as LooseBlock;
      const kind = blockKind(block.type);
      if (kind === "other") continue;
      const slot = this.matchSlot(parent, kind, block.id);
      if (kind === "tool") {
        const id = block.id || slot?.toolId || `tool-${msg.uuid}`;
        if (slot?.toolId && slot.toolId !== id) {
          this.emit({ type: "blockPatch", id: slot.toolId, patch: { remove: true } });
        }
        const input = clipRecord(block.input);
        if (slot?.created) {
          this.emit({ type: "blockPatch", id, patch: { input, streaming: false, running: true } });
        } else {
          this.emit({
            type: "block",
            block: {
              id,
              kind: "tool",
              parent: parent || undefined,
              sub: parent !== null,
              name: block.name || "Outil",
              input,
              streaming: false,
              running: true,
            },
          });
        }
        if (slot) {
          slot.created = true;
          slot.done = true;
          slot.toolId = id;
        }
        continue;
      }
      const text = kind === "thinking" ? block.thinking || block.text || "" : block.text || "";
      if (slot?.created) {
        const patch: BlockPatch = { streaming: false };
        if (text) patch.text = text;
        this.emit({ type: "blockPatch", id: slot.key, patch });
        slot.done = true;
      } else if (text.trim()) {
        const id = slot?.key || `final-${msg.uuid}-${kind}`;
        this.emit({
          type: "block",
          block: {
            id,
            kind,
            parent: parent || undefined,
            sub: parent !== null,
            text,
            streaming: false,
            redacted: block.type === "redacted_thinking",
          },
        });
        if (slot) {
          slot.created = true;
          slot.done = true;
        }
      } else if (slot) {
        slot.done = true;
      }
      if (kind === "thinking") this.openThinking.delete(parentKey(parent));
    }
  }

  private onUser(msg: SDKUserMessage): void {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    const results = content.filter((raw) => (raw as LooseBlock).type === "tool_result") as LooseBlock[];
    for (const block of results) {
      if (!block.tool_use_id) continue;
      const structured = results.length === 1 ? msg.tool_use_result : undefined;
      const edit = editOf(structured);
      this.emit({
        type: "toolResult",
        id: block.tool_use_id,
        output: clip(formatToolOutput(block.content, structured)),
        isError: block.is_error === true,
        ...(edit ? { edit: edit.info, before: edit.before } : {}),
      });
    }
  }

  private matchSlot(parent: string | null, kind: Slot["kind"], toolId?: string): Slot | undefined {
    if (kind === "tool" && toolId) {
      const exact = this.seq.find((s) => !s.done && s.parent === parent && s.kind === "tool" && s.toolId === toolId);
      if (exact) return exact;
    }
    return this.seq.find((s) =>
      !s.done && s.parent === parent && s.kind === kind && (kind !== "tool" || !s.toolId || s.toolId === s.key));
  }

  private onResult(msg: Extract<SDKMessage, { type: "result" }>): void {
    const cumulative = msg.total_cost_usd ?? this.lastCumulativeCost;
    const delta = Math.max(0, cumulative - this.lastCumulativeCost);
    this.lastCumulativeCost = cumulative;
    let error: string | undefined;
    if (msg.subtype !== "success") {
      error = msg.errors?.join(" ") || msg.subtype;
    } else if (msg.is_error) {
      error = msg.result || msg.terminal_reason || "erreur API";
    }
    this.finishTurn();
    this.emit({ type: "result", delta, turns: msg.num_turns, isError: msg.is_error, error });
    this.emit({ type: "busy", value: false });
    this.emit({ type: "status", text: null });
    void this.refreshContext();
  }

  private finishTurn(): void {
    for (const slot of this.seq) {
      if (!slot.done && slot.created && slot.kind !== "tool") {
        this.emit({ type: "blockPatch", id: this.uiId(slot), patch: { streaming: false } });
      }
    }
    this.seq = [];
    this.partialJson.clear();
    this.openThinking.clear();
    this.sawThinking = false;
    this.emit({ type: "blockPatch", id: meterId(null), patch: { remove: true } });
  }

  private onSystem(msg: Extract<SDKMessage, { type: "system" }>): void {
    switch (msg.subtype) {
      case "init":
        if (msg.session_id) this.emit({ type: "session", id: msg.session_id });
        if (msg.effort) this.emit({ type: "effort", effort: msg.effort });
        if (Array.isArray(msg.tools) && !msg.tools.some((name) => name === "Agent" || name === "Task")) {
          this.emit({
            type: "notice",
            text: "Cette session n'a pas l'outil Agent. Les sous-agents ne peuvent pas démarrer.",
          });
        }
        break;
      case "task_started":
        if (!msg.skip_transcript && !msg.ambient) this.emit(taskCard(msg));
        break;
      case "task_progress":
        this.emit({ type: "toolProgress", id: msg.tool_use_id || msg.task_id, elapsed: (msg.usage?.duration_ms ?? 0) / 1000 });
        if (msg.summary || msg.last_tool_name) {
          this.emit({
            type: "blockPatch",
            id: msg.tool_use_id || msg.task_id,
            patch: { detail: msg.summary || msg.last_tool_name },
          });
        }
        break;
      case "task_notification":
        if (!msg.skip_transcript && !msg.ambient) {
          this.emit({
            type: "toolResult",
            id: msg.tool_use_id || msg.task_id,
            output: msg.summary || "",
            isError: msg.status === "failed",
          });
        }
        break;
      case "thinking_tokens": {
        const parent = null;
        const open = this.openThinking.get(parentKey(parent));
        if (open) {
          this.emit({ type: "blockPatch", id: open, patch: { tokens: msg.estimated_tokens, streaming: true } });
        } else if (!this.sawThinking) {
          const id = meterId(parent);
          this.emit({
            type: "block",
            block: {
              id,
              kind: "thinking",
              streaming: true,
              redacted: true,
              tokens: msg.estimated_tokens,
              text: "",
            },
          });
        }
        break;
      }
      case "status": {
        if (msg.status === "compacting") {
          this.emit({ type: "status", text: "Compactage du contexte…" });
        } else if (msg.compact_result) {
          this.emit({ type: "status", text: null });
          this.emit({ type: "busy", value: false });
        } else if (msg.status === null) {
          this.emit({ type: "status", text: null });
        }
        const mode = msg.permissionMode;
        if (mode === "default" || mode === "acceptEdits" || mode === "plan" || mode === "auto") {
          this.config.mode = mode;
          this.emit({ type: "mode", mode });
        }
        break;
      }
      case "compact_boundary": {
        const pre = msg.compact_metadata?.pre_tokens;
        const post = msg.compact_metadata?.post_tokens;
        const from = typeof pre === "number" ? pre.toLocaleString("fr-FR") : "?";
        const to = typeof post === "number" ? ` → ${post.toLocaleString("fr-FR")}` : "";
        this.emit({ type: "notice", text: `Contexte réduit : ${from}${to} tokens.` });
        break;
      }
      case "local_command_output":
        if (msg.content?.trim()) {
          this.emit({
            type: "block",
            block: { id: msg.uuid, kind: "text", text: msg.content, streaming: false },
          });
        }
        this.emit({ type: "busy", value: false });
        this.emit({ type: "status", text: null });
        break;
      case "commands_changed":
        this.emit({ type: "commands", commands: msg.commands.map(toSlash) });
        break;
      case "permission_denied":
        this.emit({ type: "notice", text: msg.message || `${msg.tool_name} refusé.` });
        break;
      case "api_retry":
        this.emit({
          type: "status",
          text: `Nouvel essai ${msg.attempt}/${msg.max_retries}…`,
        });
        break;
      default:
        break;
    }
  }

  private async refreshContext(): Promise<void> {
    try {
      const usage = await this.query?.getContextUsage({ detail: "summary" });
      if (!usage) return;
      this.emit({
        type: "context",
        used: usage.totalTokens,
        max: usage.maxTokens,
        percentage: usage.percentage,
      });
    } catch {
      /* la jauge reste sur sa dernière valeur */
    }
  }

  private slotAt(parent: string | null, index: number | undefined): Slot | undefined {
    if (index === undefined) return undefined;
    const key = `${parentKey(parent)}:${this.messageId}:${index}`;
    return this.seq.find((s) => s.key === key);
  }

  private uiId(slot: Slot): string {
    return slot.kind === "tool" ? slot.toolId || slot.key : slot.key;
  }

  send(text: string, images: ImageAttachment[]): void {
    const content: Array<Record<string, unknown>> = images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    }));
    content.push({ type: "text", text: text || "Analyse ces images." });
    this.queue.push({
      type: "user",
      message: { role: "user", content } as unknown as SDKUserMessage["message"],
      parent_tool_use_id: null,
    });
    this.emit({ type: "busy", value: true });
  }

  async interrupt(): Promise<void> {
    await this.query?.interrupt().catch(() => undefined);
  }

  async setModel(key: string): Promise<void> {
    this.config.modelKey = key;
    await this.query?.setModel(resolveModel(key));
  }

  async setMode(mode: PermMode): Promise<void> {
    this.config.mode = mode;
    await this.query?.setPermissionMode(mode);
  }

  async setEffort(level: Effort): Promise<void> {
    this.config.effort = level;
    await this.query?.applyFlagSettings({ effortLevel: level });
  }

  dispose(): void {
    this.queue.close();
    try {
      this.query?.close();
    } catch {
      /* déjà fermé */
    }
    this.alive = false;
  }
}

function toSlash(cmd: { name: string; description: string; argumentHint?: string }): SlashItem {
  return { name: cmd.name, description: cmd.description || "", argumentHint: cmd.argumentHint || "" };
}

function parentKey(parent: string | null): string {
  return parent ?? "main";
}

function meterId(parent: string | null): string {
  return `think-meter:${parentKey(parent)}`;
}

function blockKind(type: string | undefined): "text" | "thinking" | "tool" | "other" {
  if (type === "text") return "text";
  if (type === "thinking" || type === "redacted_thinking") return "thinking";
  if (type === "tool_use") return "tool";
  return "other";
}

function clip(text: string, max = CLIP): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n… (tronqué)";
}

function clipRecord(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = typeof value === "string" ? clip(value) : value;
  }
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function liveInput(buf: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(buf) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* JSON encore incomplet */
  }
  const out: Record<string, unknown> = {};
  const re = /"(command|file_path|notebook_path|path|pattern|query|url|description|content|old_string|new_string|new_source)"\s*:\s*"((?:\\.|[^"\\])*)/g;
  let match: RegExpExecArray | null;
  let any = false;
  while ((match = re.exec(buf))) {
    try {
      out[match[1]] = JSON.parse(`"${match[2]}"`) as string;
      any = true;
    } catch {
      /* fragment pas encore une chaîne valide */
    }
  }
  return any ? out : undefined;
}

function normalizeQuestions(value: unknown): QuestionModel[] {
  if (!Array.isArray(value)) return [];
  const questions: QuestionModel[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const question = str(item.question);
    if (!question) continue;
    const options: QuestionOption[] = [];
    if (Array.isArray(item.options)) {
      for (const opt of item.options) {
        if (!opt || typeof opt !== "object") continue;
        const row = opt as Record<string, unknown>;
        const label = str(row.label);
        if (!label) continue;
        options.push({
          label,
          description: typeof row.description === "string" ? row.description : "",
          preview: typeof row.preview === "string" ? row.preview : undefined,
        });
      }
    }
    questions.push({
      question,
      header: typeof item.header === "string" ? item.header : "",
      multiSelect: item.multiSelect === true,
      options,
    });
  }
  return questions;
}

function planBody(input: Record<string, unknown>, description?: string): string {
  const named = firstString(input, ["plan", "planText", "approvedPlan"]);
  if (named) return named;
  let best = description ?? "";
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length > best.length) best = value;
  }
  return best;
}

function defaultTitle(tool: string): string {
  if (tool === "Bash" || tool === "PowerShell") return "L'agent veut exécuter une commande";
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") return "L'agent veut modifier un fichier";
  if (tool === "ExitPlanMode") return "L'agent propose de sortir du mode plan";
  if (tool === "Agent" || tool === "Task") return "L'agent veut lancer un sous-agent";
  return `L'agent veut utiliser ${tool}`;
}

function buildSheet(id: string, tool: string, input: Record<string, unknown>, options: ToolOpts): SheetModel {
  if (tool === "ExitPlanMode") {
    return {
      id,
      kind: "plan",
      title: options.title || defaultTitle(tool),
      body: planBody(input, options.description),
    };
  }
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  const mono = str(input.command) || str(input.url);
  let diff: DiffModel | undefined;
  if (typeof input.old_string === "string" || typeof input.new_string === "string") {
    if (tool === "Edit" || tool === "NotebookEdit" || "old_string" in input) {
      diff = {
        old: clip(String(input.old_string ?? ""), 12_000),
        new: clip(String(input.new_string ?? input.new_source ?? ""), 12_000),
      };
    }
  }
  const rawWrite = !diff ? str(input.content) || str(input.new_source) : undefined;
  const write = rawWrite ? clip(rawWrite, 12_000) : undefined;
  const shownMono = mono ? clip(mono, 8_000) : undefined;
  const detail = shownMono || file || diff || write ? undefined : clip(JSON.stringify(input), 2000);
  return {
    id,
    kind: "permission",
    tool,
    title: options.title || defaultTitle(tool),
    description: options.description,
    mono: shownMono,
    file,
    diff,
    write,
    detail,
    canAlways: options.suppressAlwaysAllowRule !== true,
  };
}

function permissionsFor(
  toolName: string,
  input: Record<string, unknown>,
  suggestions: PermissionUpdate[] | undefined,
): PermissionUpdate[] {
  if (suggestions && suggestions.length > 0) return suggestions;
  const command = str(input.command);
  const file = str(input.file_path) || str(input.notebook_path);
  return [{
    type: "addRules",
    behavior: "allow",
    destination: "session",
    rules: [{ toolName, ruleContent: command || file }],
  }];
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatToolOutput(content: unknown, structured: unknown): string {
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const row = structured as Record<string, unknown>;
    if (typeof row.stdout === "string" || typeof row.stderr === "string") {
      const parts: string[] = [];
      if (typeof row.stdout === "string" && row.stdout) parts.push(row.stdout);
      if (typeof row.stderr === "string" && row.stderr) parts.push(row.stderr);
      if (row.exitCode !== undefined && row.exitCode !== null) parts.push(`exit ${String(row.exitCode)}`);
      if (parts.length) return parts.join("\n").replace(/\n+$/, "");
    }
  }
  return contentToText(content);
}

const MAX_HUNK_LINES = 600;

function editOf(structured: unknown): { info: EditInfo; before: string | null } | undefined {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const row = structured as Record<string, unknown>;
  if (typeof row.filePath !== "string" || !Array.isArray(row.structuredPatch)) return undefined;
  const hunks: EditHunk[] = [];
  let added = 0;
  let removed = 0;
  let budget = MAX_HUNK_LINES;
  for (const raw of row.structuredPatch) {
    if (!raw || typeof raw !== "object") continue;
    const hunk = raw as { oldStart?: unknown; newStart?: unknown; lines?: unknown };
    const lines = Array.isArray(hunk.lines) ? hunk.lines.filter((line): line is string => typeof line === "string") : [];
    for (const line of lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
    if (budget <= 0) continue;
    hunks.push({ oldStart: Number(hunk.oldStart) || 1, newStart: Number(hunk.newStart) || 1, lines: lines.slice(0, budget) });
    budget -= lines.length;
  }
  const kind = row.type === "create" ? "create" : "update";
  if (kind === "create" && !hunks.length && typeof row.content === "string") {
    const lines = row.content.split("\n");
    added = lines.length;
    hunks.push({ oldStart: 0, newStart: 1, lines: lines.slice(0, MAX_HUNK_LINES).map((line) => `+${line}`) });
  }
  return {
    info: { file: row.filePath, kind, hunks, added, removed },
    before: typeof row.originalFile === "string" ? row.originalFile : kind === "create" ? "" : null,
  };
}

function formatError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/Native CLI binary .* not found/i.test(text)) {
    return (
      "Binaire Claude introuvable pour cette plateforme. Réinstalle l'extension construite " +
      "sur ta machine, ou renseigne le réglage agentDev.claudePath."
    );
  }
  if (/401|authentication|invalid x-api-key/i.test(text)) {
    return "Clé API refusée. Redéfinis-la avec « Clé API » dans le panneau.";
  }
  return text;
}
