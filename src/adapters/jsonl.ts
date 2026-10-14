/**
 * Split a byte stream into JSONL records on LF only.
 *
 * Node's `readline` also breaks on U+2028 and U+2029, which are legal inside JSON
 * strings — a transcript containing either would be split mid-record and fail to
 * parse. Pi's RPC protocol says so explicitly, so this does the framing by hand.
 */
export class LineFramer {
  #buffer = '';

  push(chunk: string): string[] {
    this.#buffer += chunk;
    const parts = this.#buffer.split('\n');
    this.#buffer = parts.pop() ?? '';
    return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  }

  /** Any trailing partial record, for a stream that ended without a final LF. */
  flush(): string[] {
    if (this.#buffer === '') return [];
    const last = this.#buffer;
    this.#buffer = '';
    return [last.endsWith('\r') ? last.slice(0, -1) : last];
  }
}
