/**
 * dsh-context-mode: expose context-mode's MCP tools as native DSH tools.
 *
 * The upstream context-mode package remains the source of truth for sandboxed
 * execution, indexing, search, and session accounting. This package supplies
 * the DSH Cordis adapter and keeps the MCP child isolated from the TUI process.
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-context-mode";
/** Configuration for the context-mode MCP bridge. */
export interface Config {
    /** Whether to start context-mode and register its tools. */
    enabled?: boolean;
    /** Optional absolute or cwd-relative path to a context-mode server bundle. */
    serverPath?: string;
    /** Workspace used for context-mode project isolation. */
    projectDir?: string;
    /** Root for context-mode's session and content databases. */
    storageDir?: string;
    /** Timeout for the MCP initialize and tools/list handshake. */
    handshakeTimeoutMs?: number;
    /**
     * Archive the transcript into the knowledge base when compaction begins, so
     * `ctx_search` can still reach what the compaction summary drops.
     */
    precompact?: boolean;
    /**
     * Tool names to keep out of the model's catalog and the skill list.
     *
     * Every registered tool ships its full schema on every request, so a tool
     * nobody calls is a permanent token tax. Defaults to the maintenance-only
     * tools: diagnostics, analytics, and statistics are things a human runs
     * deliberately, not something the model should reach for mid-task.
     */
    disabledTools?: string[];
}
export declare const Config: Schemastery<Config>;
export declare const ROUTING_TEXT: string;
/** Register the plugin and bridge context-mode's MCP tool catalog into DSH. */
export declare function apply(ctx: Context, config?: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map