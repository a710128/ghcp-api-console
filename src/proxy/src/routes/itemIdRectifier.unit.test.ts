import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ItemIdRectifier, rewriteEventText } from './compatible.js';

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}`;
}

function dataOf(eventText: string): Record<string, unknown> {
  const line = eventText.split(/\r?\n/).find((l) => l.startsWith('data:'));
  assert.ok(line, 'event has a data line');
  return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
}

describe('ItemIdRectifier', () => {
  it('normalizes rotated ids of the same output_index to the first-seen id', () => {
    const r = new ItemIdRectifier();
    const added = rewriteEventText(
      event('response.output_item.added', { output_index: 0, item: { id: 'first', type: 'reasoning' } }),
      r,
    );
    const partAdded = rewriteEventText(
      event('response.reasoning_summary_part.added', { output_index: 0, item_id: 'rotated-1', summary_index: 0 }),
      r,
    );
    const done = rewriteEventText(
      event('response.output_item.done', { output_index: 0, item: { id: 'rotated-2', type: 'reasoning' } }),
      r,
    );

    assert.equal((dataOf(added).item as { id: string }).id, 'first');
    assert.equal(dataOf(partAdded).item_id, 'first');
    assert.equal((dataOf(done).item as { id: string }).id, 'first');
  });

  it('keeps distinct output_index values independent', () => {
    const r = new ItemIdRectifier();
    rewriteEventText(event('response.output_item.added', { output_index: 0, item: { id: 'id-0' } }), r);
    rewriteEventText(event('response.output_item.added', { output_index: 1, item: { id: 'id-1' } }), r);
    const done1 = rewriteEventText(event('response.output_item.done', { output_index: 1, item: { id: 'rot' } }), r);
    assert.equal((dataOf(done1).item as { id: string }).id, 'id-1');
  });

  it('passes through events without output_index untouched', () => {
    const r = new ItemIdRectifier();
    const created = event('response.created', { response: { id: 'resp_1' } });
    assert.equal(rewriteEventText(created, r), created);
    const doneEvt = 'event: message\ndata: [DONE]';
    assert.equal(rewriteEventText(doneEvt, r), doneEvt);
  });

  it('does not touch non-id fields (encrypted_content, call_id, delta)', () => {
    const r = new ItemIdRectifier();
    rewriteEventText(event('response.output_item.added', { output_index: 0, item: { id: 'canon' } }), r);
    const rewritten = rewriteEventText(
      event('response.output_item.done', {
        output_index: 0,
        item: { id: 'rotated', encrypted_content: 'blob==', call_id: 'call_abc' },
        delta: 'hello',
      }),
      r,
    );
    const data = dataOf(rewritten);
    assert.equal((data.item as { id: string }).id, 'canon');
    assert.equal((data.item as { encrypted_content: string }).encrypted_content, 'blob==');
    assert.equal((data.item as { call_id: string }).call_id, 'call_abc');
    assert.equal(data.delta, 'hello');
  });

  it('leaves the first occurrence of an output_index unchanged', () => {
    const r = new ItemIdRectifier();
    const added = event('response.output_item.added', { output_index: 2, item: { id: 'original' } });
    assert.equal(rewriteEventText(added, r), added);
  });

  it('preserves CRLF line endings when rewriting', () => {
    const r = new ItemIdRectifier();
    rewriteEventText('event: response.output_item.added\r\ndata: {"output_index":0,"item":{"id":"canon"}}', r);
    const out = rewriteEventText('event: response.output_item.done\r\ndata: {"output_index":0,"item":{"id":"rot"}}', r);
    assert.match(out, /^event: response\.output_item\.done\r\ndata: /);
    assert.equal((dataOf(out).item as { id: string }).id, 'canon');
  });

  it('resets mapping after response.completed so a new response starts fresh', () => {
    const r = new ItemIdRectifier();
    rewriteEventText(event('response.output_item.added', { output_index: 0, item: { id: 'a' } }), r);
    r.reset();
    const secondAdded = event('response.output_item.added', { output_index: 0, item: { id: 'b' } });
    assert.equal(rewriteEventText(secondAdded, r), secondAdded);
    const secondDone = rewriteEventText(event('response.output_item.done', { output_index: 0, item: { id: 'c' } }), r);
    assert.equal((dataOf(secondDone).item as { id: string }).id, 'b');
  });
});
