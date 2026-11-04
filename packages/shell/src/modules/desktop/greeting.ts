// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// GREETING — time-aware, lightly varied welcome messages for the desktop
// =============================================================================
//
// Merged from home-ui's name-templated pools and hello-ui's nameless pools:
// with a first name the personalised lines are used, without one the
// nameless (and launch-flavored) lines are.

type TimeBucket = 'morning' | 'afternoon' | 'evening' | 'night';

/** Map a 0–23 hour to a part-of-day bucket. */
function getTimeBucket(hour: number): TimeBucket {
	if (hour >= 5 && hour < 12) return 'morning';
	if (hour >= 12 && hour < 17) return 'afternoon';
	if (hour >= 17 && hour < 22) return 'evening';
	return 'night';
}

// Named pools — `{name}` is substituted with the user's first name. Each
// bucket is concatenated with the always-available `any` pool before a random
// pick, so a fraction of greetings are time-neutral even at, say, 8am.
const NAMED: Record<TimeBucket | 'any', readonly string[]> = {
	morning: [
		'Good morning, {name}.',
		'Morning, {name} — fresh start.',
		'Rise and shine, {name}.',
		'A new day, {name}.',
	],
	afternoon: [
		'Good afternoon, {name}.',
		'Afternoon, {name}.',
		"Hope the day's treating you well, {name}.",
	],
	evening: [
		'Good evening, {name}.',
		'Evening, {name}.',
		'Winding down, {name}?',
	],
	night: [
		'Burning the midnight oil, {name}?',
		'Still up, {name}?',
		'Late one tonight, {name}?',
	],
	any: [
		'Welcome back, {name}.',
		'Good to see you, {name}.',
		'Ready when you are, {name}.',
		"Let's get to it, {name}.",
	],
};

// Nameless pools — for hosts without an identity display name (the OSS
// identity is always "RocketRide", so a personalised greeting reads oddly).
const NAMELESS: Record<TimeBucket | 'any', readonly string[]> = {
	morning: [
		'Good morning.',
		'Morning. Fresh start.',
		'Rise and shine.',
		'A perfect morning for a launch.',
	],
	afternoon: [
		'Good afternoon.',
		"Hope the day's treating you well.",
		'Cruising through the afternoon.',
	],
	evening: [
		'Good evening.',
		'Winding down?',
		'Quiet evening for a flight?',
	],
	night: [
		'Burning the midnight oil?',
		'Still up?',
		'Late one tonight?',
	],
	any: [
		'Welcome back.',
		'Good to see you.',
		'Ready when you are.',
		"Let's get to it.",
		'Wanna take a ride?',
		'All systems go.',
		'Ready for liftoff?',
	],
};

/**
 * Build a greeting for the desktop page. Picks at random from the current
 * time-of-day pool combined with the time-neutral pool, so it stays fresh on
 * reload while still skewing to the local hour.
 *
 * @param firstName - User's first name; omitted → the nameless pools.
 * @param now - Current time — injectable for testing; defaults to new Date().
 * @returns Greeting sentence.
 */
export function getGreeting(firstName?: string, now: Date = new Date()): string {
	const pools = firstName ? NAMED : NAMELESS;
	const pool = [...pools[getTimeBucket(now.getHours())], ...pools.any];
	const message = pool[Math.floor(Math.random() * pool.length)];
	return firstName ? message.replace('{name}', firstName) : message;
}
