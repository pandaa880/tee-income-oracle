/** Parser for a complete Server-Sent Events body (the gateway's `complete` stream, FORMATS §16). */

export type SseEvent = { event: string; data: unknown };

/**
 * Events in order. Blocks are separated by a blank line; `:` lines are
 * comments (keep-alives); several `data:` lines join with `\n` and parse as
 * JSON. A block with no `event` or `data` is skipped.
 *
 * @throws SyntaxError on data that isn't JSON.
 */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = '';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (event !== '' && data.length > 0) {
      events.push({ event, data: JSON.parse(data.join('\n')) });
    }
  }
  return events;
}
