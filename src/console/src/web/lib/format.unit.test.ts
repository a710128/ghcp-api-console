import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatNumber, tokenTotal, statusTone, summarizeJson } from './format.js';

describe('format utils', () => {
  describe('formatDate', () => {
    it('returns dash for undefined', () => {
      assert.strictEqual(formatDate(undefined), '-');
    });
    it('formats valid ISO date', () => {
      const result = formatDate('2024-01-15T12:00:00.000Z');
      assert.ok(result !== '-');
      assert.ok(result.length > 0);
    });
    it('returns input for invalid date', () => {
      assert.strictEqual(formatDate('not-a-date'), 'not-a-date');
    });
  });

  describe('formatNumber', () => {
    it('returns dash for undefined', () => {
      assert.strictEqual(formatNumber(undefined), '-');
    });
    it('formats number', () => {
      const result = formatNumber(1234567);
      assert.ok(result.length > 0);
      assert.ok(result !== '-');
    });
    it('returns dash for non-finite values', () => {
      assert.strictEqual(formatNumber(Number.NaN), '-');
      assert.strictEqual(formatNumber(Number.POSITIVE_INFINITY), '-');
    });
  });

  describe('tokenTotal', () => {
    it('sums all defined values', () => {
      assert.strictEqual(tokenTotal(100, 200, 50), 350);
    });
    it('skips undefined values', () => {
      assert.strictEqual(tokenTotal(100, undefined, 50), 150);
    });
    it('returns undefined when all undefined', () => {
      assert.strictEqual(tokenTotal(undefined, undefined, undefined), undefined);
    });
  });

  describe('statusTone', () => {
    it('success statuses map to success tone', () => {
      assert.strictEqual(statusTone('valid'), 'success');
      assert.strictEqual(statusTone('active'), 'success');
      assert.strictEqual(statusTone('assigned'), 'success');
      assert.strictEqual(statusTone('success'), 'success');
    });
    it('failed status maps to danger tone', () => {
      assert.strictEqual(statusTone('failed'), 'danger');
      assert.strictEqual(statusTone('deleted'), 'danger');
      assert.strictEqual(statusTone('cancelled'), 'danger');
    });
    it('running status maps to info tone', () => {
      assert.strictEqual(statusTone('running'), 'info');
      assert.strictEqual(statusTone('refreshing'), 'info');
      assert.strictEqual(statusTone('pending'), 'info');
    });
    it('unknown status maps to warning tone', () => {
      assert.strictEqual(statusTone('unknown'), 'warning');
      assert.strictEqual(statusTone('expired'), 'warning');
      assert.strictEqual(statusTone('missing'), 'warning');
      assert.strictEqual(statusTone('not_synced'), 'warning');
    });
    it('suspended status maps to muted tone', () => {
      assert.strictEqual(statusTone('suspended'), 'muted');
      assert.strictEqual(statusTone('unassigned'), 'muted');
      assert.strictEqual(statusTone('skipped'), 'muted');
    });
    it('unrecognized status maps to default tone', () => {
      assert.strictEqual(statusTone('notAStatus'), 'default');
      assert.strictEqual(statusTone(undefined), 'default');
    });
  });

  describe('summarizeJson', () => {
    it('returns dash for null', () => {
      assert.strictEqual(summarizeJson(null), '-');
    });
    it('returns dash for undefined', () => {
      assert.strictEqual(summarizeJson(undefined), '-');
    });
    it('returns string for number', () => {
      assert.strictEqual(summarizeJson(42), '42');
    });
    it('returns string for boolean', () => {
      assert.strictEqual(summarizeJson(true), 'true');
    });
    it('describes arrays by length', () => {
      const result = summarizeJson([1, 2, 3]);
      assert.ok(result.includes('3'));
    });
    it('summarizes objects', () => {
      const result = summarizeJson({ a: 1, b: 2 });
      assert.ok(result.includes('a'));
    });
  });
});
