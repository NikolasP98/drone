import {
  BoxRenderable,
  CliRenderEvents,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
  defaultTextareaKeyBindings,
  type CliRenderer,
  type KeyEvent,
  type Selection,
} from "@opentui/core";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { basename } from "node:path";
import { defineDrone } from "../define.js";
import { runDroneStream } from "../stream.js";
import type { DroneConfig } from "../config.js";
import {
  createEnvironmentHost,
  createWorkspaceTools,
  type WorkspaceApprovalRequest,
} from "../runtime/workspace.js";
import type { Drone, DroneStreamEvent } from "../types.js";
import {
  approvalDecisionForKey,
  formatApprovalPreview,
} from "./approval.js";
import { renderDroneArt } from "./art.js";
import {
  acceptCompletion,
  findCompletionContext,
  getCompletions,
  moveCompletionSelection,
  SLASH_COMMANDS,
  type CompletionModel,
} from "./completions.js";
import { resolvePathSearchScope, type PathSearchScope } from "./path-scope.js";
import {
  addUserTurn,
  clearConversation,
  createInitialTuiState,
  reduceStreamEvent,
  type DroneTuiState,
  type TranscriptEntry,
} from "./state.js";
import { resolvePalette, type DronePalette } from "./theme.js";
import {
  discoverWorkspaceReferences,
  discoverWorkspaceSkills,
  MAX_ACTIVE_SKILLS,
  renderActiveSkills,
  type WorkspaceReference,
  type WorkspaceSkill,
} from "./workspace-sources.js";

export type DroneTuiOptions = {
  cwd: string;
  config: DroneConfig;
  configDiagnostics?: string[];
  initialPrompt?: string;
};

type ApprovalDecision = {
  request: WorkspaceApprovalRequest;
  resolve: (approved: boolean) => void;
  timeout?: NodeJS.Timeout;
};

type MessageView = {
  box: BoxRenderable;
  label: TextRenderable;
  body: MarkdownRenderable;
};

const HELP = [
  "DRONE FLIGHT CONTROLS",
  "",
  "Enter            submit prompt",
  "Alt+Enter/Ctrl+J add a new line",
  "Esc              cancel active flight / close panel",
  "Ctrl+C           cancel active flight, then exit",
  "PgUp / PgDn      scroll transcript",
  "Tab              move focus",
  "Up/Down          navigate completion menus",
  "Enter/Tab         accept a completion",
  "",
  "Type / for commands or @ for workspace files and directories.",
  `Commands: ${SLASH_COMMANDS.slice(0, 4).map((command) => command.usage).join("  ")}`,
  `          ${SLASH_COMMANDS.slice(4).map((command) => command.usage).join("  ")}`,
  "",
  "Mouse: scroll the transcript, select to copy, or click footer actions.",
].join("\n");

const TUI_TERMINATION_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGINT: 130,
  SIGHUP: 129,
  SIGTERM: 143,
};

/** Signals a failure after the full-screen session began, so the CLI must not replay its prompt. */
export class DroneTuiSessionError extends Error {
  readonly exitCode: number;
  readonly signal?: NodeJS.Signals;

  constructor(message: string, options: { cause?: unknown; signal?: NodeJS.Signals } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DroneTuiSessionError";
    this.signal = options.signal;
    this.exitCode = options.signal ? (TUI_TERMINATION_EXIT_CODES[options.signal] ?? 1) : 1;
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function isBusy(state: DroneTuiState): boolean {
  return state.status === "thinking" || state.status === "tool" || state.status === "approval";
}

function assistantHistory(state: DroneTuiState, prompt: string): string {
  const history = state.transcript
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .filter((entry) => entry.content.trim().length > 0)
    .slice(-10)
    .map((entry) => `${entry.role.toUpperCase()}: ${entry.content}`)
    .join("\n\n");
  if (!history) return prompt;
  return `Conversation so far:\n\n${history}\n\nCURRENT USER REQUEST:\n${prompt}`;
}

function statusColor(status: DroneTuiState["status"], palette: DronePalette): string {
  if (status === "error") return palette.error;
  if (status === "done") return palette.success;
  if (status === "approval") return palette.warning;
  if (status === "thinking" || status === "tool") return palette.accent;
  return palette.muted;
}

function addText(
  ctx: CliRenderer,
  parent: BoxRenderable,
  id: string,
  content: string,
  options: {
    fg: string;
    width?: number | `${number}%`;
    flexGrow?: number;
    wrapMode?: "none" | "word";
  },
): TextRenderable {
  const text = new TextRenderable(ctx, {
    id,
    content,
    fg: options.fg,
    width: options.width ?? "100%",
    flexGrow: options.flexGrow,
    wrapMode: options.wrapMode ?? "word",
  });
  parent.add(text);
  return text;
}

function removeChildren(parent: BoxRenderable | ScrollBoxRenderable): void {
  for (const child of parent.getChildren()) {
    parent.remove(child);
    child.destroyRecursively();
  }
}

export async function runDroneTui(options: DroneTuiOptions): Promise<void> {
  const workspaceRoot = path.resolve(options.cwd);
  const sourceDiscovery = Promise.all([
    discoverWorkspaceReferences(options.cwd, { maxDepth: 32, maxEntries: 10_000 }),
    discoverWorkspaceSkills(options.cwd),
  ]);
  let config = structuredClone(options.config);
  const mouseEnabled = config.ui.mouse !== "off";
  const renderer = await createCliRenderer({
    screenMode: config.ui.screen === "split" ? "split-footer" : "alternate-screen",
    footerHeight: config.ui.screen === "split" ? 16 : undefined,
    targetFps: 30,
    maxFps: 60,
    useMouse: mouseEnabled,
    enableMouseMovement: mouseEnabled && config.ui.mouseClicks,
    autoFocus: true,
    exitOnCtrlC: false,
    openConsoleOnError: false,
  });
  let rendererStarted = false;
  let shutdownRequested = false;
  let rendererStoppedUnexpectedly = false;
  let terminationSignal: NodeJS.Signals | undefined;
  let syntaxStyle: SyntaxStyle | undefined;
  let lifecycleCleanup: (() => void) | undefined;
  const terminationHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"] as const) {
    const handler = (): void => {
      terminationSignal = signal;
      if (!renderer.isDestroyed) renderer.destroy();
    };
    terminationHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    renderer.setTerminalTitle(`drone · ${basename(options.cwd) || options.cwd}`);

    const terminalTheme = await renderer.waitForThemeMode(120).catch(() => null);
    if (terminationSignal) {
      throw new DroneTuiSessionError(`Drone TUI terminated by ${terminationSignal}.`, {
        signal: terminationSignal,
      });
    }
    if (renderer.isDestroyed) {
      throw new Error("Drone renderer stopped during startup");
    }
    let palette = resolvePalette(
      config.ui.theme,
      terminalTheme,
      process.env.NO_COLOR != null || process.env.DRONE_NO_COLOR === "1",
    );
    renderer.setBackgroundColor(palette.background);

    const activeSyntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: palette.text },
      "markup.heading": { fg: palette.accent, bold: true },
      "markup.bold": { fg: palette.text, bold: true },
      "markup.italic": { fg: palette.text, italic: true },
      "markup.link": { fg: palette.user, underline: true },
      "markup.raw": { fg: palette.success },
      comment: { fg: palette.muted, italic: true },
      keyword: { fg: palette.accent },
      string: { fg: palette.success },
    });
    syntaxStyle = activeSyntaxStyle;

  let state = createInitialTuiState();
  let frame = 0;
  let frameElapsed = 0;
  let animationLive = false;
  let activeAbort: AbortController | undefined;
  let activeDeadlineAt: number | undefined;
  let pendingApproval: ApprovalDecision | undefined;
  let panel: "help" | "config" | undefined;
  let finished = false;
  let workspaceReferences: WorkspaceReference[] = [];
  const referenceIndexes = new Map<
    string,
    { references: WorkspaceReference[]; recursive: boolean }
  >();
  const loadingReferenceIndexes = new Set<string>();
  let activePathScope: PathSearchScope | undefined;
  let completionSourceLoading = false;
  let workspaceSourceGeneration = 0;
  let workspaceSkills: WorkspaceSkill[] = [];
  const activeSkillNames = new Set<string>();
  let completion: CompletionModel | undefined;
  let completionDismissedSignature: string | undefined;
  let completionScrollOffset = 0;
  let suppressCompletionHoverUntil = 0;

  const root = new BoxRenderable(renderer, {
    id: "drone-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: palette.background,
  });
  renderer.root.add(root);

  const header = new BoxRenderable(renderer, {
    id: "header",
    width: "100%",
    height: 7,
    flexDirection: "row",
    border: ["bottom"],
    borderColor: palette.border,
    paddingX: 1,
    backgroundColor: palette.surface,
  });
  root.add(header);
  const art = addText(renderer, header, "art", "", { fg: palette.accent, width: 23 });
  const headerCopy = new BoxRenderable(renderer, {
    id: "header-copy",
    flexGrow: 1,
    height: "100%",
    flexDirection: "column",
    justifyContent: "center",
    paddingLeft: 1,
  });
  header.add(headerCopy);
  const title = addText(renderer, headerCopy, "title", "MINION / DRONE", {
    fg: palette.accent,
  });
  const meta = addText(renderer, headerCopy, "meta", "", { fg: palette.text });
  const submeta = addText(renderer, headerCopy, "submeta", "", { fg: palette.muted });

  const main = new BoxRenderable(renderer, {
    id: "main",
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
    backgroundColor: palette.background,
  });
  root.add(main);
  const transcript = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    flexGrow: 1,
    height: "100%",
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
    paddingX: 1,
    paddingY: 1,
    backgroundColor: palette.background,
    viewportCulling: true,
  });
  main.add(transcript);

  const inspector = new BoxRenderable(renderer, {
    id: "inspector",
    width: 32,
    height: "100%",
    flexDirection: "column",
    border: ["left"],
    borderColor: palette.border,
    padding: 1,
    backgroundColor: palette.surface,
  });
  main.add(inspector);
  const inspectorTitle = addText(renderer, inspector, "inspector-title", "FLIGHT LOG", {
    fg: palette.accent,
  });
  const inspectorStats = addText(renderer, inspector, "inspector-stats", "", {
    fg: palette.muted,
  });
  const inspectorActivity = addText(renderer, inspector, "inspector-activity", "", {
    fg: palette.text,
    flexGrow: 1,
  });
  const thinking = addText(renderer, inspector, "thinking", "", {
    fg: palette.muted,
  });

  const completionBox = new BoxRenderable(renderer, {
    id: "completion-menu",
    width: "100%",
    height: 3,
    visible: false,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: palette.borderFocus,
    title: " INTELLISENSE ",
    titleColor: palette.accent,
    paddingX: 1,
    backgroundColor: palette.surface,
    onMouseScroll: (event) => {
      if (!completion || !event.scroll) return;
      const direction =
        event.scroll.direction === "down" ? 1 : event.scroll.direction === "up" ? -1 : 0;
      if (direction === 0) return;
      suppressCompletionHoverUntil = Date.now() + 120;
      moveCompletion(direction * Math.max(1, Math.round(event.scroll.delta)));
      event.preventDefault();
      event.stopPropagation();
    },
  });
  root.add(completionBox);

  const composerBox = new BoxRenderable(renderer, {
    id: "composer-box",
    width: "100%",
    height: 5,
    border: true,
    borderColor: palette.borderFocus,
    focusedBorderColor: palette.accent,
    title: " COMMAND DECK ",
    titleColor: palette.accent,
    paddingX: 1,
    backgroundColor: palette.surfaceRaised,
    onMouseDown: () => {
      if (config.ui.mouseClicks) {
        composer.focus();
        queueMicrotask(refreshCompletion);
      }
    },
  });
  root.add(composerBox);
  const composer = new TextareaRenderable(renderer, {
    id: "composer",
    width: "100%",
    height: "100%",
    placeholder: "Ask Drone to inspect, explain, or change this workspace…",
    placeholderColor: palette.muted,
    textColor: palette.text,
    backgroundColor: palette.surfaceRaised,
    focusedTextColor: palette.text,
    focusedBackgroundColor: palette.surfaceRaised,
    cursorColor: palette.accent,
    wrapMode: "word",
    onMouseDown: () => {
      if (config.ui.mouseClicks) queueMicrotask(refreshCompletion);
    },
    keyBindings: [
      ...defaultTextareaKeyBindings.filter(
        (binding) =>
          !(
            (binding.name === "return" || binding.name === "kpenter") &&
            (binding.action === "newline" || binding.action === "submit")
          ),
      ),
      { name: "return", action: "submit" },
      { name: "kpenter", action: "submit" },
      { name: "return", meta: true, action: "newline" },
      { name: "kpenter", meta: true, action: "newline" },
    ],
    onSubmit: () => {
      const value = composer.plainText.trim();
      if (!value) return;
      composer.clear();
      void submit(value);
    },
  });
  composerBox.add(composer);
  composer.onContentChange = () => refreshCompletion();
  composer.onCursorChange = () => refreshCompletion();

  const footer = new BoxRenderable(renderer, {
    id: "footer",
    width: "100%",
    height: 2,
    flexDirection: "row",
    alignItems: "center",
    paddingX: 1,
    gap: 1,
    backgroundColor: palette.surface,
  });
  root.add(footer);
  const footerStatus = addText(renderer, footer, "footer-status", "", {
    fg: palette.muted,
    flexGrow: 1,
    wrapMode: "none",
  });

  function button(id: string, label: string, action: () => void): BoxRenderable {
    const box = new BoxRenderable(renderer, {
      id,
      width: label.length + 4,
      height: 1,
      border: false,
      backgroundColor: palette.surfaceRaised,
      onMouseDown: (event) => {
        if (!config.ui.mouseClicks) return;
        event.stopPropagation();
        action();
      },
      onMouseOver() {
        if (!config.ui.mouseClicks) return;
        this.backgroundColor = palette.accentSoft;
      },
      onMouseOut() {
        if (!config.ui.mouseClicks) return;
        this.backgroundColor = palette.surfaceRaised;
      },
    });
    addText(renderer, box, `${id}-label`, ` ${label} `, { fg: palette.text });
    footer.add(box);
    return box;
  }
  button("help-button", "? Help", () => togglePanel("help"));
  button("config-button", "⚙ Config", () => togglePanel("config"));
  button("clear-button", "Clear", () => clearAll());
  button("quit-button", "Quit", () => finish());

  const modal = new BoxRenderable(renderer, {
    id: "modal",
    position: "absolute",
    width: 66,
    maxWidth: "90%",
    height: 19,
    maxHeight: "85%",
    top: "10%",
    left: "20%",
    zIndex: 50,
    visible: false,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: palette.accent,
    padding: 1,
    backgroundColor: palette.surfaceRaised,
  });
  root.add(modal);
  const modalTitle = addText(renderer, modal, "modal-title", "", { fg: palette.accent });
  const modalBody = addText(renderer, modal, "modal-body", "", {
    fg: palette.text,
    flexGrow: 1,
  });
  const modalHint = addText(renderer, modal, "modal-hint", "", { fg: palette.muted });

  const approvalModal = new BoxRenderable(renderer, {
    id: "approval-modal",
    position: "absolute",
    width: 72,
    maxWidth: "92%",
    height: 12,
    top: "28%",
    left: "18%",
    zIndex: 100,
    visible: false,
    flexDirection: "column",
    border: true,
    borderStyle: "double",
    borderColor: palette.warning,
    padding: 1,
    backgroundColor: palette.surfaceRaised,
  });
  root.add(approvalModal);
  const approvalTitle = addText(
    renderer,
    approvalModal,
    "approval-title",
    "APPROVAL REQUIRED · ↑/↓ REVIEW",
    { fg: palette.warning },
  );
  const approvalBodyViewport = new ScrollBoxRenderable(renderer, {
    id: "approval-body-viewport",
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    viewportCulling: true,
    backgroundColor: palette.surfaceRaised,
  });
  approvalModal.add(approvalBodyViewport);
  const approvalBody = addText(renderer, approvalBodyViewport, "approval-body", "", {
    fg: palette.text,
  });
  const approvalActions = new BoxRenderable(renderer, {
    id: "approval-actions",
    width: "100%",
    height: 2,
    flexDirection: "row",
    gap: 2,
  });
  approvalModal.add(approvalActions);
  function approvalButton(label: string, approved: boolean): void {
    const control = new BoxRenderable(renderer, {
      id: `approval-${approved ? "allow" : "deny"}`,
      width: label.length + 4,
      height: 1,
      backgroundColor: approved ? palette.accentSoft : palette.surface,
      onMouseDown: (event) => {
        if (!config.ui.mouseClicks) return;
        event.stopPropagation();
        decideApproval(approved);
      },
    });
    addText(renderer, control, `${control.id}-label`, ` ${label} `, {
      fg: approved ? palette.text : palette.error,
    });
    approvalActions.add(control);
  }
  approvalButton("Allow once [Y]", true);
  approvalButton("Deny [N/Esc/Enter]", false);

  const messageViews = new Map<string, MessageView>();

  function createMessageView(entry: TranscriptEntry): MessageView {
    const tone =
      entry.role === "user"
        ? palette.user
        : entry.role === "assistant"
          ? palette.assistant
          : palette.muted;
    const box = new BoxRenderable(renderer, {
      id: `message-${entry.id}`,
      width: "100%",
      height: "auto",
      flexDirection: "column",
      marginBottom: 1,
      paddingX: 1,
      border: entry.role === "user" ? ["left"] : false,
      borderColor: tone,
    });
    const label = new TextRenderable(renderer, {
      id: `message-${entry.id}-label`,
      content: entry.role === "assistant" ? "DRONE" : entry.role.toUpperCase(),
      fg: tone,
      width: "100%",
      height: 1,
    });
    const body = new MarkdownRenderable(renderer, {
      id: `message-${entry.id}-body`,
      content: entry.content || " ",
      syntaxStyle: activeSyntaxStyle,
      fg: tone,
      width: "100%",
      height: "auto",
      streaming: entry.streaming ?? false,
      conceal: true,
      internalBlockMode: "top-level",
    });
    box.add(label);
    box.add(body);
    transcript.add(box);
    return { box, label, body };
  }

  function syncMessages(): void {
    const liveIds = new Set(state.transcript.map((entry) => entry.id));
    for (const [id, view] of messageViews) {
      if (!liveIds.has(id)) {
        transcript.remove(view.box);
        view.box.destroyRecursively();
        messageViews.delete(id);
      }
    }
    for (const entry of state.transcript) {
      const existing = messageViews.get(entry.id);
      if (!existing) {
        messageViews.set(entry.id, createMessageView(entry));
      } else {
        existing.body.content = entry.content || " ";
        existing.body.streaming = entry.streaming ?? false;
      }
    }
  }

  function completionSignature(prompt = composer.plainText, caret = composer.cursorOffset): string {
    return `${caret}\u0000${prompt}`;
  }

  function visibleCompletionRows(): number {
    return renderer.height < 22 || config.ui.screen === "split" ? 4 : 6;
  }

  function completionResultLimit(): number {
    return Math.max(100, workspaceReferences.length, workspaceSkills.length);
  }

  function skillCompletionInputs(): Array<{ name: string; description: string }> {
    return workspaceSkills.map((skill) => ({
      name: skill.name,
      description: `${activeSkillNames.has(skill.name) ? "active · " : ""}${skill.scope} · ${skill.description}`,
    }));
  }

  function renderCompletionMenu(): void {
    removeChildren(completionBox);
    if (!completion) {
      completionBox.visible = false;
      completionScrollOffset = 0;
      return;
    }

    const visibleRows = visibleCompletionRows();
    const maxOffset = Math.max(0, completion.items.length - visibleRows);
    completionScrollOffset = Math.max(0, Math.min(completionScrollOffset, maxOffset));
    if (completion.selectedIndex >= 0) {
      if (completion.selectedIndex < completionScrollOffset) {
        completionScrollOffset = completion.selectedIndex;
      } else if (completion.selectedIndex >= completionScrollOffset + visibleRows) {
        completionScrollOffset = completion.selectedIndex - visibleRows + 1;
      }
    }
    const visibleItems = completion.items.slice(
      completionScrollOffset,
      completionScrollOffset + visibleRows,
    );
    const rangeStart = completion.items.length === 0 ? 0 : completionScrollOffset + 1;
    const rangeEnd = completionScrollOffset + visibleItems.length;

    const pathTitle = activePathScope?.displayPrefix.startsWith("~/")
      ? "HOME"
      : activePathScope?.displayPrefix.startsWith("../")
        ? "PARENT"
        : "WORKSPACE";
    const kindTitle =
      completion.context.kind === "slash"
        ? "COMMANDS"
        : completion.context.kind === "skill"
          ? "SKILLS"
          : completionSourceLoading
            ? `${pathTitle}...`
            : pathTitle;
    completionBox.title = ` ${kindTitle} ${rangeStart}-${rangeEnd}/${completion.items.length} | up/down/wheel `;
    completionBox.visible = true;
    completionBox.height = Math.max(3, visibleItems.length + 2);

    if (completion.items.length === 0) {
      addText(
        renderer,
        completionBox,
        "completion-empty",
        completionSourceLoading ? "  Searching this directory…" : "  No matching options",
        {
          fg: palette.muted,
          wrapMode: "none",
        },
      );
      renderer.requestRender();
      return;
    }

    visibleItems.forEach((item, visibleIndex) => {
      const index = completionScrollOffset + visibleIndex;
      const selected = index === completion?.selectedIndex;
      const row = new BoxRenderable(renderer, {
        id: `completion-${item.id}`,
        width: "100%",
        height: 1,
        flexDirection: "row",
        backgroundColor: selected ? palette.accentSoft : palette.surface,
        onMouseOver: () => {
          if (
            !config.ui.mouseClicks ||
            !completion ||
            completion.selectedIndex === index ||
            Date.now() < suppressCompletionHoverUntil
          ) {
            return;
          }
          completion = { ...completion, selectedIndex: index };
          renderCompletionMenu();
        },
        onMouseDown: (event) => {
          if (!config.ui.mouseClicks) return;
          event.preventDefault();
          event.stopPropagation();
          acceptSelectedCompletion(index);
        },
      });
      const icon = item.kind === "directory" ? "▸" : item.kind === "file" ? "◇" : "◆";
      const suffix = item.description ? `  ${item.description}` : "";
      addText(
        renderer,
        row,
        `completion-${item.id}-label`,
        `${selected ? "›" : " "} ${icon} ${item.label}${suffix}`,
        { fg: selected ? palette.text : palette.muted, wrapMode: "none" },
      ).selectable = false;
      completionBox.add(row);
    });
    renderer.requestRender();
  }

  function ensureReferenceIndex(scope: PathSearchScope): void {
    const recursive = !scope.onlyImmediate;
    const existing = referenceIndexes.get(scope.searchRoot);
    if (existing && (existing.recursive || !recursive)) return;

    const loadKey = `${scope.searchRoot}\u0000${recursive ? "recursive" : "immediate"}`;
    if (loadingReferenceIndexes.has(loadKey)) return;
    loadingReferenceIndexes.add(loadKey);
    const discovery = discoverWorkspaceReferences(scope.searchRoot, {
      maxDepth: recursive ? 32 : 1,
      maxEntries: recursive ? 10_000 : 5_000,
    });
    void discovery
      .then((references) => {
        if (finished) return;
        const latest = referenceIndexes.get(scope.searchRoot);
        if (recursive || !latest?.recursive) {
          referenceIndexes.set(scope.searchRoot, { references, recursive });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        loadingReferenceIndexes.delete(loadKey);
        if (!finished) refreshCompletion();
      });
  }

  function refreshCompletion(): void {
    if (finished || panel || pendingApproval || renderer.currentFocusedRenderable !== composer) {
      completion = undefined;
      renderCompletionMenu();
      return;
    }

    const prompt = composer.plainText;
    const caret = Math.max(0, Math.min(prompt.length, composer.cursorOffset));
    if (completionDismissedSignature === completionSignature(prompt, caret)) {
      completion = undefined;
      renderCompletionMenu();
      return;
    }
    completionDismissedSignature = undefined;

    const rawContext = findCompletionContext(prompt, caret);
    activePathScope =
      rawContext?.kind === "workspace-path"
        ? resolvePathSearchScope({
            cwd: workspaceRoot,
            home: homedir(),
            query: rawContext.query,
          })
        : undefined;
    if (activePathScope) {
      ensureReferenceIndex(activePathScope);
      workspaceReferences = referenceIndexes.get(activePathScope.searchRoot)?.references ?? [];
      completionSourceLoading =
        loadingReferenceIndexes.has(`${activePathScope.searchRoot}\u0000recursive`) ||
        loadingReferenceIndexes.has(`${activePathScope.searchRoot}\u0000immediate`);
    } else {
      workspaceReferences = [];
      completionSourceLoading = false;
    }

    const selectedId = completion?.items[completion.selectedIndex]?.id;
    let next = getCompletions({
      prompt,
      caret,
      workspacePaths: workspaceReferences,
      workspaceQuery: activePathScope?.needle,
      workspaceDisplayPrefix: activePathScope?.displayPrefix,
      workspaceOnlyImmediate: activePathScope?.onlyImmediate,
      skills: skillCompletionInputs(),
      limit: completionResultLimit(),
      selectedIndex: completion?.selectedIndex,
    });
    if (next && selectedId) {
      const retainedIndex = next.items.findIndex((item) => item.id === selectedId);
      next = {
        ...next,
        selectedIndex: retainedIndex >= 0 ? retainedIndex : next.items.length > 0 ? 0 : -1,
      };
    }
    completion = next;
    renderCompletionMenu();
  }

  function dismissCompletion(): void {
    completionDismissedSignature = completionSignature();
    completion = undefined;
    renderCompletionMenu();
  }

  function moveCompletion(delta: number): void {
    if (!completion || completion.items.length === 0) return;
    completion = moveCompletionSelection(completion, delta);
    renderCompletionMenu();
  }

  function pageCompletion(direction: -1 | 1): void {
    if (!completion || completion.items.length === 0) return;
    const pageSize = visibleCompletionRows();
    const current = Math.max(0, completion.selectedIndex);
    const selectedIndex = Math.max(
      0,
      Math.min(completion.items.length - 1, current + direction * pageSize),
    );
    completionScrollOffset = Math.max(
      0,
      Math.min(
        completion.items.length - pageSize,
        completionScrollOffset + direction * pageSize,
      ),
    );
    completion = { ...completion, selectedIndex };
    renderCompletionMenu();
  }

  function acceptSelectedCompletion(index = completion?.selectedIndex ?? -1): void {
    if (!completion) return;
    const selectedItem = completion.items[index] ?? completion.items[completion.selectedIndex];
    const edit = acceptCompletion(completion, index);
    if (!edit) return;

    let prompt = edit.prompt;
    let caret = edit.caret;
    if (selectedItem?.kind !== "directory" && caret === prompt.length && !prompt.endsWith(" ")) {
      prompt += " ";
      caret += 1;
    }

    completion = undefined;
    composer.replaceText(prompt);
    composer.cursorOffset = caret;
    composer.focus();
    refreshCompletion();
  }

  function syncAnimation(): void {
    const shouldAnimate =
      config.ui.motion !== "off" &&
      config.ui.art !== "off" &&
      (state.status === "thinking" || state.status === "tool" || state.status === "approval");
    if (shouldAnimate && !animationLive) {
      animationLive = true;
      renderer.requestLive();
    } else if (!shouldAnimate && animationLive) {
      animationLive = false;
      renderer.dropLive();
    }
  }

  function syncLayout(): void {
    const compact = renderer.width < 100 || renderer.height < 26;
    inspector.visible = !compact;
    header.height = renderer.height < 18 ? 3 : config.ui.art === "full" ? 7 : 4;
    composerBox.height = renderer.height < 18 ? 3 : 5;
    art.width = renderer.width < 70 ? 15 : 23;
    modal.left = renderer.width >= 90 ? "20%" : "5%";
    approvalModal.left = renderer.width >= 90 ? "18%" : "4%";
  }

  function syncView(): void {
    syncLayout();
    syncMessages();
    const artMode =
      renderer.height < 18 || renderer.width < 62
        ? "minimal"
        : renderer.width < 90
          ? "compact"
          : config.ui.art;
    art.content = renderDroneArt(
      state.status,
      frame,
      artMode,
      process.env.TERM === "dumb" || process.env.DRONE_ASCII === "1",
    );
    art.fg = statusColor(state.status, palette);
    title.fg = statusColor(state.status, palette);
    meta.content = `${config.provider}/${config.model}`;
    submeta.content = `cwd  ${options.cwd}`;
    inspectorTitle.content = `FLIGHT LOG · ${state.status.toUpperCase()}`;
    const tokens = (state.usage.inputTokens ?? 0) + (state.usage.outputTokens ?? 0);
    inspectorStats.content = `time ${formatDuration(state.durationMs)}  ·  tokens ${tokens || "—"}\nmouse ${renderer.useMouse ? "on" : "off"}  ·  policy ${config.runtime.requireApproval ? "ask" : "trusted"}`;
    inspectorActivity.content = state.activity
      .slice(-8)
      .map((entry) => {
        const marker =
          entry.tone === "success" ? "✓" : entry.tone === "error" ? "×" : entry.tone === "active" ? "◆" : "·";
        return `${marker} ${entry.label}${entry.detail ? `\n  ${entry.detail}` : ""}`;
      })
      .join("\n\n");
    thinking.content = state.thinking
      ? `THINKING\n${state.thinking.slice(-320)}`
      : state.error
        ? `ERROR\n${state.error.slice(0, 320)}`
        : "";
    footerStatus.content = isBusy(state)
      ? state.status === "approval"
        ? "waiting for your approval"
        : "esc cancels flight"
      : completion
        ? "↑/↓ or wheel scroll · pgup/pgdn jump · enter/tab insert · esc close"
        : "enter sends · type / commands · type @ paths";
    composerBox.borderColor = statusColor(state.status, palette);
    approvalModal.visible = pendingApproval != null;
    modal.visible = panel != null;
    syncAnimation();
    renderer.requestRender();
  }

  function togglePanel(next: "help" | "config"): void {
    panel = panel === next ? undefined : next;
    completion = undefined;
    renderCompletionMenu();
    if (panel === "help") {
      modalTitle.content = "HELP / FLIGHT MANUAL";
      modalBody.content = HELP;
      modalHint.content = "Esc or ? closes";
    } else if (panel === "config") {
      syncConfigPanel();
    }
    syncView();
  }

  function syncConfigPanel(): void {
    modalTitle.content = "CONFIG / CURRENT FLIGHT";
    modalBody.content = [
      `theme              ${config.ui.theme} (edit config, then restart)`,
      `[M] motion         ${config.ui.motion}`,
      `[C] mouse clicks   ${config.ui.mouseClicks ? "on" : "off"}`,
      `[W] writes         ${config.runtime.allowWrites ? "on" : "off"}`,
      `[S] shell          ${config.runtime.allowShell ? "on" : "off"}`,
      "",
      `provider  ${config.provider}`,
      `model     ${config.model}`,
      "",
      "Persistent values: ~/.config/drone/config.json",
      "Workspace values:  .drone/config.json",
    ].join("\n");
    modalHint.content = "M/C change this flight · edit JSON to persist · Esc closes";
  }

  function cycleConfig(key: "motion" | "mouseClicks"): void {
    if (key === "motion") {
      const values: DroneConfig["ui"]["motion"][] = ["full", "reduced", "off"];
      config.ui.motion = values[(values.indexOf(config.ui.motion) + 1) % values.length];
    } else {
      config.ui.mouseClicks = !config.ui.mouseClicks;
    }
    syncConfigPanel();
    syncView();
  }

  function addSystemMessage(content: string): void {
    state = {
      ...state,
      transcript: [
        ...state.transcript,
        { id: randomUUID(), role: "system", content, createdAt: Date.now() },
      ],
    };
    syncView();
  }

  function clearAll(): void {
    if (isBusy(state)) return;
    state = clearConversation(state);
    syncView();
  }

  function decideApproval(approved: boolean, render = true): void {
    const decision = pendingApproval;
    if (!decision) return;
    pendingApproval = undefined;
    if (decision.timeout) clearTimeout(decision.timeout);
    state = { ...state, status: "tool" };
    decision.resolve(approved);
    if (render && !renderer.isDestroyed) syncView();
  }

  async function approve(request: WorkspaceApprovalRequest): Promise<boolean> {
    if (!config.runtime.requireApproval) return true;
    const preview = formatApprovalPreview(request);
    if (!preview.approvable) {
      addSystemMessage(preview.reason ?? "Operation denied because it cannot be previewed safely.");
      return false;
    }
    const remainingMs =
      activeDeadlineAt == null ? undefined : Math.max(0, activeDeadlineAt - Date.now());
    if (remainingMs === 0) return false;
    return await new Promise<boolean>((resolve) => {
      const decision: ApprovalDecision = { request, resolve };
      pendingApproval = decision;
      if (remainingMs != null) {
        decision.timeout = setTimeout(() => decideApproval(false), remainingMs);
      }
      completion = undefined;
      renderCompletionMenu();
      state = { ...state, status: "approval" };
      approvalBody.content = preview.body;
      syncView();
    });
  }

  const host = createEnvironmentHost({
    cwd: options.cwd,
    resolveSkillsPrompt: () => renderActiveSkills(workspaceSkills, activeSkillNames),
  });
  const tools = createWorkspaceTools({
    cwd: options.cwd,
    approve,
    allowShell: config.runtime.allowShell,
    allowWrites: config.runtime.allowWrites,
    requireApproval: config.runtime.requireApproval,
    maxOutputBytes: config.runtime.maxOutputChars,
    commandTimeoutMs: config.timeoutMs,
  });

  function buildDrone(): Drone {
    return defineDrone({
      id: "workspace-drone",
      description: "Interactive local workspace Drone runtime",
      model: { provider: config.provider, model: config.model },
      systemPrompt: `${config.systemPrompt}\n\nYou are running as Minion Drone in ${options.cwd}. Use workspace tools to ground answers in the actual files. Treat @path mentions as explicit user-selected references. Mentions beginning @~/ or @../ may point outside the workspace, but they do not change the runtime workspace or grant access; use only approval-gated capabilities for any external inspection. Read before changing. Never claim a write or command succeeded unless its tool result confirms success. Keep responses concise and call out anything requiring user approval.`,
      tools,
      maxSteps: config.maxSteps,
      timeoutMs: config.timeoutMs,
    });
  }
  let drone = buildDrone();

  async function handleCommand(value: string): Promise<boolean> {
    const [command = "", ...args] = value.slice(1).trim().split(/\s+/);
    if (command === "help" || command === "?") {
      togglePanel("help");
      return true;
    }
    if (command === "config") {
      togglePanel("config");
      return true;
    }
    if (command === "clear") {
      clearAll();
      return true;
    }
    if (command === "status") {
      const activeSkills = [...activeSkillNames].sort().join(", ") || "none";
      addSystemMessage(
        `**${state.status}** · ${config.provider}/${config.model} · ${options.cwd}\n\nActive skills: ${activeSkills}\n\nConfig diagnostics: ${options.configDiagnostics?.length ? options.configDiagnostics.join("; ") : "none"}`,
      );
      return true;
    }
    if (command === "skills") {
      const requestedName = args.join(" ").trim();
      if (!requestedName) {
        const activeSkills = [...activeSkillNames].sort().join(", ") || "none";
        addSystemMessage(
          `**${workspaceSkills.length} skill${workspaceSkills.length === 1 ? "" : "s"} available.** Type \`/skills \` to browse and filter workspace and user skills with the completion menu.\n\nActive: ${activeSkills}`,
        );
        return true;
      }
      const skill = workspaceSkills.find(
        (candidate) => candidate.name.toLowerCase() === requestedName.toLowerCase(),
      );
      if (!skill) {
        addSystemMessage(
          `Unknown skill: \`${requestedName}\`. Type \`/skills \` to browse available skills.`,
        );
        return true;
      }
      if (activeSkillNames.has(skill.name)) {
        activeSkillNames.delete(skill.name);
        addSystemMessage(`Skill **${skill.name}** is now inactive for this flight.`);
      } else {
        if (activeSkillNames.size >= MAX_ACTIVE_SKILLS) {
          addSystemMessage(
            `Drone supports up to ${MAX_ACTIVE_SKILLS} active skills per flight. Deactivate one with \`/skills <name>\` before enabling **${skill.name}**.`,
          );
          return true;
        }
        activeSkillNames.add(skill.name);
        addSystemMessage(
          `Skill **${skill.name}** is active for subsequent turns. Its instructions cannot bypass Drone's tool or approval policy.`,
        );
      }
      drone = buildDrone();
      return true;
    }
    if (command === "model") {
      const spec = args.join(" ");
      const slash = spec.indexOf("/");
      if (slash <= 0 || slash === spec.length - 1) {
        addSystemMessage("Usage: `/model <provider>/<model>`");
      } else {
        config.provider = spec.slice(0, slash);
        config.model = spec.slice(slash + 1);
        drone = buildDrone();
        addSystemMessage(`Model changed for this flight to **${config.provider}/${config.model}**.`);
      }
      return true;
    }
    if (command === "exit" || command === "quit") {
      finish();
      return true;
    }
    if (command) {
      addSystemMessage(`Unknown command: \`/${command}\`. Try \`/help\`.`);
      return true;
    }
    return false;
  }

  async function submit(value: string): Promise<void> {
    if (isBusy(state)) {
      addSystemMessage("A flight is already active. Press Esc to cancel it first.");
      return;
    }
    if (value.startsWith("/") && (await handleCommand(value))) return;

    const prompt = assistantHistory(state, value);
    const turnId = randomUUID();
    state = addUserTurn(state, value, turnId);
    activeAbort = new AbortController();
    activeDeadlineAt = Date.now() + config.timeoutMs;
    syncView();

    try {
      for await (const event of runDroneStream(
        drone,
        {
          prompt,
          abortSignal: activeAbort.signal,
          maxTokens: 1024,
          temperature: config.temperature,
          correlationId: turnId,
        },
        host,
      )) {
        state = reduceStreamEvent(state, event);
        syncView();
      }
    } finally {
      decideApproval(false, false);
      activeAbort = undefined;
      activeDeadlineAt = undefined;
      if (state.status !== "error") state = { ...state, status: "idle" };
      if (!finished && !renderer.isDestroyed) {
        syncView();
        composer.focus();
        void refreshWorkspaceSources();
      }
    }
  }

  async function refreshWorkspaceSources(
    discovery = Promise.all([
      discoverWorkspaceReferences(options.cwd, { maxDepth: 32, maxEntries: 10_000 }),
      discoverWorkspaceSkills(options.cwd),
    ]),
  ): Promise<void> {
    const generation = ++workspaceSourceGeneration;
    try {
      const [references, skills] = await discovery;
      if (finished || generation !== workspaceSourceGeneration) return;
      referenceIndexes.set(workspaceRoot, { references, recursive: true });
      workspaceSkills = skills;
      for (const name of activeSkillNames) {
        if (!skills.some((skill) => skill.name === name)) activeSkillNames.delete(name);
      }
      refreshCompletion();
    } catch {
      // Discovery is an enhancement; command entry and the runtime remain usable without it.
    }
  }

  function cancelFlight(render = true): void {
    decideApproval(false, render);
    activeAbort?.abort(new Error("Cancelled by user"));
  }

  let exitResolve: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });

  function finish(): void {
    if (finished) return;
    finished = true;
    shutdownRequested = true;
    cancelFlight();
    if (animationLive) {
      animationLive = false;
      renderer.dropLive();
    }
    renderer.destroy();
    exitResolve?.();
  }

  function handleRendererDestroy(): void {
    if (shutdownRequested) return;
    rendererStoppedUnexpectedly = true;
    finished = true;
    cancelFlight(false);
    exitResolve?.();
  }

  function handleGlobalKey(key: KeyEvent): void {
    if (pendingApproval) {
      const decision = approvalDecisionForKey(key.name);
      if (decision === "approve") decideApproval(true);
      else if (decision === "deny") decideApproval(false);
      else if (key.name === "up") approvalBodyViewport.scrollBy(-1);
      else if (key.name === "down") approvalBodyViewport.scrollBy(1);
      else if (key.name === "pageup") approvalBodyViewport.scrollBy(-6);
      else if (key.name === "pagedown") approvalBodyViewport.scrollBy(6);
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (panel) {
      if (key.name === "escape" || key.name === "?") panel = undefined;
      else if (panel === "config" && key.name === "m") cycleConfig("motion");
      else if (panel === "config" && key.name === "c") cycleConfig("mouseClicks");
      else return;
      syncView();
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.ctrl && key.name === "c") {
      if (isBusy(state)) cancelFlight();
      else finish();
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.name === "escape" && isBusy(state)) {
      cancelFlight();
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (completion && renderer.currentFocusedRenderable === composer) {
      const movesDown = key.name === "down" || (key.ctrl && key.name === "n");
      const movesUp = key.name === "up" || (key.ctrl && key.name === "p");
      const movesPageDown = key.name === "pagedown";
      const movesPageUp = key.name === "pageup";
      const accepts =
        key.name === "return" ||
        key.name === "enter" ||
        key.name === "kpenter" ||
        key.name === "tab";
      if (movesDown || movesUp || movesPageDown || movesPageUp) {
        if (movesPageDown || movesPageUp) pageCompletion(movesPageDown ? 1 : -1);
        else moveCompletion(movesDown ? 1 : -1);
      } else if (accepts && completion.selectedIndex >= 0) {
        acceptSelectedCompletion();
      } else if (key.name === "escape") {
        dismissCompletion();
      } else {
        return;
      }
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.name === "pageup") {
      transcript.scrollBy(-8);
      key.preventDefault();
    } else if (key.name === "pagedown") {
      transcript.scrollBy(8);
      key.preventDefault();
    } else if (key.name === "?" && composer.plainText.length === 0) {
      togglePanel("help");
      key.preventDefault();
    }
  }

  function handleRawInput(sequence: string): boolean {
    if (sequence === "\x03") {
      if (isBusy(state)) cancelFlight();
      else finish();
      return true;
    }
    if (
      sequence === "\t" &&
      completion &&
      completion.selectedIndex >= 0 &&
      renderer.currentFocusedRenderable === composer
    ) {
      acceptSelectedCompletion();
      return true;
    }
    if (sequence === "\t" || sequence === "\x1b[Z") {
      completion = undefined;
      renderCompletionMenu();
      if (renderer.currentFocusedRenderable === composer) transcript.focus();
      else composer.focus();
      return true;
    }
    return false;
  }

  lifecycleCleanup = () => {
    decideApproval(false, false);
    activeAbort?.abort(new Error("Drone TUI stopped"));
    renderer.off(CliRenderEvents.DESTROY, handleRendererDestroy);
    renderer.keyInput.off("keypress", handleGlobalKey);
    renderer.removeInputHandler(handleRawInput);
    syntaxStyle?.destroy();
    syntaxStyle = undefined;
    if (!renderer.isDestroyed) renderer.destroy();
  };

  renderer.on(CliRenderEvents.DESTROY, handleRendererDestroy);
  renderer.prependInputHandler(handleRawInput);
  renderer.keyInput.on("keypress", handleGlobalKey);
  renderer.on(CliRenderEvents.RESIZE, () => {
    syncView();
    refreshCompletion();
  });
  renderer.on(CliRenderEvents.SELECTION, (selection: Selection | null) => {
    if (!config.ui.copyOnSelect || !selection || selection.isActive) return;
    const selected = selection.getSelectedText();
    if (selected) renderer.copyToClipboardOSC52(selected);
  });
  renderer.setFrameCallback(async (deltaTime) => {
    if (!animationLive) return;
    frameElapsed += deltaTime;
    if (frameElapsed >= (config.ui.motion === "full" ? 90 : 240)) {
      frameElapsed = 0;
      frame += 1;
      const artMode =
        renderer.height < 18 || renderer.width < 62
          ? "minimal"
          : renderer.width < 90
            ? "compact"
            : config.ui.art;
      art.content = renderDroneArt(state.status, frame, artMode);
    }
  });

  void refreshWorkspaceSources(sourceDiscovery);
  syncView();
  composer.focus();
  rendererStarted = true;
  renderer.start();
  if (options.initialPrompt?.trim()) void submit(options.initialPrompt.trim());

  await exited;
  if (terminationSignal) {
    throw new DroneTuiSessionError(`Drone TUI terminated by ${terminationSignal}.`, {
      signal: terminationSignal,
    });
  }
  if (rendererStoppedUnexpectedly) {
    throw new DroneTuiSessionError("Drone renderer stopped unexpectedly.");
  }
  } catch (error) {
    if (error instanceof DroneTuiSessionError) throw error;
    if (terminationSignal) {
      throw new DroneTuiSessionError(`Drone TUI terminated by ${terminationSignal}.`, {
        cause: error,
        signal: terminationSignal,
      });
    }
    if (rendererStarted) {
      throw new DroneTuiSessionError(
        `Drone TUI failed after startup: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    for (const [signal, handler] of terminationHandlers) {
      process.off(signal, handler);
    }
    if (lifecycleCleanup) lifecycleCleanup();
    else {
      syntaxStyle?.destroy();
      if (!renderer.isDestroyed) renderer.destroy();
    }
  }
}
