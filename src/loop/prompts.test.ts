import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PROMPT_STAGES, promptDigest, promptDigestOf, promptTemplate, PromptTemplateError, renderTemplate, reviewPrompt, WORK_CONTEXT_RULE,
} from './prompts.js';

describe('stage prompts carry a version', () => {
  it('a digest is stable for identical text and different for a one-character change', () => {
    const text = promptTemplate('review');
    assert.equal(promptDigestOf(text), promptDigestOf(`${text}`));
    assert.equal(promptDigest('review'), promptDigestOf(text));
    assert.notEqual(promptDigestOf(text), promptDigestOf(text.replace('Review', 'review')));
    assert.match(promptDigest('review'), /^[0-9a-f]{64}$/);
  });

  it('every stage has a template, each with its own digest', () => {
    const digests = PROMPT_STAGES.map((s) => promptDigest(s));
    assert.equal(new Set(digests).size, PROMPT_STAGES.length);
    for (const stage of PROMPT_STAGES) assert.match(promptTemplate(stage), /\{\{workContextRule\}\}/, `${stage} includes the work-context rule`);
  });

  it('renders a drafted template the same way, and refuses one that drops or invents a placeholder', () => {
    const input = { repo: 'o/r', pr: { number: 1, title: 't', body: 'b', base: 'dev' }, head: 'a'.repeat(40), outputPath: '/x.md' };
    assert.equal(reviewPrompt(input, promptTemplate('review')), reviewPrompt(input));
    const live = reviewPrompt(input);
    assert.match(live, /manifest-dev \/review-pr skill.*https:\/\/github\.com\/o\/r\/pull\/1/);
    assert.match(live, /REVIEW_RESULT head=aaaaaaaa/);
    const replay = reviewPrompt(input, promptTemplate('review'), 'replay');
    assert.doesNotMatch(replay, /Run the manifest-dev `\/review-pr`/);
    assert.match(replay, /side-effect-free replay/);
    assert.match(live, new RegExp(WORK_CONTEXT_RULE.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const dropped = promptTemplate('review').replace('{{workContext}}', '');
    assert.throws(() => reviewPrompt(input, dropped), PromptTemplateError);
    assert.throws(() => renderTemplate('{{nope}}', {}), /\{\{nope\}\}/);
  });
});
