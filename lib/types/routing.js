const BLOCKED_HTTP_PATTERNS = [
    /\bfetch\s*\(/,
    /\brequests\.get\s*\(/,
    /\brequests\.post\s*\(/,
    /\bhttp\.get\s*\(/,
    /\bhttp\.request\s*\(/,
    /\burllib\.request/,
    /\bInvoke-WebRequest\b/,
];
/** Install the Pi-equivalent guard for context-flooding Bash requests. */
export function installBashRoutingGuard(tools) {
    return tools.guard((execution) => {
        if (execution.name !== 'bash')
            return undefined;
        const args = execution.arguments;
        if (args === null || typeof args !== 'object' || Array.isArray(args))
            return undefined;
        const command = args.command;
        if (typeof command !== 'string' || command.length === 0)
            return undefined;
        const stripped = stripQuotedContent(command);
        if (BLOCKED_HTTP_PATTERNS.some(pattern => pattern.test(stripped))) {
            return 'Use context-mode tools (ctx_execute, ctx_fetch_and_index) instead of inline HTTP clients. Raw fetch/requests/http output floods the context window.';
        }
        if (!/(^|\s|&&|\||;)(curl|wget)\s/i.test(stripped))
            return undefined;
        const unsafe = stripped.split(/\s*(?:&&|\|\||;)\s*/).some(segment => !isSafeCurlWget(segment));
        if (unsafe) {
            return 'Use context-mode tools (ctx_execute, ctx_fetch_and_index) instead of inline HTTP clients. Raw curl/wget output floods the context window. For an MCP-down escape hatch, use silent + file output: `curl -s -o /tmp/x.json URL` or `wget -q -O /tmp/x.json URL`.';
        }
        return undefined;
    });
}
/** Remove quoted arguments before evaluating shell command routing tokens. */
export function stripQuotedContent(command) {
    return command
        .replace(/<<-?\s*["']?(\w+)["']?[\s\S]*?\n\s*\1/g, '')
        .replace(/'[^']*'/g, "''")
        .replace(/"[^"]*"/g, '""');
}
/** Return whether a curl or wget segment writes output away from the model. */
export function isSafeCurlWget(segment) {
    const value = segment.trim();
    const isCurl = /\bcurl\b/i.test(value);
    const isWget = /\bwget\b/i.test(value);
    if (!isCurl && !isWget)
        return true;
    const hasFileOutput = isCurl
        ? /\s(-o|--output)\s/.test(value) || /\s>\s*/.test(value) || /\s>>\s*/.test(value)
        : /\s(-O|--output-document)\s/.test(value) || /\s>\s*/.test(value) || /\s>>\s*/.test(value);
    if (!hasFileOutput)
        return false;
    if (isCurl && /\s(-o|--output)\s+(-|\/dev\/stdout)(\s|$)/.test(value))
        return false;
    if (isWget && /\s(-O|--output-document)\s+(-|\/dev\/stdout)(\s|$)/.test(value))
        return false;
    if (/\s(-v|--verbose|--trace)\b/.test(value))
        return false;
    return isCurl ? /\s-[a-zA-Z]*s|--silent/.test(value) : /\s-[a-zA-Z]*q|--quiet/.test(value);
}
