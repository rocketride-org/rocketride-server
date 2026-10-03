# Replay seed questions — Rocket Ralph regression set

Ten important questions drawn from real past support threads (Discord history + curated FAQs).
Re-run these on a schedule (Phase 5 replay) and grade each answer against the "correct answer
should…" note. They span onboarding, hard version/infra facts, the applicant token grant, and
the historically-poisoned pipeline-schema area.

_As of 2026-09-22. Generated from `logs/support.log` + `data/faqs.json`._

| # | Question | Topic | A correct answer should… |
|---|----------|-------|--------------------------|
| 1 | How do I get started with RocketRide? | onboarding | Point to the VS Code extension, building a `.pipe`, running locally vs. Cloud, and `npm/pip install rocketride` — a concrete quickstart, not vague. |
| 2 | Does RocketRide work with Python 3.10? | version fact | State the actually-supported Python version(s) from the docs. Must **not** guess a version. |
| 3 | How much does RocketRide Cloud cost? | pricing | Fetch `cloud.rocketride.ai/pricing`; list Starter/Builder/Pro/Team/Enterprise + the token model + $0.03/token overage; end with the pricing link. |
| 4 | I applied for a role — how do I get the 500 free Cloud tokens for the app challenge? | hiring grant | Explain the applicant grant (redeem promo/QR code, no card, 30-day expiry) from the policy doc; link pricing; an escalation here routes to **Hiring** (Josh/Joe/Ben), not Ops/Coupon. |
| 5 | My Cloud API key (rr_…) gets a 403 on the WebSocket upgrade at api.rocketride.ai — why? | cloud (tricky) | Give the known cause/fix from the FAQ; if unresolved, escalate → **Cloud**. |
| 6 | The public Docker engine image (ghcr.io/rocketride-org/rocketride-engine:latest) won't start — how do I fix it? | deps/infra (tricky) | Give the known fix from the FAQ; else escalate → **Deps/Infra**. |
| 7 | I built custom nodes but they show as blank boxes on the canvas (and the FalkorDB node isn't available) — how do I fix it? | nodes | Give node-availability / build guidance; else escalate → **Integration**. |
| 8 | Local mode can't connect — the engine exits during startup (code=1). Help? | engine (local) | Give local-engine troubleshooting; escalate → **Engine** (NOT Cloud — it's local). |
| 9 | For the webhook source node, can I send mixed data types (video, audio, and text) in one request? | capability | Answer correctly about multimodal webhook handling; don't invent constraints. |
| 10 | Can I build a document-uploader + chatbot in the same pipeline? Show me the `.pipe`. | pipeline schema (**critical**) | Emit CORRECT current schema: top-level `components` (never `nodes`), profile-nested config, `response_answers`, LLM attached via a `control` edge. **Guards the known corpus-poison regression.** |

**Why these:** #1–3 are the most common onboarding/pricing asks; #4 is the new applicant-grant
flow; #5–8 are recurring hard cases Ralph historically fumbled; #9 tests real product knowledge;
#10 is the single most important regression guard (the docs-scrape corpus teaches the wrong
`.pipe` schema — this catches a backslide).
