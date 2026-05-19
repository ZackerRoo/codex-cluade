export interface ClaudeTranscriptSummary {
  sessionId?: string;
  cwd?: string;
  permissionMode?: string;
  models: string[];
  toolCalls: Array<{
    id?: string;
    name: string;
    timestamp?: string;
    input?: unknown;
    isError?: boolean;
  }>;
  fileWrites: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  timeline: Array<{
    timestamp?: string;
    type: string;
    summary: string;
  }>;
}

export function parseClaudeTranscript(content: string): ClaudeTranscriptSummary {
  const summary: ClaudeTranscriptSummary = {
    models: [],
    toolCalls: [],
    fileWrites: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0
    },
    timeline: []
  };
  const toolCallsById = new Map<string, ClaudeTranscriptSummary["toolCalls"][number]>();

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const item = parseLine(line);
    if (!item) continue;
    if (!summary.sessionId && typeof item.sessionId === "string") summary.sessionId = item.sessionId;
    if (!summary.cwd && typeof item.cwd === "string") summary.cwd = item.cwd;
    if (!summary.permissionMode && typeof item.permissionMode === "string") summary.permissionMode = item.permissionMode;

    const timestamp = typeof item.timestamp === "string" ? item.timestamp : undefined;
    const message = isRecord(item.message) ? item.message : undefined;
    if (message && typeof message.model === "string") addUnique(summary.models, message.model);
    if (message && isRecord(message.usage)) {
      summary.usage.inputTokens += numberValue(message.usage.input_tokens);
      summary.usage.outputTokens += numberValue(message.usage.output_tokens);
    }

    const contentItems = Array.isArray(message?.content) ? message.content : [];
    for (const contentItem of contentItems) {
      if (!isRecord(contentItem) || typeof contentItem.type !== "string") continue;
      if (contentItem.type === "tool_use" && typeof contentItem.name === "string") {
        const toolCall = {
          id: typeof contentItem.id === "string" ? contentItem.id : undefined,
          name: contentItem.name,
          timestamp,
          input: contentItem.input
        };
        summary.toolCalls.push(toolCall);
        if (toolCall.id) toolCallsById.set(toolCall.id, toolCall);
        const filePath = extractFilePath(contentItem.input);
        if (filePath) addUnique(summary.fileWrites, filePath);
        summary.timeline.push({ timestamp, type: "tool_use", summary: `${contentItem.name}${filePath ? ` ${filePath}` : ""}` });
      } else if (contentItem.type === "tool_result") {
        const toolUseId = typeof contentItem.tool_use_id === "string" ? contentItem.tool_use_id : undefined;
        const isError = contentItem.is_error === true;
        if (toolUseId) {
          const toolCall = toolCallsById.get(toolUseId);
          if (toolCall) toolCall.isError = isError;
        }
        summary.timeline.push({ timestamp, type: "tool_result", summary: isError ? "tool result error" : "tool result ok" });
      } else if (contentItem.type === "text" && typeof contentItem.text === "string") {
        summary.timeline.push({ timestamp, type: "text", summary: contentItem.text.slice(0, 160) });
      }
    }

    if (contentItems.length === 0 && typeof item.type === "string") {
      summary.timeline.push({ timestamp, type: item.type, summary: item.type });
    }
  }

  return summary;
}

function extractFilePath(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input.file_path ?? input.path;
  return typeof value === "string" ? value : undefined;
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
