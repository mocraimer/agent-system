import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LineFramer } from './jsonl.js';

describe('JSONL framing', () => {
  it('splits on LF', () => {
    const f = new LineFramer();
    assert.deepEqual(f.push('a\nb\n'), ['a', 'b']);
  });

  it('holds a partial record until its LF arrives', () => {
    const f = new LineFramer();
    assert.deepEqual(f.push('{"ty'), []);
    assert.deepEqual(f.push('pe":"x"}\n'), ['{"type":"x"}']);
  });

  it('strips a trailing CR', () => {
    const f = new LineFramer();
    assert.deepEqual(f.push('a\r\nb\r\n'), ['a', 'b']);
  });

  it('does not split on U+2028 or U+2029 inside a JSON string', () => {
    const f = new LineFramer();
    // Raw separators, written as escapes so the source itself stays one line.
    // JSON.stringify emits these unescaped, so a record really can contain them.
    const payload = { text: 'before\u2028middle\u2029after' };
    const record = JSON.stringify(payload);
    assert.ok(record.includes('\u2028'), 'precondition: the record carries a raw U+2028');
    const records = f.push(`${record}\n`);
    assert.equal(records.length, 1, 'a Unicode separator must not end a record');
    assert.deepEqual(JSON.parse(records[0]!), payload);
  });

  it('returns a trailing partial record on flush', () => {
    const f = new LineFramer();
    f.push('{"a":1}\n{"b":2}');
    assert.deepEqual(f.flush(), ['{"b":2}']);
  });
});
