# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Generate the fictional Vector Explorer demo corpus (deterministic, standard library only).

Forty short documents about a made-up network of northern field stations, in
eleven folders, written so the map and the chat have something to show:

* topic clusters (station handbooks, bird field guides, greenhouse notes,
  operations memos, the observatory, the station kitchen, an annual report);
* ``manuals/long_manual.md``, one long document (well over 64 chunks at the
  calibrated chunking; see ``apps/vector-ui/tests/fixtures/chunking.json``);
* two near-duplicate pairs (``handbooks/falcon_handbook.md`` and
  ``handbooks/falcon_handbook_rev2.md``; ``field/kestrel_field_guide.md`` and
  ``archive/kestrel_field_guide_copy.md``);
* one boilerplate paragraph (``BOILERPLATE``) at the end of exactly six files;
* one OCR-junk file (``scans/ocr_scan_0417.txt``) and one table file
  (``tables/equipment_inventory.html``);
* one keyword token, ``KX4471`` (``KEYWORD_TOKEN``), written once, as a whole
  word, in ``ops/memo_q3.txt`` (``KEYWORD_FILE``, one of the documents the live
  tool suites upload), so keyword search has one exact answer on every store.

With ``--pad N`` the corpus gains N padding documents, one short note each
(one chunk), in their own folder ``pad/`` (``PAD_FOLDER``). Seeded as
``C:/demo/pad/...`` into a collection of their own (``SCOPE_COLLECTION``, the
scope cards below, never the demo collection, whose samples must keep every demo
document), they make a scope larger than the sampler's 500-document listing (the
enrichment lane scopes the map to that folder) and a collection of more than 500
documents (an unscoped sample's listing then stops at its cap).

The enrichment lane's own fixture cards are templates pointed at a collection
of their own, built the way gen_perf.py builds the perf card: the scope cards
(``SCOPE_CARDS``, Qdrant and Chroma, over ``SCOPE_COLLECTION``) and the legacy
card (``LEGACY_CARD``, pgvector, over the legacy table seed_legacy.sh seeds).

Every name, place and number is invented. The same run always writes the same
bytes, so a seeded store can be compared across runs.

Usage: python3 gen_corpus.py OUT_DIR [--pad N] [--check]
  --pad N   also write N padding documents under pad/
  --check   exit 1 when OUT_DIR differs from what this script writes
The enrichment lane's cards (the engine's Python, from dist/server; local
containers only; the forty demo documents are seed_demo.sh's):
  ./engine <this folder>/gen_corpus.py --seed-pad 600 [--only qdrant,chroma]   # start the scope cards, upload the padding
  ./engine <this folder>/gen_corpus.py --legacy-card                          # start the legacy card (after seed_legacy.sh)
  ./engine <this folder>/gen_corpus.py --stop-cards                           # terminate both
"""

from __future__ import annotations

import random
import sys

from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

SEED = 20261008

BOILERPLATE = (
    'Records notice: this document is kept by the Records Office of the Northern Field Stations. '
    'Printed copies are uncontrolled; check the station library for the current revision before '
    'relying on any figure, schedule or contact listed here. Corrections go to the duty officer, '
    'who logs them in the weekly records review.'
)

# Files that end with the boilerplate paragraph (exactly six).
BOILERPLATE_FILES = (
    'handbooks/osprey_station_handbook.md',
    'ops/memo_q1.txt',
    'ops/memo_q2.txt',
    'ops/staffing_plan.md',
    'greenhouse/irrigation_schedule.md',
    'observatory/dark_sky_policy.md',
)

NEAR_DUPLICATES = (
    ('handbooks/falcon_handbook.md', 'handbooks/falcon_handbook_rev2.md'),
    ('field/kestrel_field_guide.md', 'archive/kestrel_field_guide_copy.md'),
)

LONG_MANUAL = 'manuals/long_manual.md'
TABLE_FILE = 'tables/equipment_inventory.html'
OCR_FILE = 'scans/ocr_scan_0417.txt'

# One token that keyword search must find exactly once, as a whole word (no other text contains it).
KEYWORD_TOKEN = 'KX4471'
KEYWORD_FILE = 'ops/memo_q3.txt'
KEYWORD_SENTENCE = (
    f'The spare impeller for the intake pump is stocked as part {KEYWORD_TOKEN} in the north store; '
    'order a replacement as soon as the spare is fitted.'
)

# The padding documents of --pad: their folder, and the prefix seed_demo.py uploads the corpus under.
PAD_FOLDER = 'pad'
DEMO_PREFIX = 'C:/demo/'

# The enrichment lane's own cards (lane_vector_enrich.cjs SCOPE_FIXTURES and LEGACY_FIXTURE; its selftest keeps them equal).
SCOPE_COLLECTION = 'vx_scope_docs'
SCOPE_CARDS = {
    'qdrant': ('vx-local Scope 600 (Qdrant)', '00000000-0000-4000-8000-00000000d1a9'),
    'chroma': ('vx-local Scope 600 (Chroma)', '00000000-0000-4000-8000-00000000d1aa'),
}
LEGACY_TABLE = 'vx_legacy_docs'
LEGACY_CARD = ('vx-local Legacy (pgvector)', '00000000-0000-4000-8000-00000000d1a8')
PAD_SHIFTS = ('night watch', 'morning crew', 'day crew', 'evening watch')
PAD_SUBJECTS = ('the generator', 'the battery bank', 'the intake pump', 'the radio mast', 'the greenhouse heater')

# ---------------------------------------------------------------------------
# Sentence banks, one per topic. {x} placeholders are filled per document.
# ---------------------------------------------------------------------------

STATION = [
    'Drinking water at {station} comes from the {spring} spring, piped two kilometres downhill to the settling tank behind the generator shed.',
    'The settling tank holds about eleven thousand litres; the duty officer reads the float gauge every morning and writes the level in the water log.',
    'All drinking water passes the ceramic filter bank and the ultraviolet lamp before it reaches the kitchen tap.',
    'When the spring freezes in deep winter, {station} switches to the meltwater cistern and boils every litre used for cooking.',
    'Power comes from a forty-panel solar array on the south ridge, backed by a diesel generator that starts automatically below twenty percent battery.',
    'The battery room is kept between five and twenty-five degrees; a cold battery bank delivers barely half its rated capacity.',
    'Diesel for the backup generator arrives by snow tractor twice a winter and by boat once in late summer.',
    'Radio check-ins with the regional base run at seven in the morning and six in the evening, every day, on the station channel.',
    'If a scheduled check-in is missed twice, the base starts the overdue procedure and calls the nearest neighbouring station.',
    'The satellite terminal carries email and weather files only; voice calls go through the radio or the emergency beacon.',
    'Every visitor signs the arrival book and attends the safety briefing before leaving the main hut.',
    'The evacuation muster point is the boat shed; head counts are taken by the duty officer with the arrival book in hand.',
    'Fire extinguishers hang beside every exterior door and are inspected on the first day of each month.',
    'Food stores hold four months of dry rations, rotated so the oldest stock is always used first.',
    'Fresh produce from the greenhouse supplements the rations from late spring until the first hard frost.',
    'Waste is sorted into burnables, recyclables and return-to-base; nothing is buried on site.',
    'The sauna doubles as the drying room for wet gear; never leave fuel or batteries inside it.',
    "Walking alone beyond the marker cairns needs the duty officer's approval and a handheld radio.",
    'Polar foxes visit the rubbish store at night, so its door stays latched at all times.',
    'Sleeping quarters are quiet from ten at night until six in the morning.',
    'The station doctor holds a clinic each Tuesday; the medical cabinet key hangs in the duty office.',
    'Laundry runs on sunny afternoons only, when the solar array has surplus power.',
]

BIRDS = [
    'The {bird} hunts over open moorland and is most active in the two hours after sunrise.',
    'Adults of the {bird} show a {colour} back and a pale, finely streaked breast.',
    'Its call is a sharp, repeated note, often given from a fence post or a lone rock.',
    'Juveniles look browner than adults and keep a buff edge on the wing feathers until their first moult.',
    'The {bird} nests on ledges and in old crow nests; it lays four to six eggs in late April.',
    'Incubation lasts about a month, and the young leave the nest some four weeks after hatching.',
    'Survey teams count the {bird} along fixed transects, walking slowly and recording every bird seen or heard.',
    'Hovering into the wind with its head held perfectly still is the most reliable field mark.',
    'In poor light the {bird} can be confused with smaller falcons; check the length of the tail.',
    'Pellets below a roost reveal the diet: mostly voles, with beetles and the odd small bird.',
    'Numbers fall after hard winters, when snow cover hides the voles the birds depend on.',
    'Ringing data show that young birds disperse up to two hundred kilometres from the nest.',
    'Observers should keep at least one hundred metres from an occupied nest during the breeding season.',
    'The wetland hide gives the best views of waders at high tide, when the mudflats are covered.',
    'A spotting scope with a twenty-power eyepiece is the standard kit for the shoreline counts.',
    'Migrants arrive on the first southerly winds of spring and leave again by late September.',
    'Record weather, tide and observer name at the top of every survey sheet.',
    'Plovers run in short bursts and stop abruptly, tilting forward to pick prey from the sand.',
    'Herons stand motionless in shallow water for long minutes before striking at a fish.',
    'Owls are counted at dusk by listening for territorial calls from fixed points along the valley.',
]

GREENHOUSE = [
    'The {plant} bench sits on the east side of the greenhouse, where it gets morning light and afternoon shade.',
    'Water the {plant} only when the top two centimetres of the potting mix feel dry to the touch.',
    'Humidity in the orchid corner is held near sixty percent with a cool-mist humidifier on a timer.',
    'Night temperatures in the orchid house must not drop below twelve degrees; the paraffin heater starts at ten.',
    'Feed the orchid benches with a quarter-strength balanced fertiliser every second watering during the growing season.',
    'Yellowing lower leaves usually mean overwatering rather than a lack of nutrients.',
    'Tomato trials compare three cultivars for yield, flavour and resistance to grey mould.',
    'Side shoots on cordon tomatoes are pinched out weekly so the plant puts its energy into fruit.',
    'Fern beds need constant moisture and no direct sun; the shade cloth stays up from May to August.',
    'Aphids are the commonest pest; ladybird larvae released in spring keep them under control.',
    'Fungus gnats breed in wet compost, so let the surface dry between waterings and use yellow sticky traps.',
    'The drip irrigation lines of the orchid house run for twelve minutes at dawn, fed from the rainwater tank.',
    'Seed packets are stored in airtight jars in the cool cupboard, labelled with variety and harvest year.',
    'Germination tests are run every spring on a damp paper towel before sowing the trays.',
    'Repot orchids after flowering, in fresh bark mix, and keep them slightly drier for two weeks.',
    'Record every sowing, transplant and harvest in the greenhouse log with the date and the bench number.',
    'The orchid house ventilation flaps open automatically above twenty-six degrees and close again at twenty.',
    'Grey mould spreads quickly in the still, damp air of the orchid house; remove infected leaves at once and improve air flow.',
]

OPS = [
    'Quarterly spending stayed within budget, with fuel the largest single line at forty-one percent.',
    'The summer staffing plan adds two technicians and one cook from June to the end of August.',
    'Overtime hours fell compared with last quarter after the new rota was introduced.',
    'The storm on the night of the fourteenth tore two panels from the solar array and flooded the boat shed.',
    'No one was hurt; the duty officer moved the generator to manual and the station ran on diesel for three days.',
    'The root cause of the pump failure was a cracked impeller, worn by grit from the spring intake.',
    'Corrective actions: fit a coarse screen at the intake, inspect the impeller monthly and keep a spare on site.',
    'The resupply boat is booked for the second week of August, weather permitting.',
    'All staff must complete the refreshed first-aid course before the winter season begins.',
    'The radio repeater on the north ridge will be replaced during the autumn maintenance window.',
    'Training days are scheduled for the first Monday of each month; attendance is recorded by the duty officer.',
    'A review of the incident found that the storm warning reached the station but was not posted on the board.',
    'From next quarter the weather officer posts every warning on the board and reads it at the evening check-in.',
    'Spending on spare parts rose because of the pump repair and the replacement solar panels.',
    'The visitor programme hosted three university groups and one film crew this quarter.',
    'Leave requests for the winter season must reach the station manager by the end of September.',
    'Satellite bandwidth will be shared by a simple rota so that science uploads are not delayed.',
]

OBSERVATORY = [
    'The observatory dome houses a forty-centimetre reflector on an equatorial mount.',
    'Before each session, collimate the telescope with the laser tool and check the star test on a bright star.',
    'Flat frames are taken at dusk against the twilight sky; dark frames at the end of the night with the cap on.',
    'Polar alignment is checked monthly with the drift method; a well-aligned mount tracks for ten minutes without guiding.',
    'Observing logs record the target, start time, exposure, filter, seeing and any clouds.',
    'Seeing is rated on a five-point scale; nights below three are used for maintenance and training.',
    'The weather station on the dome roof logs wind, humidity and sky temperature every minute.',
    'Close the dome when the wind exceeds forty kilometres per hour or the humidity passes ninety percent.',
    'Red torches only inside the dome; white light ruins dark adaptation for twenty minutes.',
    'The dark sky policy limits outdoor lighting to shielded, warm-coloured lamps pointed at the ground.',
    'Star parties for visitors are held on moonless weekends between October and March.',
    'Guests are shown the Pleiades, the Orion Nebula and Jupiter when it is above the horizon.',
    'Aurora alerts from the satellite feed are posted on the board; the camera on the roof records all night.',
    'Mirror cleaning is done once a year, in summer, by the instrument technician only.',
    'The spectrograph is calibrated against the neon lamp at the start and end of every run.',
]

KITCHEN = [
    'The rye loaf proves overnight in the cool pantry and bakes for fifty minutes at two hundred degrees.',
    'Sourdough starter is fed every morning with equal weights of flour and water.',
    'Winter stew uses reindeer, root vegetables and barley, simmered for three hours on the back of the stove.',
    'Ration planning assumes three thousand two hundred calories per person per day in winter.',
    'Frozen stores are checked weekly against the inventory sheet taped to the freezer door.',
    'Wash hands before handling food and after handling raw meat; the hand basin is by the pantry door.',
    'Cutting boards are colour coded: red for raw meat, green for vegetables, blue for fish.',
    'Leftovers are labelled with the date and eaten within two days or thrown out.',
    'The bread maker is on the kitchen rota, one person per week, starting Mondays.',
    'Porridge with cloudberry jam is the standard breakfast; coffee is brewed in the large urn at six.',
    'Special diets are noted on the board above the stove at the start of each rotation.',
    'Fish caught from the station jetty is filleted on the outside table, never in the kitchen.',
    'The kitchen generator circuit trips if the oven and the kettle run together; use one at a time.',
]

MANUAL = [
    'Isolate the {unit} at the main switchboard and fit a padlock and tag before opening any cover.',
    'Check that the {unit} pressure gauge reads zero before loosening any fitting.',
    'Drain the oil into the marked container and record the volume in the maintenance log.',
    'Inspect the drive belt for cracks, glazing and fraying; replace it if the deflection exceeds twelve millimetres.',
    'Clean the strainer basket with fresh water and a soft brush; never use a wire brush on the mesh.',
    'Replace the filter cartridge, lubricate the seal with clean water and hand-tighten the housing.',
    'Torque the cover bolts in a cross pattern to the value stamped on the {unit} nameplate.',
    'Restore power, run the {unit} for five minutes and check every joint for leaks.',
    'Measure the output against the reference table and note any deviation larger than five percent.',
    'If the {unit} trips on restart, isolate it again and report the fault to the station engineer.',
    'Bleed air from the fuel line at the bleed screw until fuel runs clear without bubbles.',
    'Test the low-level alarm by lowering the float by hand; the buzzer must sound within three seconds.',
    'Wipe the panels with a damp cloth at dawn, before the glass warms, to avoid thermal stress.',
    'Record the battery voltages cell by cell; a cell more than one tenth of a volt below the mean needs attention.',
    'Check the ultraviolet lamp hours on the counter and replace the lamp at nine thousand hours.',
    'Return all tools to the shadow board and sign the job off in the log before removing the padlock.',
]

UNITS = [
    'intake pump',
    'transfer pump',
    'filter bank',
    'ultraviolet unit',
    'backup generator',
    'battery bank',
    'solar charge controller',
    'cistern heater',
    'pressure vessel',
    'dosing pump',
]

# ---------------------------------------------------------------------------
# Document plans: (relative path, title, topic bank, substitutions, number of sections)
# ---------------------------------------------------------------------------

DocPlan = Tuple[str, str, str, Dict[str, str], int]

PLANS: List[DocPlan] = [
    (
        'handbooks/falcon_handbook.md',
        'Falcon Station handbook',
        'STATION',
        {'station': 'Falcon Station', 'spring': 'Glassbrook'},
        6,
    ),
    (
        'handbooks/osprey_station_handbook.md',
        'Osprey Station handbook',
        'STATION',
        {'station': 'Osprey Station', 'spring': 'Redfern'},
        5,
    ),
    (
        'handbooks/harrier_outpost_handbook.md',
        'Harrier Outpost handbook',
        'STATION',
        {'station': 'Harrier Outpost', 'spring': 'Coldwell'},
        4,
    ),
    (
        'handbooks/visitor_orientation.md',
        'Visitor orientation',
        'STATION',
        {'station': 'the station', 'spring': 'Glassbrook'},
        3,
    ),
    ('field/kestrel_field_guide.md', 'Kestrel field guide', 'BIRDS', {'bird': 'kestrel', 'colour': 'chestnut'}, 4),
    ('field/heron_field_notes.md', 'Grey heron field notes', 'BIRDS', {'bird': 'grey heron', 'colour': 'blue-grey'}, 3),
    (
        'field/plover_survey_2025.md',
        'Golden plover survey 2025',
        'BIRDS',
        {'bird': 'golden plover', 'colour': 'gold-spangled'},
        4,
    ),
    ('field/owl_census.txt', 'Short-eared owl census', 'BIRDS', {'bird': 'short-eared owl', 'colour': 'tawny'}, 3),
    (
        'field/wetland_birds_checklist.md',
        'Wetland birds checklist',
        'BIRDS',
        {'bird': 'redshank', 'colour': 'grey-brown'},
        2,
    ),
    (
        'field/migration_log_spring.txt',
        'Spring migration log',
        'BIRDS',
        {'bird': 'whimbrel', 'colour': 'mottled brown'},
        3,
    ),
    ('field/ringing_report.md', 'Ringing report', 'BIRDS', {'bird': 'meadow pipit', 'colour': 'olive-brown'}, 2),
    (
        'archive/old_radio_schedule.txt',
        'Radio schedule (superseded)',
        'STATION',
        {'station': 'Falcon Station', 'spring': 'Glassbrook'},
        1,
    ),
    ('greenhouse/orchid_notes.txt', 'Orchid notes', 'GREENHOUSE', {'plant': 'orchid'}, 3),
    ('greenhouse/tomato_trials.md', 'Tomato trials', 'GREENHOUSE', {'plant': 'tomato'}, 4),
    ('greenhouse/fern_house_guide.md', 'Fern house guide', 'GREENHOUSE', {'plant': 'fern'}, 3),
    ('greenhouse/pest_log.txt', 'Greenhouse pest log', 'GREENHOUSE', {'plant': 'seedling'}, 2),
    ('greenhouse/irrigation_schedule.md', 'Irrigation schedule', 'GREENHOUSE', {'plant': 'herb'}, 2),
    ('greenhouse/seed_bank_inventory.md', 'Seed bank inventory', 'GREENHOUSE', {'plant': 'pepper'}, 2),
    ('ops/memo_q1.txt', 'Operations memo, first quarter', 'OPS', {}, 2),
    ('ops/memo_q2.txt', 'Operations memo, second quarter', 'OPS', {}, 2),
    ('ops/memo_q3.txt', 'Operations memo, third quarter', 'OPS', {}, 3),
    ('ops/incident_2025_04_storm.md', 'Incident report: April storm', 'OPS', {}, 3),
    ('ops/incident_2025_09_pump.md', 'Incident report: September pump failure', 'OPS', {}, 3),
    ('ops/staffing_plan.md', 'Summer staffing plan', 'OPS', {}, 2),
    ('ops/budget_summary.md', 'Budget summary', 'OPS', {}, 2),
    ('observatory/telescope_calibration.md', 'Telescope calibration', 'OBSERVATORY', {}, 4),
    ('observatory/observing_log_march.txt', 'Observing log, March', 'OBSERVATORY', {}, 3),
    ('observatory/star_party_guide.md', 'Star party guide', 'OBSERVATORY', {}, 2),
    ('observatory/weather_station_notes.md', 'Weather station notes', 'OBSERVATORY', {}, 2),
    ('observatory/dark_sky_policy.md', 'Dark sky policy', 'OBSERVATORY', {}, 2),
    ('kitchen/bread_recipes.md', 'Bread recipes', 'KITCHEN', {}, 3),
    ('kitchen/winter_stew.md', 'Winter stew', 'KITCHEN', {}, 2),
    ('kitchen/ration_planning.md', 'Ration planning', 'KITCHEN', {}, 3),
    ('kitchen/kitchen_hygiene.txt', 'Kitchen hygiene', 'KITCHEN', {}, 2),
    ('reports/annual_report_2025.md', 'Annual report 2025', 'OPS', {}, 5),
]

BANKS = {
    'STATION': STATION,
    'BIRDS': BIRDS,
    'GREENHOUSE': GREENHOUSE,
    'OPS': OPS,
    'OBSERVATORY': OBSERVATORY,
    'KITCHEN': KITCHEN,
}

SECTION_TITLES = {
    'STATION': ['Water', 'Power', 'Communications', 'Safety', 'Stores', 'Daily life', 'Visitors'],
    'BIRDS': ['Identification', 'Habitat', 'Breeding', 'Survey method', 'Similar species', 'Notes'],
    'GREENHOUSE': ['Placement', 'Watering', 'Climate', 'Feeding', 'Pests', 'Records'],
    'OPS': ['Summary', 'Spending', 'Staffing', 'Incidents', 'Actions', 'Next quarter'],
    'OBSERVATORY': ['Equipment', 'Calibration', 'Logs', 'Weather', 'Visitors', 'Policy'],
    'KITCHEN': ['Recipes', 'Stores', 'Hygiene', 'Rota', 'Notes'],
}


def _fill(sentence: str, subs: Dict[str, str]) -> str:
    out = sentence
    for key, value in subs.items():
        out = out.replace('{' + key + '}', value)
    return out


def _paragraph(rng: random.Random, bank: Sequence[str], subs: Dict[str, str], sentences: int) -> str:
    picks = rng.sample(range(len(bank)), k=min(sentences, len(bank)))
    return ' '.join(_fill(bank[i], subs) for i in picks)


def _document(path: str, title: str, bank_name: str, subs: Dict[str, str], sections: int) -> str:
    rng = random.Random(f'{SEED}:{path}')
    bank = BANKS[bank_name]
    titles = SECTION_TITLES[bank_name]
    markdown = path.endswith('.md')
    lines = [f'# {title}' if markdown else title.upper(), '']
    for s in range(sections):
        heading = titles[s % len(titles)]
        lines.append(f'## {heading}' if markdown else f'{heading}.')
        lines.append('')
        for _ in range(rng.randint(1, 3)):
            lines.append(_paragraph(rng, bank, subs, rng.randint(3, 6)))
            lines.append('')
    return '\n'.join(lines).rstrip() + '\n'


def _near_duplicate(text: str) -> str:
    """The same document with a handful of words changed (a revision)."""
    swaps = (
        ('every morning', 'each morning'),
        ('about eleven thousand', 'roughly eleven thousand'),
        ('twice a winter', 'two times each winter'),
        ('Adults of the', 'Adult'),
        ('most active', 'usually most active'),
        ('at least one hundred', 'no less than one hundred'),
    )
    out = text
    for old, new in swaps:
        out = out.replace(old, new, 1)
    return out.rstrip() + '\n\nRevision note: wording updated; figures unchanged.\n'


def _long_manual() -> str:
    """A maintenance manual of 160 numbered procedures (far more than 64 chunks)."""
    rng = random.Random(f'{SEED}:{LONG_MANUAL}')
    lines = ['# Falcon Station water plant and power maintenance manual', '']
    lines.append(
        'This manual collects every routine maintenance procedure for the water plant and the power '
        'system at Falcon Station. Each procedure is self-contained; follow the steps in order and '
        'sign the job off in the maintenance log.'
    )
    lines.append('')
    for n in range(1, 161):
        unit = UNITS[(n - 1) % len(UNITS)]
        interval = ('weekly', 'monthly', 'quarterly', 'yearly')[(n - 1) // len(UNITS) % 4]
        lines.append(f'## Procedure {n}: {interval} service of the {unit}')
        lines.append('')
        steps = rng.sample(range(len(MANUAL)), k=6)
        for i, step in enumerate(steps, 1):
            lines.append(f'{i}. {_fill(MANUAL[step], {"unit": unit})}')
        lines.append('')
        lines.append(
            f'Procedure {n} applies to the {unit} serial range {1000 + n * 7} to {1000 + n * 7 + 6}. '
            f'Allow {20 + (n * 13) % 70} minutes; two people are needed when the {unit} is above head height.'
        )
        lines.append('')
    return '\n'.join(lines).rstrip() + '\n'


def _table_file() -> str:
    """One HTML page whose content is a table (the parser emits it on its table lane)."""
    rng = random.Random(f'{SEED}:{TABLE_FILE}')
    stations = ('Falcon', 'Osprey', 'Harrier')
    states = ('in service', 'in service', 'in service', 'spare', 'awaiting repair')
    rows = []
    for n in range(1, 61):
        unit = UNITS[(n - 1) % len(UNITS)]
        rows.append(
            f'<tr><td>EQ-{n:04d}</td><td>{unit}</td><td>{rng.choice(stations)}</td>'
            f'<td>{2012 + rng.randint(0, 13)}</td><td>{rng.choice(states)}</td></tr>'
        )
    return (
        '<!doctype html>\n<html><head><meta charset="utf-8"><title>Equipment inventory</title></head><body>\n'
        '<h1>Equipment inventory</h1>\n'
        '<p>Every powered unit at the three stations, with its asset tag, site, year installed and state.</p>\n'
        '<table>\n<thead><tr><th>Asset</th><th>Unit</th><th>Station</th><th>Installed</th><th>State</th></tr></thead>\n'
        '<tbody>\n' + '\n'.join(rows) + '\n</tbody>\n</table>\n</body></html>\n'
    )


def _ocr_junk() -> str:
    """A badly scanned page: broken words, stray symbols and repeated fragments."""
    rng = random.Random(f'{SEED}:{OCR_FILE}')
    alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789|!~;:._-=/\\'
    lines = []
    for _ in range(40):
        words = [''.join(rng.choice(alphabet) for _ in range(rng.randint(1, 9))) for _ in range(rng.randint(4, 12))]
        lines.append(' '.join(words))
    lines.insert(7, 'F4lc0n St4t1on  w4ter  l0g  .. pg 3 of ?? ||| ~~~')
    lines.insert(21, 'gl4ssbr00k spr1ng  l3v3l  ~ 11 0 0 0  l  ;; ;;')
    return '\n'.join(lines) + '\n'


def pad_documents(count: int) -> Dict[str, str]:
    """``count`` padding documents (``pad/scope_note_<n>.txt``), one short note each, the same every run."""
    if count < 0:
        raise ValueError(f'the padding count must be 0 or more, not {count}')
    rng = random.Random(f'{SEED}:{PAD_FOLDER}:{count}')
    docs: Dict[str, str] = {}
    for n in range(1, count + 1):
        shift = PAD_SHIFTS[n % len(PAD_SHIFTS)]
        subject = PAD_SUBJECTS[(n // len(PAD_SHIFTS)) % len(PAD_SUBJECTS)]
        docs[f'{PAD_FOLDER}/scope_note_{n:04d}.txt'] = (
            f'Scope note {n}: the {shift} checked {subject} at {rng.randint(0, 23):02d}:{rng.randint(0, 59):02d} '
            f'and logged a reading of {rng.randint(1, 999)}; nothing else to report.\n'
        )
    return docs


def pad_upload_names(pad: Dict[str, str]) -> List[str]:
    """The names the padding documents are uploaded under (``C:/demo/pad/...``), in path order."""
    return [DEMO_PREFIX + rel for rel in sorted(pad)]


def build_corpus(pad: int = 0) -> Dict[str, str]:
    """Every document of the corpus (and ``pad`` padding documents): relative path -> text."""
    docs: Dict[str, str] = {}
    for path, title, bank, subs, sections in PLANS:
        docs[path] = _document(path, title, bank, subs, sections)
    for original, copy in NEAR_DUPLICATES:
        docs[copy] = _near_duplicate(docs[original])
    for path in BOILERPLATE_FILES:
        docs[path] = docs[path].rstrip() + '\n\n' + BOILERPLATE + '\n'
    docs[KEYWORD_FILE] = docs[KEYWORD_FILE].rstrip() + '\n\n' + KEYWORD_SENTENCE + '\n'
    docs[LONG_MANUAL] = _long_manual()
    docs[TABLE_FILE] = _table_file()
    docs[OCR_FILE] = _ocr_junk()
    docs.update(pad_documents(pad))
    return dict(sorted(docs.items()))


def write_corpus(out_dir: Path, pad: int = 0) -> List[Path]:
    """Write the corpus (and ``pad`` padding documents) under out_dir; returns the written files in path order."""
    written = []
    for rel, text in build_corpus(pad).items():
        target = out_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8', newline='\n')
        written.append(target)
    return written


def differences(out_dir: Path, pad: int = 0) -> List[str]:
    """Relative paths whose content in out_dir differs from (or is missing against) the generator."""
    corpus = build_corpus(pad)
    out = [
        rel
        for rel, text in corpus.items()
        if not (out_dir / rel).is_file() or (out_dir / rel).read_text(encoding='utf-8') != text
    ]
    present = {p.relative_to(out_dir).as_posix() for p in out_dir.rglob('*') if p.is_file()}
    out.extend(sorted(present - set(corpus)))
    return out


def _fixtures():
    """vx_fixtures.py (the acceptance scripts' fixture builder, one folder up)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import vx_fixtures

    return vx_fixtures


def seed_pad(count: int, only: Sequence[str]) -> int:
    """Start the scope cards of ``only`` and upload ``count`` padding documents into each (the engine's Python)."""
    import asyncio
    import tempfile

    fx = _fixtures()
    unknown = [key for key in only if key not in SCOPE_CARDS]
    if unknown:
        print(f'gen_corpus.py: no scope card for {", ".join(unknown)} (known: {", ".join(SCOPE_CARDS)})')
        return 2

    async def run() -> int:
        from rocketride import RocketRideClient

        failures = 0
        with tempfile.TemporaryDirectory(prefix='vx-pad-') as tmp:
            root = Path(tmp)
            files = []
            for rel, text in sorted(pad_documents(count).items()):
                target = root / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding='utf-8', newline='\n')
                files.append((target, DEMO_PREFIX + rel))
            async with RocketRideClient(uri=fx.ENGINE_URL, auth=fx.API_KEY, request_timeout=900000) as client:
                for key in only:
                    name, project_id = SCOPE_CARDS[key]
                    pipe = fx.build_pipeline(key, collection=SCOPE_COLLECTION, project_id=project_id, name=name)
                    tokens = await fx.ensure_started(client, pipe, fx.TEMPLATE_SOURCES)
                    failed = 0
                    for start in range(0, len(files), 25):
                        failed += len(
                            fx.failed_uploads(
                                await fx.send_named(client, tokens['ingest_1'], files[start : start + 25])
                            )
                        )
                    failures += failed
                    print(
                        f'{name}: {len(files) - failed} of {len(files)} padding documents ingested into {SCOPE_COLLECTION}'
                    )
        return 1 if failures else 0

    return asyncio.run(run())


def legacy_card() -> int:
    """Start the legacy card: the pgvector template over the legacy table (seed_legacy.sh seeds it)."""
    import asyncio

    fx = _fixtures()

    async def run() -> int:
        from rocketride import RocketRideClient

        name, project_id = LEGACY_CARD
        pipe = fx.build_pipeline('postgres', collection=LEGACY_TABLE, project_id=project_id, name=name)
        async with RocketRideClient(uri=fx.ENGINE_URL, auth=fx.API_KEY) as client:
            await fx.ensure_started(client, pipe, ('tools_1', 'chat_1'))
        print(f'{name}: running over {LEGACY_TABLE}')
        return 0

    return asyncio.run(run())


def stop_cards() -> int:
    """Terminate the scope cards and the legacy card."""
    import asyncio

    fx = _fixtures()

    async def run() -> int:
        from rocketride import RocketRideClient

        async with RocketRideClient(uri=fx.ENGINE_URL, auth=fx.API_KEY) as client:
            for name, project_id in [*SCOPE_CARDS.values(), LEGACY_CARD]:
                stopped = await fx.stop(client, project_id, fx.TEMPLATE_SOURCES)
                print(f'{name}: stopped {", ".join(stopped) or "nothing"}')
        return 0

    return asyncio.run(run())


def _option(argv: List[str], name: str) -> Tuple[List[str], Optional[str]]:
    """Remove ``name VALUE`` from argv; (the rest, VALUE or None)."""
    if name not in argv:
        return argv, None
    i = argv.index(name)
    if i + 1 >= len(argv):
        raise ValueError(f'{name} needs a value')
    return argv[:i] + argv[i + 2 :], argv[i + 1]


def main(argv: Sequence[str]) -> int:
    """Write (or with --check, compare) the corpus; or with --seed-pad, upload the padding."""
    try:
        args, pad_text = _option(list(argv), '--pad')
        args, seed_text = _option(args, '--seed-pad')
        args, only_text = _option(args, '--only')
        pad = int(pad_text) if pad_text is not None else 0
        if pad < 0:
            raise ValueError(f'--pad must be 0 or more, not {pad}')
    except ValueError as error:
        print(f'gen_corpus.py: {error}')
        return 2
    if seed_text is not None:
        only = [k.strip() for k in (only_text or ','.join(SCOPE_CARDS)).split(',') if k.strip()]
        return seed_pad(int(seed_text), only)
    if '--legacy-card' in args:
        return legacy_card()
    if '--stop-cards' in args:
        return stop_cards()
    check = '--check' in args
    args = [a for a in args if a != '--check']
    if len(args) != 1:
        print(__doc__)
        return 2
    out_dir = Path(args[0])
    if check:
        diff = differences(out_dir, pad)
        for rel in diff:
            print(f'differs: {rel}')
        return 1 if diff else 0
    files = write_corpus(out_dir, pad)
    print(f'{len(files)} documents in {out_dir}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
