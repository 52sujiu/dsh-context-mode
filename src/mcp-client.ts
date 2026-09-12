/**
 * Small JSON-RPC-over-stdio client for the context-mode MCP server.
 *
 * The upstream package already owns the sandbox, indexing, search, and session
 * accounting logic. This client only adapts its MCP transport to DSH tools.
 */

import { spawn, type ChildProcess } from 'node:child_process'

export interface McpTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: Record<string, unknown>
}

export interface McpContentItem {
  readonly type?: string
  readonly text?: string
}

export interface McpCallResult {
  readonly content?: readonly McpContentItem[]
  readonly isError?: boolean
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timer?: NodeJS.Timeout
}

interface RpcResponse {
  readonly id?: unknown
  readonly result?: unknown
  readonly error?: { readonly message?: unknown }
}

const MCP_PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000

/**
 * JSON-RPC client for one long-lived context-mode child process.
 */
export class McpStdioClient {
  private child: ChildProcess | undefined
  private nextId = 0
  private buffer = ''
  private closed = false
  private readonly pending = new Map<number, PendingRequest>()

  /**
   * @param serverScript - absolute path to context-mode's server bundle.
   * @param env - environment for the child process.
   * @param runtime - JavaScript runtime used to execute the bundle.
   * @param diagnose - optional diagnostic sink for child stderr.
   */
  constructor(
    private readonly serverScript: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly runtime = process.execPath,
    private readonly diagnose: (message: string) => void = () => {},
  ) {}

  /** Start the child if it is not already running. */
  start(): void {
    if (this.child !== undefined) return
    this.closed = false
    const child = spawn(this.runtime, [this.serverScript], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.receive(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message.length > 0) this.diagnose(message)
    })
    child.on('error', error => this.fail(error))
    child.on('exit', (code, signal) => {
      this.fail(new Error(`context-mode MCP server exited (${code ?? 'null'}, ${signal ?? 'none'})`))
    })
  }

  /** Perform the MCP initialize exchange. */
  async initialize(timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS): Promise<void> {
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'dsh-context-mode', version: '0.1.0' },
    }, timeoutMs)
    this.notify('notifications/initialized', {})
  }

  /** Return the server's current tool catalog. */
  async listTools(timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS): Promise<McpTool[]> {
    const response = await this.request<{ readonly tools?: readonly McpTool[] }>('tools/list', {}, timeoutMs)
    return Array.isArray(response.tools) ? [...response.tools] : []
  }

  /** Forward one DSH tool call to the MCP child. */
  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<McpCallResult> {
    return this.request<McpCallResult>('tools/call', { name, arguments: args ?? {} }, Number.POSITIVE_INFINITY, signal)
  }

  /** Stop the child and settle all pending requests. */
  shutdown(): void {
    const child = this.child
    this.child = undefined
    this.closed = true
    this.fail(new Error('context-mode MCP client stopped'))
    if (child === undefined) return
    try {
      child.kill('SIGTERM')
    } catch {
      // Teardown is best effort; the owner is already detached.
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // The process may have exited between the checks.
        }
      }
    }, 5_000).unref()
  }

  private request<T>(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const child = this.child
    if (child === undefined || this.closed) return Promise.reject(new Error('context-mode MCP client is not running'))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      let onAbort: (() => void) | undefined
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            if (!this.pending.has(id)) return
            this.pending.delete(id)
            if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
            reject(new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`))
          }, timeoutMs)
        : undefined
      const clear = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
      }
      const rejectPending = (reason: unknown): void => {
        if (!this.pending.delete(id)) return
        clear()
        reject(reason)
      }
      onAbort = () => {
        if (!this.pending.delete(id)) return
        this.notify('notifications/cancelled', { requestId: id, reason: 'DSH tool call cancelled' })
        clear()
        reject(abortError())
      }
      this.pending.set(id, {
        resolve: value => {
          clear()
          resolve(value as T)
        },
        reject: reason => {
          clear()
          reject(reason)
        },
        timer,
      })
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
      const stdin = child.stdin
      if (stdin === null || stdin.destroyed || stdin.writableEnded) {
        rejectPending(new Error('context-mode MCP stdin is unavailable'))
        return
      }
      try {
        stdin.write(frame, error => {
          if (error) rejectPending(error)
        })
      } catch (error) {
        rejectPending(error)
      }
    })
  }

  private notify(method: string, params: unknown): void {
    const stdin = this.child?.stdin
    if (stdin === undefined || stdin === null || stdin.destroyed || stdin.writableEnded) return
    try {
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    } catch {
      // A child exiting concurrently will reject the request through fail().
    }
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) this.handleLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let message: RpcResponse
    try {
      message = JSON.parse(line) as RpcResponse
    } catch {
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    if (message.error !== undefined) {
      const detail = typeof message.error.message === 'string' ? message.error.message : 'MCP request failed'
      pending.reject(new Error(detail))
      return
    }
    pending.resolve(message.result)
  }

  private fail(error: Error): void {
    this.child = undefined
    this.closed = true
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(error)
    }
    this.buffer = ''
  }
}

function abortError(): Error {
  const error = new Error('context-mode tool call cancelled')
  error.name = 'AbortError'
  return error
}
