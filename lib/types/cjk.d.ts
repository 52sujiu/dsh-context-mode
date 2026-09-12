/**
 * CJK segmentation for context-mode's FTS5 index.
 *
 * context-mode builds two FTS5 tables with `tokenize='porter unicode61'` and
 * `tokenize='trigram'`. Neither treats CJK text as searchable:
 *
 *   - `unicode61` classifies a run of Han characters as ONE token, so the
 *     document "缓存走本地文件就行" indexes as a single term and a query for
 *     "缓存" matches nothing.
 *   - `trigram` indexes 3-character windows, so only CJK queries of three or
 *     more characters can match; two-character words like "缓存" never do.
 *
 * The fix applied here is applied on BOTH sides of the index:
 *
 *   - writes segment CJK runs into single characters separated by spaces,
 *     which makes `unicode61` emit one token per character;
 *   - queries segment identically and are joined as a phrase, so an adjacent
 *     query like "缓存方案" becomes the phrase `"缓 存 方 案"` and only
 *     matches documents where those characters appear adjacently.
 *
 * Phrase semantics matter: without the phrase the query would degrade to an
 * AND of single characters, matching any document that merely contains all of
 * them. See {@link buildCjkQuery}.
 */
/** Return whether a string contains any character that needs segmentation. */
export declare function hasCjk(value: string): boolean;
/**
 * Segment every CJK run into space-separated single characters.
 *
 * Non-CJK text is preserved verbatim, so latin identifiers, paths, and version
 * strings keep their original token shapes.
 *
 * @param value - document text or query text.
 * @returns the segmented text.
 */
export declare function segmentCjk(value: string): string;
/**
 * Rewrite a CJK query so the upstream FTS5 tokenizer can match it.
 *
 * A CJK query must be segmented exactly like the indexed documents, and the
 * characters must be handed to the searcher as plain space-separated tokens.
 * Quoting them as one phrase would demand that the query's characters appear
 * adjacently in the document, which almost never holds — the document says
 * "缓存走本地文件" while the query says "缓存方案用什么".
 *
 * Upstream's own `sanitizeQuery` re-tokenizes on whitespace and joins with its
 * operator, so emitting `缓 存 方 案` yields `"缓" "存" "方" "案"` (AND), and
 * BM25 ranks documents containing more of those characters first.
 *
 * @param query - the raw model-supplied query.
 * @returns the segmented query, or the input unchanged when it has no CJK text.
 */
export declare function buildCjkQuery(query: string): string;
//# sourceMappingURL=cjk.d.ts.map