# Confluence node demo output

`demo_output.html` shows real conversion output from the node: three
Confluence pages (a runbook, a service directory, and an incident checklist,
each with a table) were created with synthetic, fictional content, pulled
from a live Confluence Cloud space, and run through `converter.py`'s
storage-format-to-text/table conversion. The pull and conversion are real;
the page content itself (service names, people, escalation channels) is
made-up fixture text written for this demo — no real organizational data.
Open it in a browser to see the text lane followed by the table lane for each
page.

This is a reference artifact for reviewers, not part of the node itself —
nothing under this `demo/` folder is imported by the node or exercised by
`test_confluence.py` / `test_client.py` / `test_converter.py`.
