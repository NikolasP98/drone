import type { DroneStreamEvent, DroneUsage } from "../types.js";

export type FlightStatus =
  | "idle"
  | "thinking"
  | "tool"
  | "approval"
  | "done"
  | "error";

export type TranscriptRole = "user" | "assistant" | "system";

export type TranscriptEntry = {
  id: string;
  role: TranscriptRole;
  content: string;
  createdAt: number;
  streaming?: boolean;
};

export type ActivityEntry = {
  id: string;
  label: string;
  detail?: string;
  tone: "muted" | "active" | "success" | "error";
  createdAt: number;
};

export type DroneTuiState = {
  status: FlightStatus;
  transcript: TranscriptEntry[];
  activity: ActivityEntry[];
  thinking: string;
  activeAssistantId?: string;
  usage: DroneUsage;
  durationMs?: number;
  resolvedModel?: { provider: string; model: string };
  error?: string;
};

export function createInitialTuiState(now = Date.now()): DroneTuiState {
  return {
    status: "idle",
    transcript: [
      {
        id: "welcome",
        role: "system",
        content:
          "**Drone online.** I can inspect this workspace and request approval before writing files or running shell commands. Type `/help` for controls.",
        createdAt: now,
      },
    ],
    activity: [],
    thinking: "",
    usage: {},
  };
}

export function addUserTurn(
  state: DroneTuiState,
  content: string,
  id: string,
  now = Date.now(),
): DroneTuiState {
  const assistantId = `${id}-assistant`;
  return {
    ...state,
    status: "thinking",
    thinking: "",
    error: undefined,
    activeAssistantId: assistantId,
    transcript: [
      ...state.transcript,
      { id, role: "user", content, createdAt: now },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: now,
        streaming: true,
      },
    ],
    activity: [
      ...state.activity,
      {
        id: `${id}-flight`,
        label: "Flight started",
        detail: content.length > 42 ? `${content.slice(0, 39)}…` : content,
        tone: "active" as const,
        createdAt: now,
      },
    ].slice(-12),
  };
}

function updateAssistant(
  transcript: TranscriptEntry[],
  id: string | undefined,
  update: (entry: TranscriptEntry) => TranscriptEntry,
): TranscriptEntry[] {
  if (!id) return transcript;
  return transcript.map((entry) => (entry.id === id ? update(entry) : entry));
}

export function reduceStreamEvent(
  state: DroneTuiState,
  event: DroneStreamEvent,
  now = Date.now(),
): DroneTuiState {
  if (event.type === "text") {
    return {
      ...state,
      status: "thinking",
      transcript: updateAssistant(state.transcript, state.activeAssistantId, (entry) => ({
        ...entry,
        content: entry.content + event.delta,
      })),
    };
  }

  if (event.type === "thinking") {
    return { ...state, status: "thinking", thinking: state.thinking + event.delta };
  }

  if (event.type === "tool") {
    const starting = event.phase === "start";
    return {
      ...state,
      status: starting ? "tool" : "thinking",
      activity: [
        ...state.activity,
        {
          id: `${event.toolCallId}-${event.phase}`,
          label: `${starting ? "Running" : event.isError ? "Failed" : "Finished"} ${event.name}`,
          tone: (starting ? "active" : event.isError ? "error" : "success") as ActivityEntry["tone"],
          createdAt: now,
        },
      ].slice(-12),
    };
  }

  if (event.type === "done") {
    return {
      ...state,
      status: "done",
      thinking: "",
      usage: event.usage,
      durationMs: event.durationMs,
      resolvedModel: event.resolvedModel,
      transcript: updateAssistant(state.transcript, state.activeAssistantId, (entry) => ({
        ...entry,
        content: event.data || entry.content,
        streaming: false,
      })),
      activity: [
        ...state.activity,
        {
          id: `done-${now}`,
          label: "Flight complete",
          detail: `${event.durationMs}ms`,
          tone: "success" as const,
          createdAt: now,
        },
      ].slice(-12),
    };
  }

  return {
    ...state,
    status: "error",
    thinking: "",
    error: event.error.message,
    durationMs: event.durationMs,
    transcript: updateAssistant(state.transcript, state.activeAssistantId, (entry) => ({
      ...entry,
      content: entry.content || `**${event.error.code}** — ${event.error.message}`,
      streaming: false,
    })),
    activity: [
      ...state.activity,
      {
        id: `error-${now}`,
        label: event.error.code,
        detail: event.error.message,
        tone: "error" as const,
        createdAt: now,
      },
    ].slice(-12),
  };
}

export function clearConversation(state: DroneTuiState, now = Date.now()): DroneTuiState {
  const initial = createInitialTuiState(now);
  return { ...initial, activity: state.activity.slice(-3) };
}

export function restoreConversation(
  transcript: readonly TranscriptEntry[],
  now = Date.now(),
): DroneTuiState {
  const initial = createInitialTuiState(now);
  if (transcript.length === 0) return initial;
  return {
    ...initial,
    transcript: transcript.map((entry) => ({ ...entry, streaming: false })),
  };
}
