// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DESKTOP QUOTES — AI-leader quotes rotated in the desktop header
// =============================================================================
//
// The rotation derives from the wall clock, so it is deterministic and
// identical across clients/tabs: every QUOTE_INTERVAL_S-second bucket maps to
// the next quote.

import type { DesktopQuote } from './types';

/** Seconds each quote stays on screen before the rotation advances. */
export const QUOTE_INTERVAL_S = 30;

/** AI-leader quotes cycled in the desktop header, oldest first. */
export const DESKTOP_QUOTES: DesktopQuote[] = [
	{ quote: 'With artificial intelligence, we are summoning the demon.', who: 'Elon Musk', audience: 'MIT Aeronautics and Astronautics Centennial Symposium', date: 'October 2014' },
	{ quote: 'Solve intelligence, and then use that to solve everything else.', who: 'Demis Hassabis', audience: "DeepMind's founding mission statement", date: 'Early 2010s' },
	{ quote: 'Worrying about evil AI is like worrying about overpopulation on Mars.', who: 'Andrew Ng', audience: 'GPU Technology Conference', date: 'March 2015' },
	{ quote: "AI will probably most likely lead to the end of the world, but in the meantime, there'll be great companies.", who: 'Sam Altman', audience: 'Tech conference audience', date: 'June 2015' },
	{ quote: 'People should stop training radiologists now.', who: 'Geoffrey Hinton', audience: 'Creative Destruction Lab conference, Toronto', date: '2016' },
	{ quote: 'If intelligence is a cake, the bulk of the cake is unsupervised learning, the icing on the cake is supervised learning, and the cherry on the cake is reinforcement learning.', who: 'Yann LeCun', audience: 'NIPS keynote', date: 'December 2016' },
	{ quote: 'AI is the new electricity.', who: 'Andrew Ng', audience: 'Stanford Graduate School of Business', date: 'January 2017' },
	{ quote: '2029 is the consistent date I have predicted for when an AI will pass a valid Turing test and therefore achieve human levels of intelligence.', who: 'Ray Kurzweil', audience: 'SXSW', date: 'March 2017' },
	{ quote: 'Software is eating the world, but AI is going to eat software.', who: 'Jensen Huang', audience: 'MIT Technology Review interview', date: 'May 2017' },
	{ quote: "I think people who are naysayers and try to drum up these doomsday scenarios… I think it's pretty irresponsible.", who: 'Mark Zuckerberg', audience: 'Facebook Live', date: 'July 2017' },
	{ quote: "I've talked to Mark about this. His understanding of the subject is limited.", who: 'Elon Musk', audience: 'Twitter reply to Zuckerberg', date: 'July 2017' },
	{ quote: 'Neural networks are not just another classifier, they represent the beginning of a fundamental shift in how we write software.', who: 'Andrej Karpathy', audience: '"Software 2.0" essay on Medium', date: 'November 2017' },
	{ quote: "AI is one of the most important things humanity is working on. It is more profound than, I dunno, electricity or fire.", who: 'Sundar Pichai', audience: 'MSNBC/Recode town hall', date: 'January 2018' },
	{ quote: "There's nothing artificial about AI. It's inspired by people, it's created by people, and most importantly, it impacts people.", who: 'Fei-Fei Li', audience: 'U.S. House Science Committee testimony', date: 'June 2018' },
	{ quote: 'General methods that leverage computation are ultimately the most effective, and by a large margin.', who: 'Rich Sutton', audience: '"The Bitter Lesson" blog essay', date: 'March 2019' },
	{ quote: "It may be that today's large neural networks are slightly conscious.", who: 'Ilya Sutskever', audience: 'Twitter', date: 'February 2022' },
	{ quote: 'The hottest new programming language is English.', who: 'Andrej Karpathy', audience: 'Twitter', date: 'January 2023' },
	{ quote: 'I want people to know that we made them dance.', who: 'Satya Nadella', audience: 'The Verge interview (about Google)', date: 'February 2023' },
	{ quote: 'The development of AI is as fundamental as the creation of the microprocessor, the personal computer, the Internet, and the mobile phone.', who: 'Bill Gates', audience: '"The Age of AI Has Begun" on GatesNotes', date: 'March 2023' },
	{ quote: "I console myself with the normal excuse: If I hadn't done it, somebody else would have.", who: 'Geoffrey Hinton', audience: 'New York Times interview', date: 'May 2023' },
	{ quote: 'If this technology goes wrong, it can go quite wrong.', who: 'Sam Altman', audience: 'U.S. Senate Judiciary Subcommittee', date: 'May 2023' },
	{ quote: 'Mitigating the risk of extinction from AI should be a global priority alongside other societal-scale risks such as pandemics and nuclear war.', who: 'Statement on AI Risk (signed by Altman, Hassabis, Amodei, Hinton and others)', audience: 'Center for AI Safety public statement', date: 'May 2023' },
	{ quote: 'Everybody in the world is now a programmer.', who: 'Jensen Huang', audience: 'World Government Summit, Dubai', date: 'February 2024' },
	{ quote: 'A country of geniuses in a datacenter.', who: 'Dario Amodei', audience: '"Machines of Loving Grace" essay', date: 'October 2024' },
	{ quote: "There's a new kind of coding I call 'vibe coding', where you fully give in to the vibes, embrace exponentials, and forget that the code even exists.", who: 'Andrej Karpathy', audience: 'X (formerly Twitter)', date: 'February 2025' },
	{ quote: 'We are past the event horizon; the takeoff has started.', who: 'Sam Altman', audience: '"The Gentle Singularity" blog post', date: 'June 2025' },
];

/**
 * Index of the quote to show right now, derived from the wall clock.
 *
 * @returns Index into {@link DESKTOP_QUOTES}.
 */
export const currentQuoteIndex = (): number =>
	Math.floor(Date.now() / (QUOTE_INTERVAL_S * 1000)) % DESKTOP_QUOTES.length;
