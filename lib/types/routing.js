const BLOCKED_HTTP_PATTERNS = [
    /\bfetch\s*\(/,
    /\brequests\.get\s*\(/,
    /\brequests\.post\s*\(/,
    /\bhttp\.get\s*\(/,
    /\bhttp\.request\s*\(/,
    /\burllib\.request/,
    /\bInvoke-WebRequest\b/,
];
/**
 * Commands whose output is small and whose effect is a mutation, so Bash stays
 * the right tool. Anything not listed here is judged by the flood rules below.
 */
const SAFE_COMMAND_PATTERNS = [
    // File mutations, navigation, and short directory listings.
    /^(mkdir|rmdir|mv|cp|ln|touch|chmod|chown|cd|pwd|which|command|type|rm|unlink|ls)\b/,
    // Process control.
    /^(kill|pkill|killall|jobs|fg|bg)\b/,
    // Package management (progress output, no data payload).
    /^(npm|pnpm|yarn|bun|pip|pip3|poetry|uv|gem|go|cargo|apt|apt-get|brew)\s+(install|add|remove|uninstall|publish|link|unlink|update|upgrade|ci)\b/,
    // Git writes; git reads stay routed so their output never enters context.
    /^git\s+(add|commit|push|pull|fetch|checkout|switch|branch|merge|rebase|reset|restore|stash|tag|init|clone|remote|config|rm|mv)\b/,
    // Terminal output with no data payload.
    /^(echo|printf|true|false|sleep|export|unset|set|source)\b/,
];
/** Read-only commands whose output scales with the repository or host. */
const FLOOD_COMMAND_PATTERNS = [
    // Tests, builds, linters, type checks.
    /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|check|typecheck|coverage|audit|outdated|why|ls|view)\b/,
    /^(jest|vitest|mocha|ava|pytest|tox|nose|go\s+test|cargo\s+(test|build|check|clippy)|mvn|gradle|make|tsc|eslint|ruff|mypy|flake8)\b/,
    // Filesystem and text dumps. `ls` is deliberately absent: it stays on Bash
    // because a directory listing is short in practice and is used constantly.
    /^(cat|bat|less|more|head|tail|nl|tac|xxd|od|strings|wc)\b/,
    /^(find|fd|tree|du|df|stat|file)\b/,
    // Log and stream readers.
    /^(journalctl|dmesg|log\s+show|syslog)\b/,
    // Repository history and search.
    /^git\s+(log|diff|show|blame|status|shortlog|reflog|whatchanged|describe|ls-files|ls-tree|grep|stash\s+list)\b/,
    /^(rg|ripgrep|ag|ack|grep|egrep|fgrep|sed|awk|cut|sort|uniq|jq|yq|xargs)\b/,
    // Data and query CLIs.
    /^(psql|mysql|sqlite3|mongosh|redis-cli|clickhouse-client)\b/,
    // Cloud, container, and orchestration listings.
    /^(gh|aws|gcloud|az|kubectl|helm|terraform|docker|docker-compose|podman|nerdctl|fly|flyctl|heroku|wrangler|vault|doctl|vercel|netlify)\b/,
    // Network inspection.
    /^(dig|nslookup|host|traceroute|netstat|ss|lsof|nmap|ping)\b/,
    // Python/ruby/node one-liners that read data.
    /^(python|python3|node|ruby|perl|deno|bun)\s+-[ce]\b/,
];
/**
 * A command already narrowed by the caller: piped into a head-like limiter, or
 * redirected to a file. These keep data out of context, so they stay allowed.
 */
const NARROWING_PATTERNS = [
    /\|\s*(head|tail|less|more)\b/,
    /\|\s*(wc|uniq|sort)\b[^|]*$/,
    /(^|[^>])>\s*[^\s|&]+/,
    />>\s*[^\s|&]+/,
];
/** Install the DSH routing guard for context-flooding Bash requests. */
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
        const segments = stripped.split(/\s*(?:&&|\|\||;|\n)\s*/).filter(segment => segment.trim().length > 0);
        const curlWget = segments.filter(segment => /(^|\s)(curl|wget)\s/i.test(segment));
        if (curlWget.length > 0) {
            const unsafe = curlWget.some(segment => !isSafeCurlWget(segment));
            if (unsafe) {
                return 'Use context-mode tools (ctx_execute, ctx_fetch_and_index) instead of inline HTTP clients. Raw curl/wget output floods the context window. For an escape hatch, use silent + file output: `curl -s -o /tmp/x.json URL` or `wget -q -O /tmp/x.json URL`.';
            }
        }
        const flood = segments.find(segment => isFloodingSegment(segment));
        if (flood !== undefined) {
            return [
                'Run this through context-mode instead of Bash: the raw output would flood the context window.',
                `Use ctx_execute with language "shell" (or python/javascript) to run \`${firstLine(flood)}\` and print only the summary you need,`,
                'use ctx_execute_file to analyze a file without loading it, and ctx_batch_execute when several commands belong together.',
                'If the raw output is genuinely required, redirect it to a file and read that file: `COMMAND > /tmp/out.txt`.',
            ].join(' ');
        }
        return undefined;
    });
}
/** Return whether one shell segment is read-only with repository- or host-sized output. */
export function isFloodingSegment(segment) {
    const value = segment.trim();
    if (value.length === 0)
        return false;
    if (NARROWING_PATTERNS.some(pattern => pattern.test(value)))
        return false;
    if (SAFE_COMMAND_PATTERNS.some(pattern => pattern.test(value)))
        return false;
    return FLOOD_COMMAND_PATTERNS.some(pattern => pattern.test(value));
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
/** Keep the denial message to one readable line of the offending command. */
function firstLine(command) {
    const clipped = command.trim().split('\n')[0] ?? '';
    return clipped.length <= 120 ? clipped : `${clipped.slice(0, 119)}…`;
}
