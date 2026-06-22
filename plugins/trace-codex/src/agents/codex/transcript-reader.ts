// Reads new content from a Codex transcript file starting at a byte offset.
//
// The processor "catches up" on the transcript whenever a hook arrives: it asks
// the reader for everything appended since the last read, parses the new lines,
// and advances its offset. This interface is the seam that keeps the processor
// free of direct filesystem coupling — production reads the real file, while
// unit tests inject a fake fed by `transcript(...)` test entries.
//
// On a terminal hook (Stop) the processor must not race the transcript writer:
// the turn's closing record may not be flushed to disk yet. `waitFor` polls the
// file, bounded by a timeout, until a sentinel line appears (or it gives up).
// This is the one deliberate blocking point, and it always returns rather than
// hanging the turn.

import { readFileSync, statSync } from "node:fs";
import type { Logger } from "../../log.ts";

/** Result of a read: the complete new lines and the advanced byte offset. */
export interface TranscriptReadResult {
  /** Complete lines (newline-terminated in the file) read since `offset`. */
  lines: string[];
  /**
   * The new offset to read from next time. A partial trailing line (no
   * newline yet) is NOT consumed and not advanced past, so it is re-read once
   * it is fully written.
   */
  offset: number;
}

/** Options bounding a `waitFor` poll. */
export interface WaitForOptions {
  /** Give up after this many milliseconds total. */
  timeoutMs: number;
  /** Delay between polls. */
  intervalMs: number;
}

/** Result of waiting: the lines read so far and whether the sentinel was seen. */
export interface TranscriptWaitResult extends TranscriptReadResult {
  /** True if `predicate` matched one of the read lines before the timeout. */
  sentinelFound: boolean;
}

export interface TranscriptReader {
  /**
   * Read complete lines from `path` starting at byte `offset`. Returns the new
   * lines plus the offset just past the last newline consumed. Must never
   * throw: on a missing/unreadable file it returns no lines and the same
   * offset, so the next hook simply tries again.
   */
  readFrom(path: string, offset: number): TranscriptReadResult;

  /**
   * Read from `offset`, then keep polling until `predicate` matches one of the
   * cumulative lines read or the timeout elapses. Returns all lines read across
   * polls, the advanced offset, and whether the sentinel was found. Never
   * throws and always returns within the timeout, so the caller can fail soft
   * (emit whatever exists) rather than stall the turn.
   */
  waitFor(
    path: string,
    offset: number,
    predicate: (line: string) => boolean,
    opts: WaitForOptions,
  ): Promise<TranscriptWaitResult>;
}

/**
 * Split a buffer into complete lines (those ending in "\n") and report how many
 * bytes were consumed. A trailing fragment without a newline is left for the
 * next read.
 */
function splitCompleteLines(buf: Buffer): { lines: string[]; consumed: number } {
  const lines: string[] = [];
  let lineStart = 0;
  let consumed = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a /* \n */) {
      lines.push(buf.toString("utf8", lineStart, i));
      lineStart = i + 1;
      consumed = lineStart;
    }
  }
  return { lines, consumed };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Production reader: reads the file, slices from `offset`, and returns complete
 * lines plus the advanced offset. Reads the whole file and slices for
 * simplicity; transcripts are modest and this runs off the hook hot path.
 */
export function createFileTranscriptReader(diagLogger?: Logger): TranscriptReader {
  function readFrom(path: string, offset: number): TranscriptReadResult {
    try {
      const size = statSync(path).size;
      // File shrank or truncated (e.g. replaced): reset to start.
      const from = offset > size ? 0 : offset;
      if (from >= size) {
        return { lines: [], offset: from };
      }
      const buf = readFileSync(path);
      const slice = buf.subarray(from);
      const { lines, consumed } = splitCompleteLines(slice);
      return { lines, offset: from + consumed };
    } catch (err) {
      diagLogger?.debug("transcript reader: read failed; skipping", {
        path,
        offset,
        error: String(err),
      });
      return { lines: [], offset };
    }
  }

  async function waitFor(
    path: string,
    offset: number,
    predicate: (line: string) => boolean,
    opts: WaitForOptions,
  ): Promise<TranscriptWaitResult> {
    const deadline = Date.now() + opts.timeoutMs;
    const allLines: string[] = [];
    let cursor = offset;
    let sentinelFound = false;

    // Poll until the sentinel appears or we run out of time. Always does at
    // least one read so a sentinel already on disk is found immediately.
    for (;;) {
      const { lines, offset: next } = readFrom(path, cursor);
      cursor = next;
      for (const line of lines) {
        allLines.push(line);
        if (predicate(line)) sentinelFound = true;
      }
      if (sentinelFound || Date.now() >= deadline) break;
      await sleep(opts.intervalMs);
    }

    if (!sentinelFound) {
      diagLogger?.debug("transcript reader: sentinel not found before timeout", {
        path,
        offset,
        timeoutMs: opts.timeoutMs,
      });
    }
    return { lines: allLines, offset: cursor, sentinelFound };
  }

  return { readFrom, waitFor };
}

/** Default production reader (no diagnostics). */
export const defaultTranscriptReader: TranscriptReader = createFileTranscriptReader();
