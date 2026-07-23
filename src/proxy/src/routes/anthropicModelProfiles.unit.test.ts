import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAnthropicModelId,
  getAnthropicModelProfile,
} from './anthropicModelProfiles.js';

describe('normalizeAnthropicModelId', () => {
  it('strips a date suffix and merges the version numbers', () => {
    assert.equal(normalizeAnthropicModelId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4.5');
  });

  it('merges adjacent version numbers without a date suffix', () => {
    assert.equal(normalizeAnthropicModelId('claude-opus-4-8'), 'claude-opus-4.8');
  });

  it('leaves an already-normalized id unchanged', () => {
    assert.equal(normalizeAnthropicModelId('claude-sonnet-4.6'), 'claude-sonnet-4.6');
  });

  it('strips a date suffix from an already-dotted id', () => {
    assert.equal(normalizeAnthropicModelId('claude-sonnet-4.5-20250929'), 'claude-sonnet-4.5');
  });

  it('leaves a single-token id unchanged', () => {
    assert.equal(normalizeAnthropicModelId('gpt-5'), 'gpt-5');
  });
});

describe('getAnthropicModelProfile: claude-sonnet-4.6', () => {
  it('returns the all-thinking profile with matching canonicalId', () => {
    const profile = getAnthropicModelProfile('claude-sonnet-4.6');
    assert.equal(profile.canonicalId, 'claude-sonnet-4.6');
    assert.equal(profile.thinking, 'all');
    assert.equal(profile.supportsAdaptiveThinking, true);
    assert.deepEqual([...profile.acceptedEfforts], ['low', 'medium', 'high', 'max']);
  });

  it('normalizes a dated id to the same profile', () => {
    const profile = getAnthropicModelProfile('claude-sonnet-4-6-20250101');
    assert.equal(profile.canonicalId, 'claude-sonnet-4.6');
    assert.equal(profile.thinking, 'all');
  });
});

describe('getAnthropicModelProfile: claude-opus-4.8', () => {
  it('returns an adaptive-only profile with matching canonicalId', () => {
    const profile = getAnthropicModelProfile('claude-opus-4.8');
    assert.equal(profile.canonicalId, 'claude-opus-4.8');
    assert.equal(profile.thinking, 'adaptive-only');
    assert.equal(profile.acceptsMidConversationSystem, true);
    assert.equal(profile.supportsAdaptiveThinking, true);
  });

  it('resolves via the raw dated/hyphenated id form', () => {
    const profile = getAnthropicModelProfile('claude-opus-4-8');
    assert.equal(profile.canonicalId, 'claude-opus-4.8');
    assert.equal(profile.thinking, 'adaptive-only');
  });
});

describe('getAnthropicModelProfile: fallback rules', () => {
  it('falls back to enabled-only for a haiku model', () => {
    const profile = getAnthropicModelProfile('claude-haiku-9.9');
    assert.equal(profile.thinking, 'enabled-only');
    assert.ok([...profile.stripBetas].includes('context-1m-*'));
  });

  it('falls back to all-thinking for an unknown non-special model', () => {
    const profile = getAnthropicModelProfile('claude-mystery-9.9');
    assert.equal(profile.thinking, 'all');
  });
});
