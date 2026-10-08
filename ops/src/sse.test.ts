import { describe, expect, it } from 'vitest';
import { parseSse } from './sse.ts';

describe('parseSse', () => {
  it('parses_events_separated_by_blank_lines', () => {
    const text =
      'event: stage\ndata: {"stage":"bind"}\n\n' +
      'event: stage\ndata: {"stage":"submit"}\n\n' +
      'event: result\ndata: {"tier":"A"}\n\n';
    expect(parseSse(text)).toEqual([
      { event: 'stage', data: { stage: 'bind' } },
      { event: 'stage', data: { stage: 'submit' } },
      { event: 'result', data: { tier: 'A' } },
    ]);
  });

  it('returns_an_empty_list_for_an_empty_body', () => {
    expect(parseSse('')).toEqual([]);
  });

  it('joins_multiple_data_lines_with_a_newline_before_parsing', () => {
    expect(parseSse('event: result\ndata: {"a":\ndata: 1}\n\n')).toEqual([
      { event: 'result', data: { a: 1 } },
    ]);
  });

  it('ignores_comment_keep_alive_blocks_and_lines', () => {
    const text = ': keep-alive\n\nevent: stage\n: inline comment\ndata: {"stage":"bind"}\n\n';
    expect(parseSse(text)).toEqual([{ event: 'stage', data: { stage: 'bind' } }]);
  });

  it('accepts_crlf_line_endings', () => {
    expect(parseSse('event: result\r\ndata: {"tier":"B"}\r\n\r\n')).toEqual([
      { event: 'result', data: { tier: 'B' } },
    ]);
  });

  it('tolerates_a_missing_space_after_the_colon', () => {
    expect(parseSse('event:error\ndata:{"code":"x"}\n\n')).toEqual([
      { event: 'error', data: { code: 'x' } },
    ]);
  });

  it('parses_a_final_event_without_a_trailing_blank_line', () => {
    expect(parseSse('event: result\ndata: {"tier":"C"}')).toEqual([
      { event: 'result', data: { tier: 'C' } },
    ]);
  });

  it('throws_on_malformed_json', () => {
    expect(() => parseSse('event: result\ndata: {not json}\n\n')).toThrow(SyntaxError);
  });

  it('keeps_the_order_of_events', () => {
    const events = parseSse(
      'event: stage\ndata: {"stage":"bind"}\n\nevent: error\ndata: {"code":"boom","stage":"evaluate"}\n\n',
    );
    expect(events.map((e) => e.event)).toEqual(['stage', 'error']);
  });
});
