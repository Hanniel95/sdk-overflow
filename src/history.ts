import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { UiEvent } from "./session";

const CLIP = 20_000;

/** Les 200 derniers messages du transcript, sous la forme déjà comprise par le panneau. */
export function historyEvents(messages: SessionMessage[]): UiEvent[] {
  const events: UiEvent[] = [];
  for (const msg of messages) {
    if (msg.type === "system") continue;
    const message = asRecord(msg.message);
    const content = message?.content;
    const sub = Boolean(msg.parent_tool_use_id);
    if (msg.type === "user") {
      events.push(...userEvents(content));
      continue;
    }
    if (!Array.isArray(content)) continue;
    content.forEach((block, index) => {
      const item = asRecord(block);
      if (!item) return;
      if (item.type === "text" || item.type === "thinking") {
        const text = textOf(item).trim();
        if (!text) return;
        events.push({
          type: "block",
          block: {
            id: `${msg.uuid}:${index}`,
            kind: item.type === "thinking" ? "thinking" : "text",
            text,
            streaming: false,
            parent: msg.parent_tool_use_id || undefined,
            sub,
          },
        });
        return;
      }
      if (item.type !== "tool_use") return;
      const id = typeof item.id === "string" && item.id ? item.id : `${msg.uuid}:${index}`;
      events.push({
        type: "block",
        block: {
          id,
          kind: "tool",
          name: typeof item.name === "string" ? item.name : "Outil",
          input: asRecord(item.input) ?? {},
          streaming: false,
          running: false,
          parent: msg.parent_tool_use_id || undefined,
          sub,
        },
      });
    });
  }
  return events;
}

function userEvents(content: unknown): UiEvent[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "user", text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const events: UiEvent[] = [];
  const texts: string[] = [];
  let sawImage = false;
  const flush = () => {
    const text = texts.join("\n").trim();
    texts.length = 0;
    if (text) events.push({ type: "user", text });
  };
  for (const block of content) {
    const item = asRecord(block);
    if (!item) continue;
    if (item.type === "text" && typeof item.text === "string") {
      texts.push(item.text);
      continue;
    }
    if (item.type === "image") {
      sawImage = true;
      continue;
    }
    flush();
    if (item.type === "tool_result" && typeof item.tool_use_id === "string" && item.tool_use_id) {
      events.push({
        type: "toolResult",
        id: item.tool_use_id,
        output: clip(flatten(item.content)),
        isError: Boolean(item.is_error),
      });
    }
  }
  flush();
  if (!events.length && sawImage) events.push({ type: "user", text: "(image)" });
  return events;
}

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const rec = asRecord(part);
      return rec && typeof rec.text === "string" ? rec.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function textOf(block: Record<string, unknown>): string {
  if (typeof block.text === "string") return block.text;
  if (typeof block.thinking === "string") return block.thinking;
  return "";
}

function clip(text: string): string {
  if (text.length <= CLIP) return text;
  return `${text.slice(0, CLIP)}\n… [sortie tronquée]`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
