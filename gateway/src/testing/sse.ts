// Test code only. Parses a complete `text/event-stream` body into events.
export type SseEvent = { event: string; data: unknown };

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (block.trim() === '') continue;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
    }
    const data: unknown = JSON.parse(dataLines.join('\n'));
    events.push({ event, data });
  }
  return events;
}

/** The `stage` names of the `event: stage` events, in order. */
export function stageNames(events: readonly SseEvent[]): string[] {
  return events
    .filter((e) => e.event === 'stage')
    .map((e) => {
      const data = e.data;
      if (typeof data === 'object' && data !== null && 'stage' in data) {
        return String(data.stage);
      }
      throw new Error('stage event without a stage member');
    });
}
