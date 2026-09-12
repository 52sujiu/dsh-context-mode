import type { ToolRuntime } from '@deepseek-ai/dsh-tools';
/** Install the Pi-equivalent guard for context-flooding Bash requests. */
export declare function installBashRoutingGuard(tools: ToolRuntime): () => void;
/** Remove quoted arguments before evaluating shell command routing tokens. */
export declare function stripQuotedContent(command: string): string;
/** Return whether a curl or wget segment writes output away from the model. */
export declare function isSafeCurlWget(segment: string): boolean;
//# sourceMappingURL=routing.d.ts.map