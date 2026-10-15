import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeCapabilities } from './types.js';
import { resolveSettings, snapshot, UnsupportedSettingError } from './types.js';
import { LOCK_STALE_MS, maxLockedOperationMs } from '../core/store.js';

const CONTROLLABLE: RuntimeCapabilities = {
  runtime: 'claude-web',
  subscriptionId: 'claude-max',
  supportsModelSelection: true,
  supportsEffortSelection: true,
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  reportsEffectiveSettings: true,
  acceptsCallerSessionId: true,
  skillInvocationForm: '/manifest-dev:auto <task>',
};

const VENDOR_CONTROLLED: RuntimeCapabilities = {
  runtime: 'codex-cloud',
  subscriptionId: 'openai-codex',
  supportsModelSelection: false,
  supportsEffortSelection: false,
  effortLevels: [],
  reportsEffectiveSettings: false,
  acceptsCallerSessionId: false,
  skillInvocationForm: 'task prompt',
};

describe('operations under the admission lock stay inside its staleness window', () => {
  it('bounds a locked operation below the point a waiter may break the lock', () => {
    // Nothing refreshes the lock file while a critical section runs, so an
    // operation slower than LOCK_STALE_MS lets a waiting dispatcher break the lock
    // and enter admission alongside the holder — both seeing the same headroom.
    assert.ok(maxLockedOperationMs() < LOCK_STALE_MS,
      'a locked operation must finish before the lock can be broken');
    assert.ok(maxLockedOperationMs() > 0);
  });

  it('leaves room for the rest of the critical section', () => {
    assert.ok(LOCK_STALE_MS - maxLockedOperationMs() >= 10_000,
      'the slow part must not consume the whole window');
  });
});

describe('settings on a controllable runtime', () => {
  it('takes the requested model and effort', () => {
    const r = resolveSettings(CONTROLLABLE, { model: 'opus', effort: 'high' });
    assert.deepEqual(r, { model: 'opus', effort: 'high' });
  });

  it('falls back to the configured default when nothing is requested', () => {
    const r = resolveSettings(CONTROLLABLE, {}, { model: 'sonnet', effort: 'medium' });
    assert.deepEqual(r, { model: 'sonnet', effort: 'medium' });
  });

  it('lets a run override the default', () => {
    const r = resolveSettings(CONTROLLABLE, { effort: 'max' }, { model: 'sonnet', effort: 'low' });
    assert.deepEqual(r, { model: 'sonnet', effort: 'max' });
  });

  it('rejects an effort level the runtime does not have', () => {
    assert.throws(
      () => resolveSettings(CONTROLLABLE, { effort: 'ultra' }),
      (e: unknown) => e instanceof UnsupportedSettingError && e.field === 'effort',
    );
  });

  it('says effort names are runtime-specific rather than mapping them', () => {
    // Pi has "minimal"; Claude does not. A shared numeric scale would silently
    // translate it, which is what the contract forbids.
    assert.throws(
      () => resolveSettings(CONTROLLABLE, { effort: 'minimal' }),
      /not points on a shared scale/,
    );
  });
});

describe('settings on a vendor-controlled runtime', () => {
  it('refuses a specific model request', () => {
    assert.throws(
      () => resolveSettings(VENDOR_CONTROLLED, { model: 'gpt-5.5', acceptVendorDefault: true }),
      (e: unknown) => e instanceof UnsupportedSettingError && e.field === 'model',
    );
  });

  it('refuses a specific effort request', () => {
    assert.throws(
      () => resolveSettings(VENDOR_CONTROLLED, { effort: 'high', acceptVendorDefault: true }),
      (e: unknown) => e instanceof UnsupportedSettingError && e.field === 'effort',
    );
  });

  it('refuses to run at all unless the profile explicitly accepts vendor-default', () => {
    assert.throws(
      () => resolveSettings(VENDOR_CONTROLLED, {}),
      /must explicitly accept vendor-default/,
    );
  });

  it('runs when the profile explicitly accepts vendor-default', () => {
    const r = resolveSettings(VENDOR_CONTROLLED, { acceptVendorDefault: true });
    assert.deepEqual(r, { model: 'vendor-default', effort: 'vendor-default' });
  });

  it('an unsupported specific request cannot fall back into vendor-default mode', () => {
    // The failure mode the contract names: asking for something specific, being
    // refused, and having the system quietly run it as vendor-default instead.
    assert.throws(
      () => resolveSettings(VENDOR_CONTROLLED, { model: 'gpt-5.5', acceptVendorDefault: true }),
      UnsupportedSettingError,
    );
  });
});

// Holds the decision in docs/adr/20261015-unconfirmed-run-settings-are-unknown.md.
describe('what a run records about what actually ran', () => {
  it('records unknown where the vendor reports nothing', () => {
    const resolved = resolveSettings(VENDOR_CONTROLLED, { acceptVendorDefault: true });
    const s = snapshot(VENDOR_CONTROLLED, { acceptVendorDefault: true }, resolved);
    assert.deepEqual(s.observed, { model: 'unknown', effort: 'unknown' });
    assert.notEqual(s.observed.model, s.resolved.model, 'unknown must not echo the request');
  });

  it('keeps unknown even when a caller passes a guess', () => {
    const resolved = resolveSettings(VENDOR_CONTROLLED, { acceptVendorDefault: true });
    const s = snapshot(VENDOR_CONTROLLED, { acceptVendorDefault: true }, resolved, { model: 'gpt-5.5' });
    assert.equal(s.observed.model, 'unknown', 'a runtime that reports nothing yields nothing');
  });

  it('records the effective settings where the vendor does report them', () => {
    const resolved = resolveSettings(CONTROLLABLE, { model: 'opus', effort: 'high' });
    const s = snapshot(CONTROLLABLE, { model: 'opus', effort: 'high' }, resolved, {
      model: 'opus', effort: 'high',
    });
    assert.deepEqual(s.observed, { model: 'opus', effort: 'high' });
    assert.equal(s.substitution, undefined);
  });

  it('flags a vendor substitution instead of hiding it', () => {
    const resolved = resolveSettings(CONTROLLABLE, { model: 'opus', effort: 'high' });
    const s = snapshot(CONTROLLABLE, { model: 'opus', effort: 'high' }, resolved, {
      model: 'sonnet', effort: 'high',
    });
    assert.match(s.substitution ?? '', /ran model "sonnet" where "opus" was resolved/);
  });
});
