# Supplemental HTTP harness scope and corrections

The first browser attempt is preserved in `supplemental-first-attempt.json`.
Its two FAIL classifications were test expectations, with no product patch:

- The production framed case had all expected gate/rejection observations,
  but the first harness required fragment stripping. Current-head
  `connection.ts` deliberately leaves framed URLs to their embedder and strips
  a refused `#rrtoken` directive only in a top-level page. The corrected
  assertion checks framed preservation and top-level stripping separately.
- The credential-free dev positive accepted the remote registration and
  forwarded its unique console sentinel. The shell's sign-in gate kept the
  remote unfetched, so requiring its rendered content was inappropriate for
  this fixture. This positive is explicitly limited to remote registration
  and console forwarding; it does not establish authenticated rendering or
  nonempty authentication adoption. The earlier actual authenticated host
  previews cover those observations separately.

The production framed control uses a trusted same-origin parent. Its actual
production entry assets are selected directly, without the flavor picker,
despite forged URL, storage and injected-boot markers. The dev negative uses
a real cross-origin parent. Readiness requires selected entry script loads,
rendered shell root and bootstrap portal, no bootstrap/asset failure, and
dev hooks for development cases. Negative token checks require the actual
token observation path to be callable and the pre-attack baseline unchanged.

Optional HTTP opener controls are independent attacker fixtures, not an App
Builder debug workflow. The dev opener carries no `#rrtoken` directive:
top-level loopback dev fragment seeding is legitimate and is not the sender
rejection boundary being tested. These fixtures contain inert labels only.

The first production-opener attempt timed out in a reused named popup. Closing
that HTTP test popup and clicking the opener control again created a fresh
page; the final result passed, including top-level fragment removal. The
timeout was not counted as a pass. The final snapshot has five PASS results.
