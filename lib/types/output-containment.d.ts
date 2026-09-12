/**
 * Post-execute output containment for DSH.
 *
 * The Bash routing guard stops most context-flooding commands before they run,
 * but a model can still reach one through a path the guard allows, or through
 * another tool entirely. This listener is the second line of defense: when a
 * result is oversized it keeps the head and tail, writes the full text to a
 * spill file, and tells the model how to read it back.
 *
 * The listener is cooperative: it never throws, accepts every result it does
 * not need to change, and only shrinks content larger than the configured cap.
 */
import type { Context } from '@deepseek-ai/cordis';
export interface OutputContainmentOptions {
    /** Byte budget for one result's model-facing text. */
    readonly maxResultBytes?: number;
    /** Directory receiving spilled payloads. */
    readonly spillDir?: string;
}
interface SpillRecord {
    readonly path: string;
    readonly bytes: number;
}
/**
 * Install the post-execute containment listener.
 *
 * @param ctx - the plugin context whose event bus carries tool dispatch.
 * @param options - optional byte cap and spill directory.
 * @returns the exact disposer that removes the listener.
 */
export declare function installOutputContainment(ctx: Context, options?: OutputContainmentOptions): () => void;
/** Test-only: expose recorded spills for assertions. */
export declare function __spillRecordsForTests(): readonly SpillRecord[];
export {};
//# sourceMappingURL=output-containment.d.ts.map