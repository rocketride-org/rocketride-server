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
| Too many photos left alone | Lower **How sure before rotating** toward 1.0, then **Faces needed to decide** to 1 |
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
- **Only JPEG and PNG are re-saved.** Other formats are still analysed, and the record names
  `unencodable_format` as the reason — but it reports `rotation: 0`, not the correction it worked
  out, so it tells you the image was left alone and not which way it should go. The node will not
  re-encode these, because it has no way to recover their original compression settings and would
  be choosing one for you.
- **No EXIF is carried over.** A rotated image is re-encoded with OpenCV, which writes no EXIF and
  no colour profile. Photos that are not rotated keep their bytes exactly, so they keep everything.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `image_orient.confidenceWeight` | `number` | **Face clarity vs face size**<br/>When one rotation shows a bigger face but another shows a clearer one, this decides which wins. 'Balanced' is the safe default: measured over 98 album photographs it corrected 37 and got none wrong. Raising it rescues photos where an upside-down face is detected with a larger box than the upright one - but it acts on thinner evidence, and at the highest setting with 'Faces needed to decide' at 1 it corrected 39 and got 3 wrong. Raise it only if upside-down photos are being missed, and check the results. | `1` |
| `image_orient.detectSize` | `integer` | **Detection size (px)**<br/>How big a copy of the photo the face search runs on. Your image is never scaled - this only affects the search. Raise it if faces in group photos are being missed; the cost grows with the square, so 1600 is about four times the work of 800. | `800` |
| `image_orient.margin` | `number` | **How sure before rotating**<br/>How clearly the winning orientation must beat the next best one. Measured over 98 real album photographs, 'Balanced' corrected 37 and got none wrong. Move up if a photo ever comes out the wrong way round; move down only if you would rather fix more and check the results yourself. | `1.1` |
| `image_orient.minConfidence` | `number` | **Minimum face score**<br/>How certain the detector must be that something is a face before it gets a say. Raising it ignores doubtful faces; lowering it lets more in, including things that are not faces at all. | `0.6` |
| `image_orient.minFaces` | `integer` | **Faces needed to decide**<br/>How many faces must agree before the photo is turned. One face is thin evidence and was behind most of the mistakes in testing, so two is the default. Lower to 1 for portraits and single-subject photos, where there is only ever one face to find. | `2` |
| `image_orient.quality` | `string` | **JPEG quality**<br/>Type 'auto' to save at the same quality the photo already had, or a number from 1 to 100. Leave it on 'auto': the image has been through JPEG once already, so saving higher only makes the file bigger without recovering anything. Ignored for PNG, which is lossless. Photos that are not rotated are never re-saved at all. | `"auto"` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/image_orient)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
