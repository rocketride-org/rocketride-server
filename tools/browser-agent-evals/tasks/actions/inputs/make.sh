#!/bin/bash
# Makes the two sample inputs the actions set needs, on macOS, with no key:
#   meeting-30s.wav  two voices from `say`, mentioning the budget (build-08)
#   receipt.png      a receipt rendered by Playwright's headless Chromium, with a total (build-09)
# convert.mjs copies this folder's inputs into the set.
set -euo pipefail
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

lines=(
	"Samantha|Okay, let's start. First item is the budget for next quarter."
	"Daniel|Right. The marketing budget stays at forty thousand dollars, but travel drops to twelve thousand."
	"Samantha|Fine. Can we move the extra eight thousand to hiring?"
	"Daniel|Yes. I'll update the budget sheet by Friday and send it round."
	"Samantha|Great. Second item. The website launch moves to March third."
	"Daniel|Agreed. That's everything from me."
)
parts=()
for i in "${!lines[@]}"; do
	voice=${lines[$i]%%|*}
	say -v "$voice" -o "$work/$i.wav" --data-format=LEI16@16000 "${lines[$i]#*|}"
	parts+=("$work/$i.wav")
done
python3 -I - meeting-30s.wav "${parts[@]}" <<'PY'
import sys, wave
out, parts = sys.argv[1], sys.argv[2:]
with wave.open(parts[0]) as first:
    params = first.getparams()
gap = b'\0' * (params.sampwidth * params.nchannels * params.framerate * 6 // 10)
with wave.open(out, 'wb') as w:
    w.setparams(params)
    for p in parts:
        with wave.open(p) as r:
            w.writeframes(r.readframes(r.getnframes()) + gap)
PY

chrome=$(ls -d ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-*/chrome-headless-shell | tail -1)
cat > "$work/receipt.html" <<'HTML'
<!doctype html>
<html><body style="margin:0;background:#d9d4c7">
<pre style="font:22px/1.45 Menlo,monospace;color:#222;background:#fbfaf5;width:420px;margin:30px auto;padding:28px 32px;box-shadow:0 2px 8px #0003">
     CORNER MARKET
  118 Elm Street, Austin
    Tel 512-555-0142

Date 2026-10-14   14:32
Receipt 004187
--------------------------
Whole milk 1L        2.49
Sourdough loaf       4.75
Bananas 1.2kg        1.68
Coffee beans 250g    8.90
Olive oil 500ml      7.25
--------------------------
Subtotal            25.07
Tax 8.25%            2.07
TOTAL               27.14

Paid by card ****4412
  Thank you for shopping!
</pre>
</body></html>
HTML
"$chrome" --headless --disable-gpu --hide-scrollbars --window-size=560,760 --screenshot="$PWD/receipt.png" "file://$work/receipt.html" 2>/dev/null
ls -l meeting-30s.wav receipt.png
