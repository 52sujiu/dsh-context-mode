/**
 * Small JSON-RPC-over-stdio client for the context-mode MCP server.
 *
 * The upstream package already owns the sandbox, indexing, search, and session
 * accounting logic. This client only adapts its MCP transport to DSH tools.
 */
export interface McpTool {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: Record<string, unknown>;
}
export interface McpContentItem {
    readonly type?: string;
    readonly text?: string;
}
export interface McpCallResult {
    readonly content?: readonly McpContentItem[];
    readonly isError?: boolean;
}
/**
 * JSON-RPC client for one long-lived context-mode child process.
 */
export declare class McpStdioClient {
    private readonly serverScript;
    private readonly env;
    private readonly runtime;
    private readonly diagnose;
    private child;
    private nextId;
    private buffer;
    private closed;
    private readonly pending;
    /**
     * @param serverScript - absolute path to context-mode's server bundle.
     * @param env - environment for the child process.
     * @param runtime - JavaScript runtime used to execute the bundle.
     * @param diagnose - optional diagnostic sink for child stderr.
     */
    constructor(serverScript: string, env: NodeJS.ProcessEnv, runtime?: string, diagnose?: (message: string) => void);
    /** Start the child if it is not already running. */
    start(): void;
    /** Perform the MCP initialize exchange. */
    initialize(timeoutMs?: number): Promise<void>;
    /** Return the server's current tool catalog. */
    listTools(timeoutMs?: number): Promise<McpTool[]>;
    /** Forward one DSH tool call to the MCP child. */
    callTool(name: string, args: unknown, signal: AbortSignal): Promise<McpCallResult>;
    /** Stop the child and settle all pending requests. */
    shutdown(): void;
    private request;
    private notify;
    private receive;
    private handleLine;
    private fail;
}
//# sourceMappingURL=mcp-client.d.ts.map