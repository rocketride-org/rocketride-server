# image_orient

A RocketRide filter node that turns scanned photographs the right way up.

## What it does

Scanning a photo album gives you pictures at every orientation — a print laid sideways on the
platen comes out sideways, and nothing downstream knows. This node looks at each photo four ways
(as it arrived, and turned 90°, 180°, 270°), finds faces in each, and keeps the orientation they
agree on.

It is deliberately cautious. **A photo turned the wrong way is worse than one left alone**, so
unless the evidence is clear the image passes through untouched and is listed on the text lane
instead. Expect it to fix most of a family album and name the rest for you to do by hand — not to
sweep everything.

Photos it does not rotate are **forwarded byte-for-byte**, never re-encoded, so leaving one alone
costs it nothing in quality.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `image` | `image` | The photo, upright if the node was sure, unchanged if it was not |
| `image` | `text` | JSON decision record — what it chose, how sure it was, and why it declined |

## The decision record

```json
{"decoded": true, "rotation": 270, "confident": true,
 "scores": {"0": 0.011, "90": 0.004, "180": 0.0, "270": 0.194},
 "faces": 2, "ratio": 17.6, "reason": null}
```

`rotation` is **the correction applied, in degrees clockwise** — not the rotation the photo was
found in. A picture that arrived turned 90° clockwise is corrected with `"rotation": 270`.

`0` means the image was left as it was, and `confident` separates the two ways that happens:
`true` is "measured, and it was already upright", `false` is "not sure". `reason` names the doubt:

| `reason` | Means |
| --- | --- |
| `no_faces` | Nothing that scored as a face at any orientation |
| `few_faces` | Fewer faces backed the winner than **Faces needed to decide** |
| `thin_margin` | No orientation led the others by enough. Two orientations disagreeing looks like this too |
| `mixed_signals` | The two readings of the detections pointed different ways — the rotation holding the most face was not the one the detector was most certain about |
| `unencodable_format` | Analysed, but not JPEG or PNG, so the node declines to re-save it |
| `no_model` | The face model could not be loaded; nothing was analysed |

`decoded: false` is different again — the bytes were not a readable image. That needs a different
fix from "read it and left it alone", which is why they are not merged.

## Configuring it

| Setting | Default | What it does |
| --- | --- | --- |
| **How sure before rotating** | Balanced (1.1) | How clearly the winning orientation must beat the next best. Trades coverage, not correctness — see below |
| **Faces needed to decide** | 2 | How many faces must back the winner. Lower to 1 for portraits, where there is only ever one face |
| **Face clarity vs face size** | Balanced (1) | When one rotation shows a *bigger* face and another a *clearer* one, this decides which wins. See below |
| **Minimum face score** | 0.6 | How certain the detector must be that something *is* a face before it gets a vote. Raising it ignores doubtful faces but also discards real ones in dim or grainy scans; lowering it admits things that are not faces. Rarely worth changing — it was the least useful dial in testing, and moving it in either direction cost accuracy |
| **Detection size (px)** | 800 | How big a copy the face search runs on. Your image is never scaled; this only affects the search. Raise it if faces in group photos are missed. Cost grows with the square — 1600 is about 4× the work of 800 |
| **JPEG quality** | `auto` | Quality to re-save a rotated JPEG at. `auto` matches what the photo already had. Ignored for PNG; photos that are not rotated are never re-saved at all |

The first two are the ones worth touching. Both defaults were **measured** over 98 real album
photographs, not guessed:

| **How sure before rotating** | Fixed | Turned the wrong way |
| --- | --- | --- |
| Fix as many as possible (1.0) | 37 | 0 |
| **Balanced (1.1)** — default | **37** | **0** |
| Cautious (1.5) | 35 | 0 |
| Only when certain (2.0) | 29 | 0 |

None of those turn a photo the wrong way, because safety does not come from the threshold — it
comes from a rule inside the node: **two independent readings of the same faces must point the
same way before it acts.** One reading asks which orientation holds the most face; the other asks
which the detector was most certain about. Where they disagree the record says `mixed_signals` and
the photo is left alone. Without that rule, matching this coverage cost two photos turned wrongly.

So the setting trades coverage, not correctness. Lower it to fix a few more marginal cases; raise
it if you want the node to touch as little as possible.

### Face clarity vs face size

Each rotation is scored as `confidence ^ k x face area`, and this setting is `k`. It matters for
one specific failure: an upside-down face is still detected, just less confidently — and the box
drawn around it is sometimes *larger* than the box around the upright one. At `k = 1` the bigger
box wins and the photo is left the wrong way up.

| Setting | Faces needed | Corrected | Turned the wrong way |
| --- | --- | --- | --- |
| **Balanced (1)** — default | 2 | 37 | **0** |
| Favour the clearer face (4) | 2 | 38 | 1 |
| Strongly favour (8) | 1 | 39 | 3 |

Raising it rescues photos the default cannot reach, and costs errors elsewhere — the two move
together, so treat it as "how much am I willing to check by hand afterwards". It interacts with
**Faces needed to decide**: the highest setting only reaches those photos when that is also 1,
because they are single-face pictures.

### If something looks wrong

| Symptom | Try |
| --- | --- |
| A photo came out the wrong way round | Raise **How sure before rotating**. This should not happen; the file is worth keeping as an example |
| Too many photos left alone | Lower **How sure before rotating** toward 1.5, then **Faces needed to decide** to 1 |
| Portraits of one person are never rotated | Lower **Faces needed to decide** to 1 — there is only ever one face to find |
| Faces in group shots are missed | Raise **Detection size**; cost grows with the square, so 1600 is ~4× the work of 800 |
| Nothing is ever rotated, every record says `no_model` | The model could not be downloaded. Check network access from the engine host |

## Limitations

- **It needs faces.** Landscapes, documents and photographs of the backs of people's heads give it
  nothing to work with, and it will abstain on them. That is the honest boundary of the approach,
  not a tuning problem.
- **Upside-down photos are the hardest case.** A face detector fails on a sideways face, which is
  what makes 90°/270° detectable; it fails *less* reliably on an inverted one, so `180` corrections
  are less often confident than quarter turns.
- **Expect a residue it cannot reach.** On a 98-photo album it corrects 37 and leaves the rest,
  most of them genuinely upright but some not. A photo where one reading says upright and the other
  says inverted is exactly the case it refuses, and it will keep refusing it — the text lane names
  those so they can be done by hand rather than hunted for.
- **Only JPEG and PNG are re-saved.** Other formats are still analysed and reported — the record
  tells you which way the image should go — but the node will not re-encode them, because it has no
  way to recover their original compression settings and would be choosing one for you.
- **No EXIF is carried over.** A rotated image is re-encoded with OpenCV, which writes no EXIF and
  no colour profile. Photos that are not rotated keep their bytes exactly, so they keep everything.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
