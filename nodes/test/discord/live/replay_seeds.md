# Replay seed questions

Ten made-up product questions about using a generic pipeline tool. The L2 replay posts each one
as a real Discord message and checks only the plumbing (one text-lane object, one reply); the
"correct answer should…" note is there for anyone grading answers by hand against a real pipeline.

| # | Question | Topic | A correct answer should… |
|---|----------|-------|--------------------------|
| 1 | How do I create my first pipeline? | onboarding | Walk through adding a source, a processing step and an output, then running it once. |
| 2 | Which Python versions does the SDK support? | version fact | State the supported versions from the docs; must **not** guess. |
| 3 | Can I run a pipeline on my own machine instead of a hosted server? | deployment | Explain local versus hosted runs and what each needs. |
| 4 | How do I pass an API key to a node without putting it in the pipeline file? | configuration | Describe environment variables or a secrets store; never suggest pasting the key inline. |
| 5 | My pipeline starts but never produces an answer. Where do I look first? | troubleshooting | Point to the run status, the logs and the lane wiring between nodes. |
| 6 | Can one pipeline read both PDFs and images? | capability | Explain routing by file type to the matching lanes; do not invent limits. |
| 7 | How do I split a long document into chunks before sending it to a model? | processing | Describe a chunking step and its size and overlap settings. |
| 8 | Is there a way to retry a step that failed? | reliability | Say what the tool offers for retries and what it does not; no made-up settings. |
| 9 | How do I see what each node received and produced during a run? | observability | Point to traces, run logs or event streams for one run. |
| 10 | Show me a minimal pipeline file that answers questions from uploaded documents. | pipeline schema | Give a small, valid example with a source, an index or store, a model and an answer output. |
