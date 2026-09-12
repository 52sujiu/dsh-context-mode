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
 *   - queries segment identically, so "缓存方案" becomes the tokens
 *     `缓 存 方 案` and the searcher can match them.
 *
 * The query side deliberately does NOT wrap the segmented run in a phrase.
 * Phrase semantics were tried first and made retrieval worse: a document
 * saying "缓存走本地文件" and a query saying "缓存方案用什么" share the
 * prefix but diverge immediately, so an adjacency requirement rejects the
 * result a caller actually wanted. Emitting single tokens instead lets
 * upstream's `sanitizeQuery` build an AND expression, and BM25 ranks the
 * document that shares more characters first, which is the ranking a
 * character-based index can honestly provide. See {@link buildCjkQuery}.
 */

/** Han, Hiragana, Katakana, and Hangul ranges that need segmentation. */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

const CJK_RUN_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g

/** Return whether a string contains any character that needs segmentation. */
export function hasCjk(value: string): boolean {
  return CJK_PATTERN.test(value)
}

/**
 * Segment every CJK run into space-separated single characters.
 *
 * Non-CJK text is preserved verbatim, so latin identifiers, paths, and version
 * strings keep their original token shapes.
 *
 * @param value - document text or query text.
 * @returns the segmented text.
 */
export function segmentCjk(value: string): string {
  if (!hasCjk(value)) return value
  return value.replace(CJK_RUN_PATTERN, run => ` ${Array.from(run).join(' ')} `)
}

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
export function buildCjkQuery(query: string): string {
  return segmentCjk(query).replace(/\s+/g, ' ').trim()
}



