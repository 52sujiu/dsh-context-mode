/**
 * platform/dsh — the only platform adapter this fork ships.
 *
 * The upstream project carries eighteen hook adapters (Claude Code, Codex,
 * Cursor, Gemini CLI, …) because each host wires hooks differently. This fork
 * targets DSH alone, so those adapters were removed and this class takes their
 * place.
 *
 * DSH does not use JSON-stdio hooks: it exposes a Cordis service surface
 * (`tools.guard`, `tools/post-execute`, `systemPrompt.context`), so the hook
 * capabilities below are all false by design. The DSH adapter layer in the
 * parent package implements the equivalent behaviour natively, and this class
 * exists so the remaining upstream code that calls `getAdapter()` keeps a
 * working, honest answer.
 */

import { resolve } from "node:path";
import type {
  DiagnosticResult,
  HookAdapter,
  HookParadigm,
  HookRegistration,
  PlatformCapabilities,
  SessionStartEvent,
  PreCompactEvent,
  PreToolUseEvent,
  PostToolUseEvent,
  PreToolUseResponse,
  PostToolUseResponse,
  PreCompactResponse,
  SessionStartResponse,
} from "./types.js";
import { getSessionDirSegments } from "./detect.js";

/** Capabilities for a host whose integration is a service surface, not hooks. */
const DSH_CAPABILITIES: PlatformCapabilities = {
  preToolUse: false,
  postToolUse: false,
  preCompact: false,
  sessionStart: false,
  canModifyArgs: false,
  canModifyOutput: false,
  canInjectSessionContext: false,
};

export class DshAdapter implements HookAdapter {
  readonly name = "DSH";
  readonly paradigm: HookParadigm = "mcp-only";
  readonly capabilities: PlatformCapabilities = DSH_CAPABILITIES;

  private readonly platform: string;

  constructor(platform = "pi") {
    this.platform = platform;
  }

  // ── Input parsing ──────────────────────────────────────
  // DSH never routes a JSON-stdio hook through here. These methods satisfy the
  // contract and fail loudly if a future caller assumes otherwise.

  parsePreToolUseInput(_raw: unknown): PreToolUseEvent {
    throw new Error("DSH routes tool guard decisions through Cordis, not JSON-stdio hooks");
  }

  parsePostToolUseInput(_raw: unknown): PostToolUseEvent {
    throw new Error("DSH routes tool results through Cordis, not JSON-stdio hooks");
  }

  parsePreCompactInput(_raw: unknown): PreCompactEvent {
    throw new Error("DSH routes compaction through session events, not JSON-stdio hooks");
  }

  parseSessionStartInput(_raw: unknown): SessionStartEvent {
    throw new Error("DSH injects session context through systemPrompt, not JSON-stdio hooks");
  }

  // ── Response formatting ────────────────────────────────
  // No JSON-stdio path exists, so there is nothing to format.

  formatPreToolUseResponse(_response: PreToolUseResponse): undefined {
    return undefined;
  }

  formatPostToolUseResponse(_response: PostToolUseResponse): undefined {
    return undefined;
  }

  formatPreCompactResponse(_response: PreCompactResponse): undefined {
    return undefined;
  }

  formatSessionStartResponse(_response: SessionStartResponse): undefined {
    return undefined;
  }

  // ── Configuration ──────────────────────────────────────
  // DSH configuration lives in the DSH profile's cordis patch, not in a
  // third-party settings file, so these report the DSH-owned storage root.

  getSettingsPath(): string {
    return resolve(process.env.CONTEXT_MODE_DIR ?? "", "settings.json");
  }

  getConfigDir(projectDir?: string): string {
    return projectDir && projectDir.length > 0 ? resolve(projectDir) : process.cwd();
  }

  getInstructionFiles(): string[] {
    return ["AGENTS.md"];
  }

  getSessionDir(): string {
    const segments = getSessionDirSegments(this.platform);
    const root = process.env.CONTEXT_MODE_DIR;
    if (root && root.length > 0) return resolve(root, "sessions");
    return segments === null ? resolve(process.cwd(), "sessions") : resolve(...segments);
  }

  getMemoryDir(projectDir?: string): string {
    const root = process.env.CONTEXT_MODE_DIR ?? process.cwd();
    return resolve(root, "memory", projectDir ?? "");
  }

  generateHookConfig(_pluginRoot: string): HookRegistration {
    return {};
  }

  readSettings(): Record<string, unknown> | null {
    return null;
  }

  writeSettings(_settings: Record<string, unknown>): void {
    // DSH configuration is declarative; the adapter never rewrites host files.
  }

  backupSettings(): string | null {
    // Nothing to back up: DSH settings live in the profile's cordis patch,
    // which this adapter never modifies.
    return null;
  }

  // ── Diagnostics ────────────────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    return [
      {
        check: "Hook support",
        status: "pass",
        message:
          "DSH integrates context-mode through native Cordis tools, guards, " +
          "and prompt sections rather than external hook scripts.",
      },
    ];
  }

  checkPluginRegistration(): DiagnosticResult {
    return {
      check: "DSH plugin registration",
      status: "pass",
      message: "context-mode is bridged by the dsh-context-mode plugin.",
    };
  }

  getInstalledVersion(): string {
    return "standalone";
  }

  configureAllHooks(_pluginRoot: string): string[] {
    return [];
  }

  setHookPermissions(_pluginRoot: string): string[] {
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // No external registry: the plugin ships with the DSH profile.
  }

  getRoutingInstructions(): string {
    return (
      "# context-mode\n\n" +
      "Use the context-mode tools (ctx_execute, ctx_execute_file, ctx_batch_execute, " +
      "ctx_fetch_and_index, ctx_index, ctx_search) instead of inline shell or HTTP " +
      "calls for data-heavy operations."
    );
  }
}

/**
 * Extract the installed plugin root from `codex plugin list` output.
 *
 * This helper was owned by the Codex adapter upstream. It survives here because
 * `server.ts` probes for a Codex installation to locate hook scripts, and the
 * parsing itself carries no Codex runtime dependency.
 *
 * @param raw - captured stdout of `codex plugin list`.
 * @returns the plugin root path, or null when the line is absent.
 */
export function parseCodexContextModePluginRoot(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*context-mode@context-mode\s+installed,\s+enabled\s+\S+\s+(.+?)\s*$/);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}
