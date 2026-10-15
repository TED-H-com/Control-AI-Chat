import assert from 'node:assert/strict';
import test from 'node:test';
import { supportsReasoningEffort } from './reasoning-capability.js';

test('effort capability trusts explicit catalog data and narrowly upgrades legacy known models',()=>{
  assert.equal(supportsReasoningEffort('anthropic','claude-haiku-4-5-20251001',[]),false);
  assert.equal(supportsReasoningEffort('anthropic','claude-sonnet-5',[]),true);
  assert.equal(supportsReasoningEffort('xai','grok-4.3',[]),false);
  assert.equal(supportsReasoningEffort('xai','grok-4.5',[]),true);
  assert.equal(supportsReasoningEffort('openai','custom-reasoner',['reasoning']),true);
  assert.equal(supportsReasoningEffort('openrouter','reasoning-in-name',[]),false);
});
