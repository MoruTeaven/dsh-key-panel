/**
 * Usage log — what the model's shell commands were actually handed.
 *
 * This is the second of the two independent records described in
 * dsh-key-panel-docs/design-notes.md (D5/D6):
 *
 *   intent  — the model declares a purpose, via a tool. Has a message.
 *   use     — a shell command resolved the environment. No message, ever.
 *
 * They are stored separately and correlated BY TIMESTAMP when displayed,
 * never paired in code. Pairing would require a window and a guess, and a
 * wrong guess here reads as a fact. Two honest records beat one inferred one.
 *
 * ── What this file deliberately is NOT ────────────────────────────────────
 *
 * Not an audit trail. resolve() fires on every shell command and receives no
 * arguments, so the strongest true statement it supports is "these names were
 * offered to a command at this time". It is NOT "this key was read", and it is
 * NOT "this key was used to do X". The panel must not imply otherwise.
 *
 * For that reason nothing here is authoritative: writes are best-effort, a
 * failed write is swallowed, and entries are dropped past a cap. Losing the
 * tail of this file costs a trend line, not a secret.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Entries kept before the oldest are dropped. */
export const USAGE_LIMIT = 1000;

/** Flush at most this often, so a tight command loop cannot spin the disk. */
export const FLUSH_INTERVAL_MS = 5000;

/** Write immediately once this many entries are pending, regardless of time. */
export const FLUSH_THRESHOLD = 50;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Record kinds. A closed set — the reader switches on it. */
export const KIND_USE = 'use';
export const KIND_INTENT = 'intent';
export const USAGE_KINDS = Object.freeze([KIND_USE, KIND_INTENT]);

/**
 * A name is recorded as-is. It is already validated on the way into the key
 * store, so this only guards against a caller passing something malformed.
 */
function normaliseNames(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const name of raw) {
        if (typeof name !== 'string') continue;
        if (out.includes(name)) continue;
        out.push(name);
    }
    return out;
}

/** Free text, trimmed and capped. Empty becomes undefined, never "". */
function normaliseNote(raw) {
    if (typeof raw !== 'string') return undefined;
    const clean = raw.trim();
    if (clean.length === 0) return undefined;
    return clean.length > 500 ? `${clean.slice(0, 497)}...` : clean;
}

/**
 * Read back a usage log.
 *
 * Tolerant by design: a truncated final line is expected after a hard kill
 * (append-only, no fsync per line), so it is skipped rather than treated as
 * corruption. Anything unreadable yields an empty log instead of throwing —
 * a panel that cannot draw a chart should still draw the key list.
 *
 * @param {string} filePath - absolute path to usage.jsonl.
 * @returns {Array<object>} oldest first.
 */
export function readUsage(filePath) {
    if (!existsSync(filePath)) return [];
    let text;
    try {
        text = readFileSync(filePath, 'utf8');
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            // The expected case is a half-written trailing line.
            continue;
        }
        if (parsed === null || typeof parsed !== 'object') continue;
        if (!USAGE_KINDS.includes(parsed.kind)) continue;
        if (typeof parsed.t !== 'number' || !Number.isFinite(parsed.t)) continue;
        out.push(parsed);
    }
    return out;
}

/**
 * Buffered, best-effort usage log.
 *
 * The buffering is not premature optimisation — it is the whole point.
 * `resolve()` runs on every shell command, and a synchronous append per
 * command would put a disk write (and a lock) in the path of every command the
 * model runs. So `record()` is pure memory, and a flush is scheduled.
 */
export class UsageLog {
    /**
     * @param {string} filePath - absolute path to usage.jsonl.
     * @param {{ now?: () => number, limit?: number }} [options]
     */
    constructor(filePath, options = {}) {
        this.filePath = filePath;
        this.dir = dirname(filePath);
        this.limit = options.limit ?? USAGE_LIMIT;
        this.now = options.now ?? (() => Date.now());
        this.pending = [];
        this.timer = null;
        this.count = 0;
    }

    /**
     * Buffer one entry. Never throws — a log line is not worth an exception on
     * the path of a command the model is waiting on.
     *
     * @param {string} kind - KIND_USE or KIND_INTENT.
     * @param {string[]} names - names involved.
     * @param {{ note?: string, at?: number }} [extra]
     */
    record(kind, names, extra = {}) {
        try {
            if (!USAGE_KINDS.includes(kind)) return;
            const clean = normaliseNames(names);
            if (clean.length === 0) return;
            const entry = { t: extra.at ?? this.now(), kind, names: clean };
            const note = normaliseNote(extra.note);
            if (note !== undefined) entry.note = note;
            this.pending.push(entry);
            this.count += 1;
            if (this.pending.length >= FLUSH_THRESHOLD) {
                this.flush();
                return;
            }
            this.#schedule();
        }
        catch {
            // Recording is never allowed to break the caller.
        }
    }

    #schedule() {
        if (this.timer !== null) return;
        try {
            this.timer = setTimeout(() => {
                this.timer = null;
                this.flush();
            }, FLUSH_INTERVAL_MS);
            // Do not hold the process open just to write a log line.
            this.timer.unref?.();
        }
        catch {
            this.timer = null;
        }
    }

    /**
     * Append everything buffered. Best-effort: on failure the entries are
     * dropped rather than retried forever, because the alternative is an
     * unbounded buffer growing inside a plugin.
     *
     * @returns {number} entries written.
     */
    flush() {
        if (this.timer !== null) {
            try {
                clearTimeout(this.timer);
            }
            catch { /* nothing to clear */ }
            this.timer = null;
        }
        if (this.pending.length === 0) return 0;
        const batch = this.pending;
        this.pending = [];
        const body = batch.map(entry => `${JSON.stringify(entry)}\n`).join('');
        try {
            mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
            appendFileSync(this.filePath, body, { mode: FILE_MODE });
        }
        catch {
            // Dropped on purpose. See the class docstring.
            return 0;
        }
        this.#trim();
        return batch.length;
    }

    /**
     * Keep the file at `limit` entries.
     *
     * Rewrites the whole file, which is why it only runs when the file has
     * grown past the cap — on a log this size that is rare, and a passive
     * reader can tolerate a slightly oversized file between trims.
     */
    #trim() {
        try {
            const entries = readUsage(this.filePath);
            if (entries.length <= this.limit) return;
            const kept = entries.slice(entries.length - this.limit);
            const body = kept.map(entry => `${JSON.stringify(entry)}\n`).join('');
            // Unlike keys.json this is NOT a tmp+rename. A trim that is
            // interrupted loses log lines, and log lines are expendable;
            // paying for atomicity here would buy durability this file
            // explicitly does not promise.
            writeFileSync(this.filePath, body, { mode: FILE_MODE });
        }
        catch {
            // A failed trim leaves an oversized log. Harmless.
        }
    }

    /** Entries recorded this session, including those already flushed. */
    total() {
        return this.count;
    }
}

export function usageLogPath(dshHome) {
    return join(dshHome, 'key-panel', 'usage.jsonl');
}
