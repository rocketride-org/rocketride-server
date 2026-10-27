# Stopping a run the agent did not start

terminate and restart act on a pipeline run. In Ask mode the agent asks before either, whoever started the run, and the card says whether this conversation started it. In Auto mode it stops or restarts only a run this conversation started with `use`, after reading the run's status again. On any other run it refuses with no card and tells the model to ask the user (PR C1).

## Sub-features

- `ask-card-shown` and `ask-card-says-foreign` show a "Needs your OK" card for terminate in Ask mode, saying "This conversation did not start it."
- `denied-run-alive` leaves the run running after Deny.
- `auto-refused` refuses the terminate in Auto mode with no card, naming the run.
- `auto-run-alive` leaves the run running after the Auto turn.

## How to get to it (user POV)

- Start a pipeline in another tab (or the Pipelines view). In the Agent tab, ask the agent to stop it by its token.
- The switch beside the composer sets Ask first or Don't ask.

## Driving it with rr-verify-agent

Preconditions:

- `rr-verify-agent doctor` exits 0.
- The engine has `ROCKETRIDE_ANTHROPIC_KEY`, since the fixture pipeline is the stand-in's shape.

- **The foreign run.** Run `rr-verify-agent drive foreign-terminate`. It seeds `pipelines/verify-foreign.pipe` from `steps/fixtures/foreign-run.pipe` and starts it with `rr-verify-agent engine start`, an execute run that outlives the starting connection.
- **Ask mode.** It sends "Stop the pipeline run with token <token>. I started it from another tab." It waits for the card, saves its text, presses Deny, and reads the run's status with `engine status`.
- **Auto mode.** It presses the mode switch, opens a new session, and sends the same request. It records whether any card showed, opens the thinking rows, and looks for the refusal ("did not start the pipeline run").
- **Cleanup.** It switches back to Ask first and stops the run with `engine terminate`.

## Gotchas

- The Auto part uses a new session. In the first session the model has already read "The user declined", which tells it not to retry.
- The approval mode is a workspace setting. The journey switches it back to Ask first even when a check fails, so later journeys start in Ask. Run it last in a batch anyway.
- A run the agent started with `use` in the same conversation is the other half of the rule. The unit tests cover it (`toolkits.test.ts`, run ownership), since driving the agent to start and stop its own run in one journey adds a long model turn for no new browser behavior.
