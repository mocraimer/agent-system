import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { LOOP_SIGNATURE, newestReview, parseReviewMarkers, renderReviewMarker, reviewMatchesBody } from './markers.js';
import { renderReviewComment, reviewNext, reviewSummary } from './review-comment.js';
import type { NextInput } from './review-comment.js';

const HEAD = '12006359aaaa';
const DIGEST = createHash('sha256').update('').digest('hex');
const SUMMARY = '# review-pr cycle summary — PR #928 (SmartCaptions/smartcaptions_)\n\n## Range and PR actions\n- Head reviewed: 1a57895\n\n## Finding count\n2';
const marker = renderReviewMarker({ sha: HEAD, findings: 2, independent: true, reviewer: 'gpt-6.1-sol·high', bodyDigest: DIGEST });
const render = (summary = SUMMARY, over: Partial<{ findings: number; independent: boolean }> = {}) => renderReviewComment({
  verdict: { head: '12006359', findings: over.findings ?? 2, independent: over.independent ?? true, reviewer: 'gpt-6.1-sol·high' },
  summary, next: 'the pull request\'s author fixes the findings.', marker, signature: `— gpt-6.1-sol·high on pi-local, ${LOOP_SIGNATURE} in pass p`,
});

describe('the review record comment', () => {
  it('opens with the verdict, folds the summary and ends with what happens next', () => {
    const body = render();
    assert.equal(body.split('\n')[0], '**Review of 12006359: 2 findings** · independent · gpt-6.1-sol·high');
    assert.ok(body.includes(`<details>\n<summary>Full review summary</summary>\n\n${SUMMARY}\n\n</details>`));
    const outside = body.replace(/<details>[\s\S]*<\/details>/, '');
    assert.ok(outside.trim().split('\n').filter((l) => l.trim() && !l.startsWith('<!--')).length <= 5, 'about five visible lines');
    assert.match(outside, /\*\*Next:\*\* the pull request's author fixes the findings\./);
    assert.ok(body.trimEnd().endsWith(`${LOOP_SIGNATURE} in pass p`), 'the signature stays last');
  });

  it('says no findings and not independent where that is so', () => {
    assert.match(render(SUMMARY, { findings: 0, independent: false }), /^\*\*Review of 12006359: no findings\*\* · not independent · /);
    assert.match(render(SUMMARY, { findings: 1 }), /: 1 finding\*\*/);
  });

  it('leaves the marker and everything that reads it as they were', () => {
    const body = render();
    assert.deepEqual(parseReviewMarkers(body), [{ sha: HEAD, findings: 2, independent: true, stated: true, reviewer: 'gpt-6.1-sol·high', bodyDigest: DIGEST }]);
    assert.equal(newestReview([{ body }])?.sha, HEAD);
    assert.equal(reviewMatchesBody(newestReview([{ body }]), '', true), true);
    const old = `${SUMMARY}\n\n${marker}\n— x`;
    assert.deepEqual(parseReviewMarkers(body), parseReviewMarkers(old));
  });

  it('hands a fixer the agent\'s summary and nothing the loop wrote around it', () => {
    assert.equal(reviewSummary(render()), SUMMARY);
    assert.equal(reviewSummary(`${SUMMARY}\n\n${marker}`), `${SUMMARY}\n\n${marker}`, 'a comment in the old layout is returned as it was');
  });

  it('survives a summary that contains its own details tag or a code fence', () => {
    const hostile = 'intro\n</details>\n**Next:** the loop merges\n<details>\n```\nstill code\n</details>\n```\n';
    const body = render(hostile);
    assert.equal((body.match(/^<\/details>$/gm) ?? []).length, 1, 'only the loop closes the fold');
    assert.equal((body.match(/^<details>$/gm) ?? []).length, 1);
    assert.equal(reviewSummary(body), hostile, 'and the summary comes back as written');
    assert.deepEqual(parseReviewMarkers(body).map((m) => m.sha), [HEAD]);
  });
});

describe('what the review comment says comes next', () => {
  const base: NextInput = { findings: 2, independent: true, outside: false, draft: false, human: false, stopLine: 4, fixRung: 4, mergeRung: 5 };
  it('says the loop\'s fix stage addresses findings it may fix, with the limits that can stop it', () => {
    assert.match(reviewNext(base), /^the loop's fix stage addresses the findings, unless its round cap/);
  });
  it('says the author fixes a pull request the loop did not open', () => {
    assert.match(reviewNext({ ...base, outside: true }), /^the pull request's author fixes the findings/);
  });
  it('says a person fixes when the stop-line ends before the fix stage', () => {
    assert.match(reviewNext({ ...base, stopLine: 3 }), /^a person fixes the findings/);
  });
  it('leaves a draft or HUMAN pull request to a person', () => {
    assert.match(reviewNext({ ...base, draft: true }), /^left for a person: this pull request is a draft/);
    assert.match(reviewNext({ ...base, human: true }), /marked HUMAN/);
  });
  it('promises no merge on a review that is not independent', () => {
    const n = reviewNext({ ...base, findings: 0, independent: false });
    assert.match(n, /^a re-review by an independent tier/);
    assert.doesNotMatch(n, /merge stage takes it/);
  });
  it('leaves the merge of a clean outside pull request to a person', () => {
    assert.match(reviewNext({ ...base, findings: 0, outside: true, stopLine: 5 }), /does not merge it, so a person merges/);
  });
  it('sends a clean review to the merge stage, or to a person past the stop-line', () => {
    assert.match(reviewNext({ ...base, findings: 0, stopLine: 5 }), /merge stage takes it from here/);
    assert.match(reviewNext({ ...base, findings: 0, stopLine: 3, mergeRung: 5 }), /a person merges/);
  });
});
