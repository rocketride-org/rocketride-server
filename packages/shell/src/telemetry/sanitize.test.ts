import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type CaptureLike, sanitizeUrl, referrerOrigin, sanitizeEvent, reduceRecordedRequest, reduceHref, reduceSrcset, maskReplayAttribute, reduceUrlsInText, reduceStoredProps, redactSecretsInText, reduceCssUrls, CLICK_ID_KEYS, DERIVED_ID_KEYS } from './sanitize.ts';

test('sanitizeUrl keeps only utm_* query params and drops the fragment (table)', () => {
	const cases: Array<[string, string]> = [
		['https://cloud.rocketride.ai/?code=abc123&state=xyz', 'https://cloud.rocketride.ai/'],
		['https://cloud.rocketride.ai/pricing?utm_source=linkedin&utm_medium=paid-social&li_fat_id=9f&utm_id=42', 'https://cloud.rocketride.ai/pricing?utm_source=linkedin&utm_medium=paid-social&utm_id=42'],
		['https://cloud.rocketride.ai/?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig&utm_campaign=x', 'https://cloud.rocketride.ai/?utm_campaign=x'],
		['https://cloud.rocketride.ai/marketplace?appId=rocketride.pipeBuilder&auth=1', 'https://cloud.rocketride.ai/marketplace'],
		['https://cloud.rocketride.ai/#section-2', 'https://cloud.rocketride.ai/'],
		['https://cloud.rocketride.ai/pricing?utm_term=a%20b#faq', 'https://cloud.rocketride.ai/pricing?utm_term=a+b'],
		['https://cloud.rocketride.ai/?ref=someone&referrer=https%3A%2F%2Fx.test%2Fp', 'https://cloud.rocketride.ai/'],
		['https://cloud.rocketride.ai/?UTM_Source=Upper', 'https://cloud.rocketride.ai/'],
		['https://cloud.rocketride.ai/?utm_source=a&utm_source=b', 'https://cloud.rocketride.ai/?utm_source=a&utm_source=b'],
		['not a url', ''],
		['', ''],
	];
	for (const [input, expected] of cases) assert.equal(sanitizeUrl(input), expected, `sanitizeUrl(${input})`);
});

test('referrerOrigin reduces a referrer to scheme and host, keeps $direct and empty', () => {
	const cases: Array<[string, string]> = [
		['https://auth.rocketride.ai/ui/v2/login/loginname?requestId=V2_abc&organization=1', 'https://auth.rocketride.ai'],
		['https://www.google.com/search?q=rocketride', 'https://www.google.com'],
		['http://localhost:8080/some/path', 'http://localhost:8080'],
		['$direct', '$direct'],
		['', ''],
		['garbage', ''],
	];
	for (const [input, expected] of cases) assert.equal(referrerOrigin(input), expected, `referrerOrigin(${input})`);
});

test('sanitizeEvent rewrites every URL-bearing property, strips click ids, keeps utm, never throws', () => {
	const event = {
		event: '$pageview',
		properties: {
			$current_url: 'https://cloud.rocketride.ai/?code=abc&state=s&utm_source=li',
			$referrer: 'https://www.linkedin.com/feed/update/urn:li:activity:1?x=1',
			$referring_domain: 'www.linkedin.com',
			$pathname: '/',
			utm_source: 'li',
			li_fat_id: 'abc-def',
			gclid: 'g1',
			fbclid: null,
			page: 'landing',
			$set_once: { $initial_current_url: 'https://cloud.rocketride.ai/?code=abc', $initial_referrer: 'https://x.test/a?b=1', $initial_utm_source: 'li', $initial_gclid: 'g1' },
			$set: { $current_url: 'https://cloud.rocketride.ai/?code=abc', $referrer: 'https://x.test/a?b=1', utm_source: 'li', msclkid: 'm' },
		},
	};
	const out = sanitizeEvent(structuredClone(event) as CaptureLike)!;
	const p = out.properties as Record<string, unknown>;
	assert.equal(p.$current_url, 'https://cloud.rocketride.ai/?utm_source=li');
	assert.equal(p.$referrer, 'https://www.linkedin.com');
	assert.equal(p.$referring_domain, 'www.linkedin.com');
	assert.equal(p.utm_source, 'li');
	assert.equal(p.page, 'landing');
	assert.ok(!('li_fat_id' in p) && !('gclid' in p) && !('fbclid' in p), 'click ids removed from properties');
	const once = p.$set_once as Record<string, unknown>;
	assert.equal(once.$initial_current_url, 'https://cloud.rocketride.ai/');
	assert.equal(once.$initial_referrer, 'https://x.test');
	assert.equal(once.$initial_utm_source, 'li');
	assert.ok(!('$initial_gclid' in once), '$initial_ click ids removed');
	const set = p.$set as Record<string, unknown>;
	assert.equal(set.$current_url, 'https://cloud.rocketride.ai/');
	assert.equal(set.$referrer, 'https://x.test');
	assert.ok(!('msclkid' in set));
	// Pass-through shapes that must not throw.
	assert.equal(sanitizeEvent(null), null);
	assert.deepEqual(sanitizeEvent({ event: 'x' } as CaptureLike), { event: 'x' });
	assert.deepEqual(sanitizeEvent({ event: 'x', properties: null } as CaptureLike), { event: 'x', properties: null });
});

test('CLICK_ID_KEYS covers the ids seen in production URLs and never a utm key', () => {
	for (const k of ['li_fat_id', 'gclid', 'fbclid', 'msclkid', 'rdt_cid', 'mc_cid', '_kx', 'qclid', 'irclid', 'dclid', 'gclsrc', 'wbraid', 'gbraid', 'ttclid', 'igshid', 'twclid', 'sccid', 'epik', 'gad_source']) {
		assert.ok(CLICK_ID_KEYS.includes(k), `${k} is a click id`);
	}
	assert.ok(CLICK_ID_KEYS.every((k) => !k.startsWith('utm_')));
});

test('web vitals: every URL nested in the metric objects is reduced like the top-level URL', () => {
	const event = {
		event: '$web_vitals',
		properties: {
			$current_url: 'https://cloud.rocketride.ai/?utm_source=li&li_fat_id=lifat999',
			$web_vitals_LCP_value: 500,
			$web_vitals_LCP_event: { name: 'LCP', value: 500, navigationURL: 'https://cloud.rocketride.ai/?utm_source=li&li_fat_id=lifat999#x', $current_url: 'https://cloud.rocketride.ai/?li_fat_id=lifat999', attribution: { element: '#hero', url: 'https://cloud.rocketride.ai/img.webp?li_fat_id=lifat999', navigationEntry: { name: 'https://cloud.rocketride.ai/?code=abc&utm_campaign=c' } } },
			$web_vitals_INP_event: { name: 'INP', value: 40, attribution: { interactionTarget: 'button.rr-cta' } },
		},
	};
	const out = sanitizeEvent(structuredClone(event) as CaptureLike)!;
	const text = JSON.stringify(out);
	assert.ok(!text.includes('lifat999'), 'no click id anywhere in the payload');
	assert.ok(!text.includes('code=abc'), 'no OAuth code anywhere in the payload');
	const p = out.properties as Record<string, unknown>;
	const lcp = p.$web_vitals_LCP_event as Record<string, unknown>;
	assert.equal(lcp.navigationURL, 'https://cloud.rocketride.ai/?utm_source=li');
	assert.equal((lcp.attribution as Record<string, unknown>).element, '#hero', 'selectors are kept');
	assert.equal(((lcp.attribution as Record<string, unknown>).navigationEntry as Record<string, unknown>).name, 'https://cloud.rocketride.ai/?utm_campaign=c');
	assert.equal(((p.$web_vitals_INP_event as Record<string, unknown>).attribution as Record<string, unknown>).interactionTarget, 'button.rr-cta');
});

test('heatmap batches: the page URL keys are reduced; batches for the same reduced URL merge', () => {
	const event = { event: '$$heatmap', properties: { $heatmap_data: {
		'https://cloud.rocketride.ai/?utm_source=li&li_fat_id=lifat999': [{ x: 1, y: 2, type: 'click' }],
		'https://cloud.rocketride.ai/?li_fat_id=other&utm_source=li': [{ x: 3, y: 4, type: 'click' }],
		'https://cloud.rocketride.ai/pricing': [{ x: 5, y: 6, type: 'scroll' }],
		'about:srcdoc?token=abc': [{ x: 7, y: 8, type: 'click' }],
	} } };
	const out = sanitizeEvent(structuredClone(event) as CaptureLike)!;
	const data = (out.properties as Record<string, unknown>).$heatmap_data as Record<string, unknown[]>;
	assert.deepEqual(Object.keys(data).sort(), ['https://cloud.rocketride.ai/?utm_source=li', 'https://cloud.rocketride.ai/pricing']);
	assert.equal(data['https://cloud.rocketride.ai/?utm_source=li'].length, 2);
	assert.ok(!JSON.stringify(out).includes('lifat'));
});

test('autocapture and dead clicks: a data-rr-private element keeps no text or attributes; hrefs are reduced', () => {
	const event = { event: '$autocapture', properties: { $event_type: 'click', $el_text: 'Jane Doe', $elements_chain: 'span:text="Jane Doe"', $elements: [
		{ tag_name: 'span', $el_text: 'Jane Doe', 'attr__data-rr-private': '', attr__class: 'name' },
		{ tag_name: 'a', attr__href: 'https://cloud.rocketride.ai/account?token=abc&utm_source=x', $el_text: 'Account' },
	] } };
	const out = sanitizeEvent(structuredClone(event) as CaptureLike)!;
	const text = JSON.stringify(out);
	assert.ok(!text.includes('Jane Doe') && !text.includes('token=abc'));
	const els = (out.properties as Record<string, unknown>).$elements as Array<Record<string, unknown>>;
	assert.deepEqual(els[0], { tag_name: 'span' });
	assert.deepEqual(els[1], { tag_name: 'a' });
	const plain = { event: '$dead_click', properties: { $el_text: 'Pricing', $elements: [{ tag_name: 'a', attr__href: 'https://cloud.rocketride.ai/pricing?li_fat_id=1', $el_text: 'Pricing' }] } };
	const kept = sanitizeEvent(structuredClone(plain) as CaptureLike)!;
	const k = (kept.properties as Record<string, unknown>).$elements as Array<Record<string, unknown>>;
	assert.deepEqual(k[0], { tag_name: 'a', attr__href: 'https://cloud.rocketride.ai/pricing', $el_text: 'Pricing' }, 'public elements keep their text');
	assert.equal((kept.properties as Record<string, unknown>).$el_text, 'Pricing');
});

test('autocapture in production shape: the $elements_chain string; a private chain is dropped whole, hrefs in a public chain are reduced', () => {
	const priv = { event: '$autocapture', properties: { $event_type: 'click', $el_text: 'Jane Doe', $elements_chain: 'span.name:attr__data-rr-private=""nth-child="1"nth-of-type="1"text="Jane Doe";a:attr__href="https://cloud.rocketride.ai/account?token=abc"href="https://cloud.rocketride.ai/account?token=abc"nth-child="2"nth-of-type="1"' } };
	const out = sanitizeEvent(structuredClone(priv) as CaptureLike)!;
	const text = JSON.stringify(out);
	assert.ok(!text.includes('Jane Doe') && !text.includes('token=abc') && !('$elements_chain' in out.properties!) && !('$el_text' in out.properties!));
	const pub = { event: '$dead_click', properties: { $el_text: 'Pricing', $elements_chain: 'a.nav:attr__href="https://cloud.rocketride.ai/pricing?li_fat_id=1&utm_source=x"href="https://cloud.rocketride.ai/pricing?li_fat_id=1&utm_source=x"nth-child="1"nth-of-type="1"text="Pricing";nav:nth-child="1"nth-of-type="1"' } };
	const kept = sanitizeEvent(structuredClone(pub) as CaptureLike)!;
	assert.equal((kept.properties as Record<string, unknown>).$elements_chain, 'a.nav:attr__href="https://cloud.rocketride.ai/pricing?utm_source=x"href="https://cloud.rocketride.ai/pricing?utm_source=x"nth-child="1"nth-of-type="1"text="Pricing";nav:nth-child="1"nth-of-type="1"');
	assert.equal((kept.properties as Record<string, unknown>).$el_text, 'Pricing');
	const relative = { event: '$rageclick', properties: { $elements_chain: 'a:href="#privacy-settings"nth-child="1"nth-of-type="1"text="Privacy settings"' } };
	assert.equal((sanitizeEvent(structuredClone(relative) as CaptureLike)!.properties as Record<string, unknown>).$elements_chain, relative.properties.$elements_chain, 'relative hrefs are untouched');
});

test('a persistent instance adds session-entry properties: the URL is reduced, the referrer host-only, click ids dropped', () => {
	const event = { event: '$autocapture', properties: {
		$session_entry_url: 'https://cloud.rocketride.ai/?utm_source=li&li_fat_id=lifat999&gclid=g1',
		$session_entry_referrer: 'https://www.linkedin.com/feed/?x=1',
		$session_entry_referring_domain: 'www.linkedin.com',
		$session_entry_utm_source: 'li',
		$session_entry_li_fat_id: 'lifat999',
		$session_entry_gclid: 'g1',
		$session_entry_pathname: '/',
	} };
	const out = sanitizeEvent(structuredClone(event) as CaptureLike)!;
	const p = out.properties as Record<string, unknown>;
	assert.equal(p.$session_entry_url, 'https://cloud.rocketride.ai/?utm_source=li');
	assert.equal(p.$session_entry_referrer, 'https://www.linkedin.com');
	assert.equal(p.$session_entry_utm_source, 'li');
	assert.equal(p.$session_entry_pathname, '/');
	assert.ok(!('$session_entry_li_fat_id' in p) && !('$session_entry_gclid' in p));
	assert.ok(!JSON.stringify(out).includes('lifat999'));
});

test('values derived from click ids or a referrer query ($fbc, $fbp, ph_keyword) are dropped everywhere; $search_engine stays', () => {
	const e = sanitizeEvent({
		event: '$pageview',
		properties: { $fbc: 'fb.1.1700000000000.FBCLIDVALUE', $fbp: 'fb.1.1700000000000.123', ph_keyword: 'rocketride pricing', $search_engine: 'bing', $initial_ph_keyword: 'x', utm_source: 'meta' },
		$set: { $fbc: 'fb.1.1700000000000.FBCLIDVALUE', $fbp: 'fb.1.1.2' },
		$set_once: { $initial_ph_keyword: 'rocketride pricing' },
	});
	assert.deepEqual(e.properties, { $search_engine: 'bing', utm_source: 'meta' });
	assert.deepEqual(e.$set, {});
	assert.deepEqual(e.$set_once, {});
	assert.ok(DERIVED_ID_KEYS.every((k) => !k.startsWith('utm_')));
});

test('reduceRecordedRequest: a page address the recorder writes keeps only utm_* and no fragment; other fields pass through', () => {
	const req = { name: 'https://cloud.rocketride.ai/?utm_source=newsletter&mkt_tok=abc&email=a%40b.test#frag', initiatorType: 'navigation' };
	assert.deepEqual(reduceRecordedRequest(req), { name: 'https://cloud.rocketride.ai/?utm_source=newsletter', initiatorType: 'navigation' });
	assert.deepEqual(reduceRecordedRequest({ name: undefined }), { name: undefined });
	assert.deepEqual(reduceRecordedRequest({ name: 'not a url' }), { name: '' }, 'an unparsable address is dropped, not kept');
});

test('reduceRecordedRequest: a request it cannot read is dropped (null), never recorded as it came', () => {
	const unreadable = { get name(): string { throw new Error('unreadable'); } };
	assert.equal(reduceRecordedRequest(unreadable), null);
});

test('reduceRecordedRequest: headers, bodies and server timings are removed whatever the project settings say', () => {
	const req = {
		name: 'https://cloud.rocketride.ai/api/x?token=s3cret&utm_medium=m',
		method: 'POST', status: 200, startTime: 1, endTime: 2,
		requestHeaders: { authorization: 'Bearer s3cret', cookie: 'a=b' },
		responseHeaders: { 'set-cookie': 'c=d' },
		requestBody: '{"email":"a@b.test"}',
		responseBody: '{"token":"s3cret"}',
		serverTimings: [{ name: 'db', description: 's3cret' }],
	};
	const out = reduceRecordedRequest(req) as Record<string, unknown>;
	assert.deepEqual(out, { name: 'https://cloud.rocketride.ai/api/x?utm_medium=m', method: 'POST', status: 200, startTime: 1, endTime: 2 });
	assert.equal(JSON.stringify(out).includes('s3cret'), false);
	assert.equal(JSON.stringify(out).includes('a@b.test'), false);
});

test('sanitizeUrl drops user and password', () => {
	assert.equal(sanitizeUrl('https://user:pa55@cloud.rocketride.ai/p?utm_source=a&k=v'), 'https://cloud.rocketride.ai/p?utm_source=a');
});

test('reduceHref: absolute, protocol-relative, relative, other schemes and anchors (table)', () => {
	const cases: Array<[string, string]> = [
		['https://cloud.rocketride.ai/p?code=x&utm_source=a#t=1', 'https://cloud.rocketride.ai/p?utm_source=a'],
		['//cdn.example.test/i.png?sig=abc', '//cdn.example.test/i.png'],
		['/pricing?plan=pro&utm_campaign=c', '/pricing?utm_campaign=c'],
		['pricing?email=a%40b.test', 'pricing'],
		['/#privacy-settings', '/#privacy-settings'],
		['#faq', '#faq'],
		['/cb#access_token=abc&state=s', '/cb'],
		['?state=s', ''],
		['mailto:hello@rocketride.ai?subject=Hi&body=x', 'mailto:hello@rocketride.ai'],
		['tel:+1555?x=1', 'tel:+1555'],
		['data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
		['https://fonts.googleapis.com/css2?family=Inter:wght@400', 'https://fonts.googleapis.com/css2?family=Inter:wght@400'],
		['', ''],
	];
	for (const [input, expected] of cases) assert.equal(reduceHref(input), expected, `reduceHref(${input})`);
	assert.equal(reduceSrcset('/a.png?sig=1 1x, https://x.test/b.png?t=2&utm_source=s 2x'), '/a.png 1x, https://x.test/b.png?utm_source=s 2x');
});

test('maskReplayAttribute: every address in an element attribute is reduced; other attributes pass; never throws', () => {
	assert.equal(maskReplayAttribute('href', '/x?token=abc'), '/x');
	assert.equal(maskReplayAttribute('SRC', 'https://img.test/a.png?sig=1'), 'https://img.test/a.png');
	assert.equal(maskReplayAttribute('srcset', 'a.png?s=1 1x'), 'a.png 1x');
	assert.equal(maskReplayAttribute('style', 'background:url("/bg.png?sig=1") no-repeat'), 'background:url("/bg.png") no-repeat');
	assert.equal(maskReplayAttribute('content', 'https://cloud.rocketride.ai/?email=a%40b.test'), 'https://cloud.rocketride.ai/');
	assert.equal(maskReplayAttribute('data-target', 'https://x.test/?k=v'), 'https://x.test/');
	assert.equal(maskReplayAttribute('class', 'btn primary'), 'btn primary');
	assert.equal(maskReplayAttribute('aria-label', 'Get Started?'), 'Get Started?');
	assert.equal(maskReplayAttribute('href', ''), '');
});

test('reduceUrlsInText: addresses in free text (exception messages, frames) keep only utm_*', () => {
	assert.equal(reduceUrlsInText('fetch failed: https://cloud.rocketride.ai/api?token=abc&utm_source=s (500)'), 'fetch failed: https://cloud.rocketride.ai/api?utm_source=s (500)');
	assert.equal(reduceUrlsInText('GET /api/me?email=a%40b.test failed'), 'GET /api/me failed');
	assert.equal(reduceUrlsInText('redirect /cb#access_token=abc lost'), 'redirect /cb lost');
	assert.equal(reduceUrlsInText('wss://engine.test/socket?key=abc closed'), 'wss://engine.test/socket closed');
	assert.equal(reduceUrlsInText('Are you sure? yes'), 'Are you sure? yes');
	assert.equal(reduceUrlsInText('at f (https://cloud.rocketride.ai/apps/x/static/js/1.js?v=2:10:5)'), 'at f (https://cloud.rocketride.ai/apps/x/static/js/1.js)');
});

test('sanitizeEvent: an exception report keeps no query or token from its messages and frames', () => {
	const e = sanitizeEvent({ event: '$exception', properties: {
		$exception_list: [{ type: 'Error', value: 'boom https://x.test/?token=abc&utm_source=s', stacktrace: { frames: [{ filename: 'https://cloud.rocketride.ai/a.js?sig=q', abs_path: '/a.js?sig=q', lineno: 1 }] } }],
		$exception_message: 'see /p?email=a%40b.test',
	} } as CaptureLike) as { properties: Record<string, unknown> };
	const text = JSON.stringify(e.properties);
	for (const leak of ['token=abc', 'sig=q', 'a%40b.test']) assert.equal(text.includes(leak), false, leak);
	assert.ok(text.includes('utm_source=s'));
	assert.ok(text.includes('"lineno":1'));
});

test('sanitizeEvent: relative hrefs and address attributes in a click chain are reduced', () => {
	const e = sanitizeEvent({ event: '$autocapture', properties: {
		$elements_chain: 'a.nav:attr__href="/pricing?plan=pro&utm_source=s"attr__data-url="https://x.test/?k=v"href="/pricing?plan=pro&utm_source=s"nth-child="1"',
		$elements: [{ tag_name: 'a', attr__href: '/x?token=abc', href: '/x?token=abc', 'attr__data-url': 'https://x.test/?k=v' }],
	} } as CaptureLike) as { properties: Record<string, unknown> };
	assert.equal(e.properties.$elements_chain, 'a.nav:attr__href="/pricing?utm_source=s"attr__data-url="https://x.test/"href="/pricing?utm_source=s"nth-child="1"');
	assert.deepEqual(e.properties.$elements, [{ tag_name: 'a', attr__href: '/x', href: '/x', 'attr__data-url': 'https://x.test/' }]);
});

test('sanitizeEvent fails closed: an event it cannot process is dropped, never sent as it was', () => {
	const hostile = { event: '$pageview', properties: new Proxy({ $current_url: 'https://x.test/?token=abc' }, { ownKeys: () => { throw new Error('boom'); } }) };
	assert.equal(sanitizeEvent(hostile as CaptureLike), null);
});

test('reduceStoredProps: stored visit addresses and referrers reduced, click and Meta ids not stored', () => {
	const out = reduceStoredProps({
		$initial_person_info: { u: 'https://cloud.rocketride.ai/?email=a%40b.test&utm_source=s#t=1', r: 'https://mail.test/inbox?u=secret' },
		$client_session_props: { sessionId: 's1', props: { u: 'https://cloud.rocketride.ai/p?code=c', r: '$direct' } },
		$referrer: 'https://www.google.com/search?q=secret', $referring_domain: 'www.google.com',
		utm_source: 's', gclid: 'g', $fbc_persistence: { value: 'fb.1.1.x' }, $fbp_persistence: { value: 'fb.1.1.y' }, ph_keyword: 'secret',
		distinct_id: 'd1', $session_entry_url: 'https://cloud.rocketride.ai/?k=v',
	});
	assert.deepEqual(out, {
		$initial_person_info: { u: 'https://cloud.rocketride.ai/?utm_source=s', r: 'https://mail.test' },
		$client_session_props: { sessionId: 's1', props: { u: 'https://cloud.rocketride.ai/p', r: '$direct' } },
		$referrer: 'https://www.google.com', $referring_domain: 'www.google.com',
		utm_source: 's', distinct_id: 'd1', $session_entry_url: 'https://cloud.rocketride.ai/',
	});
	assert.equal(JSON.stringify(out).includes('secret'), false);
});



test('reduceStoredProps: stored person and group property bags (sent to /flags) are reduced one level down', () => {
	const out = reduceStoredProps({
		$stored_person_properties: { $fbc: 'fb.1.1.secret', $fbp: 'fb.1.1.secret', gclid: 'secret', $current_url: 'https://x.test/?k=secret', plan: 'pro' },
		$stored_group_properties: { company: { $referrer: 'https://g.test/?q=secret', name: 'Acme' } },
	});
	assert.deepEqual(out, {
		$stored_person_properties: { $current_url: 'https://x.test/', plan: 'pro' },
		$stored_group_properties: { company: { $referrer: 'https://g.test', name: 'Acme' } },
	});
	assert.equal(JSON.stringify(out).includes('secret'), false);
});

test('maskReplayAttribute: stylesheet text, meta refresh and relative addresses in any attribute are reduced', () => {
	assert.equal(maskReplayAttribute('_cssText', '.a{background:url(http://h.test/?next=/a/b&email=x/img.png)}.b{color:red}'), '.a{background:url(http://h.test/)}.b{color:red}');
	assert.equal(reduceCssUrls("@font-face{src:url('/f.woff2?sig=1') format('woff2')}"), "@font-face{src:url('/f.woff2') format('woff2')}");
	assert.equal(maskReplayAttribute('content', '0;url=https://x.test/next?token=abc'), '0;url=https://x.test/next');
	assert.equal(maskReplayAttribute('data-next', '/r?token=abc&utm_source=s'), '/r?utm_source=s');
	assert.equal(maskReplayAttribute('data-anchor', '/cb#access_token=abc'), '/cb');
	assert.equal(maskReplayAttribute('content', 'width=device-width, initial-scale=1'), 'width=device-width, initial-scale=1');
	assert.equal(maskReplayAttribute('aria-label', 'Why? Because'), 'Why? Because');
});

test('redactSecretsInText and exception reports: emails and tokens in messages are replaced', () => {
	assert.equal(redactSecretsInText('user ada@example.test failed'), 'user [email] failed');
	assert.equal(redactSecretsInText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl rejected'), 'jwt [token] rejected');
	assert.equal(redactSecretsInText('Authorization: Bearer abcdef0123456789'), 'Authorization: Bearer [token]');
	assert.equal(redactSecretsInText('TypeError: x is undefined'), 'TypeError: x is undefined');
	const e = sanitizeEvent({ event: '$exception', properties: { $exception_list: [{ type: 'Error', value: 'no account for ada@example.test with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' }] } } as CaptureLike) as { properties: Record<string, unknown> };
	assert.equal(JSON.stringify(e.properties).includes('ada@example.test'), false);
	assert.equal(JSON.stringify(e.properties).includes('eyJzdWIiOiIxIn0'), false);
});

test('sanitizeEvent: a relative address with a query in any attribute of a click chain is reduced', () => {
	const e = sanitizeEvent({ event: '$autocapture', properties: {
		$elements_chain: 'button:attr__data-next="/r?token=abc"attr__class="btn"nth-child="1"',
		$elements: [{ tag_name: 'button', 'attr__data-next': '/r?token=abc', attr__class: 'btn' }],
	} } as CaptureLike) as { properties: Record<string, unknown> };
	assert.equal(e.properties.$elements_chain, 'button:attr__data-next="/r"attr__class="btn"nth-child="1"');
	assert.deepEqual(e.properties.$elements, [{ tag_name: 'button', 'attr__data-next': '/r', attr__class: 'btn' }]);
});

test('sanitizeEvent: a chain value holding escaped quotes is read to its end, and the address after them is reduced', () => {
	// posthog-js writes a quote inside a value as \" and leaves a backslash as it is
	const chain = String.raw`button:attr__data-next="see \"here\" /r?token=abc"href="/r?q=\"x\"&token=abc&utm_source=s"nth-child="1"`;
	const e = sanitizeEvent({ event: '$autocapture', properties: { $elements_chain: chain } } as CaptureLike) as { properties: Record<string, unknown> };
	assert.equal(e.properties.$elements_chain, String.raw`button:attr__data-next="see \"here\" /r"href="/r?utm_source=s"nth-child="1"`);
	// a backslash before an escaped quote (JSON whose string ends in a backslash) does not end the value
	const json = String.raw`div:attr__data-cfg="{\"dir\":\"C:\\",\"next\":\"/r?token=abc\"}"nth-child="1"`;
	const j = sanitizeEvent({ event: '$autocapture', properties: { $elements_chain: json } } as CaptureLike) as { properties: Record<string, unknown> };
	assert.equal(j.properties.$elements_chain, String.raw`div:attr__data-cfg="{\"dir\":\"C:\\",\"next\":\"/r\"}"nth-child="1"`);
});

test('sanitizeEvent: a chain whose values cannot be told apart (one ends in a backslash) is not sent', () => {
	const chain = String.raw`code:nth-child="1"nth-of-type="1"text="run \";a:attr__href="/r?token=abc"href="/r?token=abc"nth-child="2"`;
	const e = sanitizeEvent({ event: '$autocapture', properties: { $el_text: 'run \\', $elements_chain: chain } } as CaptureLike) as { properties: Record<string, unknown> };
	assert.equal('$elements_chain' in e.properties, false);
	assert.equal(e.properties.$el_text, 'run \\');
});

test('sanitizeEvent: an element\'s text and attributes are reduced as free text, in the chain, $el_text and $elements', () => {
	const text = 'Open https://x.test/cb?token=abc&utm_source=s for ada@example.test';
	const reduced = 'Open https://x.test/cb?utm_source=s for [email]';
	const e = sanitizeEvent({ event: '$autocapture', properties: {
		$el_text: text,
		$elements_chain: `a:attr__title="${text}"href="/cb"nth-child="1"text="${text}"`,
		$elements: [{ tag_name: 'a', $el_text: text, attr__title: text, attr__href: '/cb' }],
	} } as CaptureLike) as { properties: Record<string, unknown> };
	assert.equal(e.properties.$el_text, reduced);
	assert.equal(e.properties.$elements_chain, `a:attr__title="${reduced}"href="/cb"nth-child="1"text="${reduced}"`);
	assert.deepEqual(e.properties.$elements, [{ tag_name: 'a', $el_text: reduced, attr__title: reduced, attr__href: '/cb' }]);
});

test('web vitals: an object nested past the depth cap is removed, never sent unreduced', () => {
	// the metric object is level 0; l1 to l4 are walked, and l5, five levels down, is past the cap
	const nested = { l1: { l2: { l3: { l4: { url: 'https://cloud.rocketride.ai/a?code=four&utm_source=s', l5: { url: 'https://cloud.rocketride.ai/b?code=five' } } } } } };
	const out = sanitizeEvent({ event: '$web_vitals', properties: { $web_vitals_LCP_event: nested } } as CaptureLike)!;
	const text = JSON.stringify(out);
	assert.ok(!text.includes('code=five'), 'the URL five levels down does not leave the browser');
	const lcp = (out.properties as Record<string, unknown>).$web_vitals_LCP_event as typeof nested;
	const l4 = lcp.l1.l2.l3.l4 as Record<string, unknown>;
	assert.equal(l4.url, 'https://cloud.rocketride.ai/a?utm_source=s', 'within the cap a URL is reduced as before');
	assert.equal('l5' in l4, false, 'the object past the cap is removed');
});
