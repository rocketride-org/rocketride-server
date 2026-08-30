# scan_cropper

A RocketRide filter node that splits a scan holding several photos into one image per photo.

## What it does

Feed it a scanned photo-album page, or a handful of prints laid on the platen together, and it
emits each photograph as its own image downstream — straightened, cropped to its own edges, and
named in the order you would read the page.

It works out what the background is from the scan itself, so there is no white / dark / album
mode to pick. A pixel counts as background only when all three of these hold: it is *plain*
(no local texture), it is painted in one of the scan's *dominant* colours, and it belongs to a
region that *reaches the edge of the scan*. Each condition covers a gap the others leave —
texture alone keeps the scanner lid, colour alone eats dark clothing that happens to match a
dark page, and reachability alone eats a photo that touches the edge of the platen.

Photos mounted edge to edge never come apart by eroding them, so a region is additionally cut
along any straight border that spans it, recursively. Whether such a cut is believed is
arbitrated by standard print ratios — as a veto, never as a requirement, so a panorama or a
trimmed print is still accepted as the non-standard shape it is.

Detection runs on a downscaled copy and the rectangles are scaled back up, which is what makes
a 143 MP flatbed scan tractable at all. The crops themselves are always taken at full
resolution.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `image` | `image` | One JPEG per photo found, in page reading order |
| `image` | `text` | JSON detection record — what was found, where, and what it was called |

A scan that yields no photos is **forwarded unchanged** rather than dropped, so nothing
silently disappears from a pipeline.

## Output names

Crops are named `<scan>.crop<N>.jpg`, numbered in reading order: top row left to right, then
the next row down. The numbering is dense — a photo that was detected but could not be cropped
leaves no gap in the filenames, because a gap reads as lost data. Use the `cropped` flag in the
text record to find those instead.

The counter runs per *object*, not per stream, so a source that hands the node several images
in one object (a multi-page document, or an upstream fan-out) still gets unique names.

## The detection record

The `text` lane carries one JSON document per scan:

```json
{
  "decoded": true,
  "count": 3,
  "regions": [
    {
      "cx": 337.0, "cy": 428.0, "w": 398.0, "h": 520.0, "angle": 0.0,
      "area_pct": 10.78, "ratio_error": 2.0, "cropped": true, "name": "1.crop0.jpg"
    }
  ]
}
```

`decoded` is what separates *"this is not an image I can read"* from *"I read it and found
nothing"* — both otherwise report zero regions, and telling them apart is the difference
between an auditable run over a folder of scans and a pile of silent zeros. `ratio_error` is
how far the photo sits from the nearest standard print size, in percent; it is reported for
diagnosis and never used to reject a photo.

## Configuring it

Start and usually finish with **Scan type**. There is deliberately no white / dark / album
background setting — the node infers the background from the scan, so the presets describe
what you *scanned* instead, and change the things that genuinely differ between those cases:

| Scan type | Sets | Because |
| --- | --- | --- |
| **Album page** (default) | `maxDepth 4`, `texture 4.0`, `minRelative 0.40` | Mounted photos often touch, so separating them is worth the cost |
| **Loose prints on the scanner bed** | `maxDepth 0`, `minRelative 0.20` | Separately laid prints never touch — the search for joins is pure waste — and their sizes vary more |
| **Textured or patterned page** | `texture 9.0` | Stops page grain being read as photo content |
| **Maximum detail (slower)** | `detectSize 4500`, `maxDepth 6` | Tighter edges, more separation attempts |

A scan type shows only **Straighten photos** and **JPEG quality**; everything else it decides
for you. To go further, each one carries its own **Show advanced settings** switch, which opens
the ten tunables filled in with *that* scan type's numbers — open it under *Textured page* and
`texture` reads 9.0, open it under *Album page* and it reads 4.0. So you start from the preset
nearest your scans and adjust one thing, rather than setting ten values from scratch.

There is deliberately no separate "Advanced" scan type. A scan type is what decides the values,
so an Advanced entry would have nothing to show you but a fixed set of numbers unrelated to the
preset you had selected a moment earlier.

Writing the config by hand rather than through the form, the settings go **inside an object
named after the Scan type**, not beside it:

```json
{ "profile": "textured", "textured": { "quality": "auto", "deskew": true } }
```

`Config.getNodeConfig` reads the user's settings from `connConfig[profile]` and ignores every
top-level key, so a setting written beside `profile` is silently dropped.

### Every setting

Most are only visible behind **Show advanced settings**, and only worth touching if the symptom
table below points at one.

| Setting | Default | What it does |
| --- | --- | --- |
| **Scan type** | Album page | Picks the numbers below to suit what you scanned |
| **Straighten photos** | Yes | Rotates each photo upright as it is cut. Off keeps the original pixels, tilt and all |
| **JPEG quality** | `auto` | `auto` matches the quality your scanner saved at. A number 1-100 overrides it |
| **File size vs quality (dB)** | 0.5 | Only used when quality is `auto`. How much final quality to trade for smaller files. On a 33-page album: 657 MB at 0.2, 463 MB at 0.5, 330 MB at 1.0 |
| **Detection size (px)** | 3000 | Long edge the search runs on. Crops are always cut at full resolution, so this trades speed against how precisely edges are found. Quadratic cost |
| **Page smoothness** | 4.0 | How smooth an area must be to count as empty page. Raise for grainy or fabric pages; lower if a photo with large flat areas is cut short |
| **Smallest photo to keep** | 0.005 | Ignore anything below this share of the scan — half a percent of the page |
| **Largest photo to keep** | 0.95 | Ignore anything above this share. Kept under 1.0 so a failed detection returns nothing rather than the whole page as one "photo" |
| **Longest allowed shape** | 5.0 | How stretched a rectangle may be before it is rejected as not a photo, long side over short. 5.0 comfortably allows panoramas |
| **Discard small leftovers** | 0.4 | Drop finds much smaller than the biggest photo, assuming they are torn pieces. Set 0 to keep everything |
| **Separate touching photos** | 4 | How many times one shape may be cut apart. 0 disables the search entirely and is the biggest speed win when photos never touch |
| **Tilt allowance when separating** | 1.5 | How crooked a join between two photos may be and still be found. Not a speed setting |
| **Print shape tolerance (%)** | 8.0 | How far the two halves of a proposed cut may sit from a standard print shape. Only arbitrates cuts; never rejects a photo on its own |

### If something looks wrong

| Symptom | Try |
| --- | --- |
| The page itself comes out as photos | Raise **Page smoothness** (`texture`), or use the *Textured page* preset |
| A photo with a big plain area (sky, studio backdrop) is cut short or missed | Lower **Page smoothness** |
| Several touching photos come out as one image | Raise **Separate touching photos** (`maxDepth`); raise **Print shape tolerance** |
| One photo is cut in half | Lower **Print shape tolerance** (`ratioTolerance`) |
| Small photos are missed | Lower **Smallest photo to keep**, or lower **Discard small leftovers** to 0 |
| Dust and specks come out as crops | Raise **Smallest photo to keep** |
| Crop edges sit slightly inside or outside the photo | Raise **Detection size** |

### Speed

Two fields are real levers and one only looks like one:

- **`maxDepth: 0`** switches off the search for joins between touching photos. It is the
  dominant cost and the right setting whenever photos never touch — that is what the
  *Loose prints* preset does.
- **`detectSize`** is quadratic — 3000 → 2000 is roughly a 2.25× saving on every pass.
- **`skew`** is *not* a performance setting. Lowering it narrows the angular search without
  buying back any time, because the number of angles tried never drops below five.

## Limitations

- **Memory.** Decoding a 143 MP scan costs roughly 430 MB, plus about 105 MB per crop while it
  is being encoded. Like every other buffering node here, this one has no input size cap.
- **Metadata is not carried over.** Crops are re-encoded with OpenCV, which writes no EXIF and
  no ICC profile — any capture metadata, colour profile or orientation tag on the source scan
  is dropped. The crops are new images, not edited originals.
- **Edge accuracy** is bounded by `detectSize`: at the default, one pixel of detection error is
  about five pixels on a 14000 px-tall scan.

## Provenance

The detection algorithm, the seam search and the JPEG quality matching were developed by the
author in personal forks of two open-source scan croppers, and are contributed here by their
author under this repository's MIT licence:

- [`autocrop`](https://github.com/z80z80z80/autocrop) — the texture-based detector, the seam
  search, `snap_to_border`, the exact-corner crop, and the quality tables (commits `faf2942`,
  `e64b754`, `0717a1f`).
- [`ScanCropper`](https://github.com/murniox/ScanCropper) — standard print-ratio arbitration,
  the duplicate-region test, and the deskew angle floor (commit `120c81b`).

Nothing authored by those projects' other contributors was carried over.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `scan_cropper.album.tune` | `boolean` | **Show advanced settings**<br/>Reveals every value this scan type uses, filled in with its own numbers, so you can start from it and adjust one thing rather than setting all ten from scratch. | `false` |
| `scan_cropper.deskew` | `boolean` | **Straighten photos**<br/>Rotates each photo upright as it is cut, so a slightly crooked scan comes out square. Turn this off only if you would rather keep the original pixels untouched - the photo then keeps its tilt and has page-coloured wedges in the corners. | `true` |
| `scan_cropper.detail.detectSize` | `integer` | **Detection size (px)**<br/>How big a copy of the scan the search for photos runs on. Your crops are always cut from the full-resolution original, so this only trades speed against how precisely photo edges are located. It is the main speed control and the cost is quadratic: 3000 to 2000 is about 2.25x faster. Raise it if crop edges land slightly inside or outside the photo. | `4500` |
| `scan_cropper.detail.maxDepth` | `integer` | **Separate touching photos**<br/>Photos mounted edge to edge look like one shape and have to be cut apart; this is how many times a shape may be cut. Set to 0 when your photos never touch - it switches off the most expensive part of the search and is by far the biggest speed win. Raise it if a row of several touching photos comes out as one image. | `6` |
| `scan_cropper.detail.tune` | `boolean` | **Show advanced settings**<br/>Reveals every value this scan type uses, filled in with its own numbers, so you can start from it and adjust one thing rather than setting all ten from scratch. | `false` |
| `scan_cropper.detectSize` | `integer` | **Detection size (px)**<br/>How big a copy of the scan the search for photos runs on. Your crops are always cut from the full-resolution original, so this only trades speed against how precisely photo edges are located. It is the main speed control and the cost is quadratic: 3000 to 2000 is about 2.25x faster. Raise it if crop edges land slightly inside or outside the photo. | `3000` |
| `scan_cropper.loose.maxDepth` | `integer` | **Separate touching photos**<br/>Photos mounted edge to edge look like one shape and have to be cut apart; this is how many times a shape may be cut. Set to 0 when your photos never touch - it switches off the most expensive part of the search and is by far the biggest speed win. Raise it if a row of several touching photos comes out as one image. | `0` |
| `scan_cropper.loose.minRelative` | `number` | **Discard small leftovers**<br/>Throws away finds much smaller than the biggest photo on the page, on the assumption they are torn-off pieces of one photo rather than photos in their own right. 0.4 means 'drop anything under 40% of the largest'. Lower it, or set 0 to keep everything, when one page genuinely holds photos of very different sizes. | `0.2` |
| `scan_cropper.loose.tune` | `boolean` | **Show advanced settings**<br/>Reveals every value this scan type uses, filled in with its own numbers, so you can start from it and adjust one thing rather than setting all ten from scratch. | `false` |
| `scan_cropper.maxArea` | `number` | **Largest photo to keep**<br/>Ignore anything larger than this share of the whole scan. Kept below 1.0 so that failing to find the photos returns nothing rather than handing you the entire page as one giant 'photo'. You rarely need to change this. | `0.95` |
| `scan_cropper.maxAspect` | `number` | **Longest allowed shape**<br/>How stretched a rectangle may be before it is rejected as not a photo, measured as long side divided by short side. 5.0 comfortably allows panoramas. Lower it if strips of page edge or scanner lid are being picked up as photos. | `5` |
| `scan_cropper.maxDepth` | `integer` | **Separate touching photos**<br/>Photos mounted edge to edge look like one shape and have to be cut apart; this is how many times a shape may be cut. Set to 0 when your photos never touch - it switches off the most expensive part of the search and is by far the biggest speed win. Raise it if a row of several touching photos comes out as one image. | `4` |
| `scan_cropper.minArea` | `number` | **Smallest photo to keep**<br/>Ignore anything smaller than this share of the whole scan. 0.005 means half a percent of the page. Lower it if small photos or stamps are being missed; raise it if specks and dust are coming out as tiny crops. | `0.005` |
| `scan_cropper.minRelative` | `number` | **Discard small leftovers**<br/>Throws away finds much smaller than the biggest photo on the page, on the assumption they are torn-off pieces of one photo rather than photos in their own right. 0.4 means 'drop anything under 40% of the largest'. Lower it, or set 0 to keep everything, when one page genuinely holds photos of very different sizes. | `0.4` |
| `scan_cropper.profile` | `string` | **Scan type**<br/>Pick what you actually scanned and nothing else needs setting. There is no white/dark/album background choice because the node works the background out from the scan itself - what these change is whether photos touch each other, how similar their sizes are, and how grainy the page is. Every scan type carries a 'Show advanced settings' switch that opens up its own values for tweaking. | `"album"` |
| `scan_cropper.quality` | `string` | **JPEG quality**<br/>Type 'auto' to match the quality your scanner saved at, or a number from 1 to 100. Leave it on 'auto': saving above the original cannot recover detail the scanner already threw away, it only makes files bigger - a quality-75 scan re-saved at 100 is roughly four times the size and looks the same. | `"auto"` |
| `scan_cropper.qualityTolerance` | `number` | **File size vs quality (dB)**<br/>Only used when JPEG quality is 'auto'. How much final quality to give up in exchange for smaller files. 0.2 keeps files large and near-perfect, 1.0 makes them roughly half the size with a difference you would struggle to see. Measured on a 33-page album: 657 MB at 0.2, 463 MB at 0.5, 330 MB at 1.0. | `0.5` |
| `scan_cropper.ratioTolerance` | `number` | **Print shape tolerance (%)**<br/>Used only when deciding whether a shape is two touching photos or one whole photo: how far the pieces may sit from a standard print shape (6x4, 5x7, square and so on). It never rejects a photo on its own, so an unusual shape is still kept. Raise it if photos that should be split are staying joined; lower it if one photo is being cut in half. | `8` |
| `scan_cropper.skew` | `number` | **Tilt allowance when separating (degrees)**<br/>How crooked the join between two touching photos may be and still be found. NOT a speed setting - lowering it narrows the search without saving any time, because the number of angles tried does not drop below five. Raise it only if touching photos on a visibly crooked scan are not being separated. | `1.5` |
| `scan_cropper.texture` | `number` | **Page smoothness**<br/>How smooth an area has to be before it counts as empty page rather than part of a photo. RAISE this if the page itself is being detected as photos (grainy, patterned or fabric-covered pages). LOWER it if a photo with large flat areas - a plain sky, a studio backdrop - is being cut short or missed. | `4` |
| `scan_cropper.textured.texture` | `number` | **Page smoothness**<br/>How smooth an area has to be before it counts as empty page rather than part of a photo. RAISE this if the page itself is being detected as photos (grainy, patterned or fabric-covered pages). LOWER it if a photo with large flat areas - a plain sky, a studio backdrop - is being cut short or missed. | `9` |
| `scan_cropper.textured.tune` | `boolean` | **Show advanced settings**<br/>Reveals every value this scan type uses, filled in with its own numbers, so you can start from it and adjust one thing rather than setting all ten from scratch. | `false` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/scan_cropper)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
