import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSENT_PROMPT_DETAIL, decideAutoInstallConsent } from './autoInstallConsent';

// -----------------------------------------------------------------------------
// First answer — no recorded consent yet, so the prompt was shown.
// -----------------------------------------------------------------------------

test("'Install' grants and is remembered", () => {
	assert.deepEqual(decideAutoInstallConsent(undefined, 'Install'), { grant: true, persist: 'accepted' });
});

test('"Don\'t ask again" refuses and is remembered', () => {
	assert.deepEqual(decideAutoInstallConsent(undefined, "Don't ask again"), { grant: false, persist: 'declined' });
});

test("'Not now' refuses without being remembered, so the prompt returns", () => {
	// The branch most likely to regress silently: persisting here would turn a
	// one-off "not right now" into "never ask again".
	const decision = decideAutoInstallConsent(undefined, 'Not now');
	assert.equal(decision.grant, false);
	assert.equal(decision.persist, undefined);

	// A second activation still has nothing recorded, so it prompts again.
	assert.deepEqual(decideAutoInstallConsent(undefined, 'Install'), { grant: true, persist: 'accepted' });
});

test('dismissing the prompt behaves like "Not now"', () => {
	// showInformationMessage resolves undefined when the notification is
	// dismissed rather than clicked; that is not a durable answer either.
	assert.deepEqual(decideAutoInstallConsent(undefined, undefined), { grant: false });
});

// -----------------------------------------------------------------------------
// Recorded answer — the prompt is skipped entirely.
// -----------------------------------------------------------------------------

test("a recorded 'accepted' grants without prompting", () => {
	assert.deepEqual(decideAutoInstallConsent('accepted', undefined), { grant: true });
});

test("a recorded 'declined' refuses without prompting", () => {
	assert.deepEqual(decideAutoInstallConsent('declined', undefined), { grant: false });
});

test('a recorded answer wins over any choice passed alongside it', () => {
	// Guards the short-circuit: a stored answer must not be re-persisted or
	// overridden by a stale choice value.
	assert.deepEqual(decideAutoInstallConsent('declined', 'Install'), { grant: false });
	assert.deepEqual(decideAutoInstallConsent('accepted', "Don't ask again"), { grant: true });
});

// -----------------------------------------------------------------------------
// Prompt text — issue #1186 is about unannounced writes, so every write the
// Install path performs has to be named before the user accepts.
// -----------------------------------------------------------------------------

test('the prompt names every automatic write, including .gitignore', () => {
	assert.match(CONSENT_PROMPT_DETAIL, /\.rocketride\//);
	assert.match(CONSENT_PROMPT_DETAIL, /stub files/);
	assert.match(CONSENT_PROMPT_DETAIL, /\.gitignore/);
	assert.match(CONSENT_PROMPT_DETAIL, /\.env/);
});
