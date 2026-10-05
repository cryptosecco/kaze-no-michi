# Trot lab

The trot lab is a measuring bench for the trot of the procedural horse (`src/actors/horse/`). It runs the real `Horse`
class in Node, records the geometry of its bones and hooves, computes stride, contact, trunk and joint metrics, checks
them against ranges derived from the equine biomechanics literature and draws plots. A second step photographs the
same trot in the game as Muybridge-style contact sheets.

The lab only measures: it never changes how the horse moves. The horse's internal state (stride phase, gait, stance,
IK reach) is recorded as labels only; whether a hoof touches the ground is decided from geometry. The instrument stays
the same from one run to the next, so a number changes because the horse changed.

## Running it

```bash
npm run trotlab -- --label mine           # Node simulation, metrics, reference check, plots
npm run trotlab:capture -- --label mine   # contact sheets from the real game (macOS and Google Chrome)
npm run trotlab:all -- --label mine       # both, one after the other (never two Chromes at once)
npm test                                  # includes scripts/trotlab.test.mjs
```

- `trotlab` options: `--hz 240` (recording rate), `--ref <file>` (a reference file other than
  `scripts/trotlab/reference.json`), `--no-plots`. The plots are SVG rasterised in headless Chrome; with `--no-plots`
  the run needs Node only.
- `trotlab:capture` options: `--url` (a dev server already running), `--hours 13`, `--speed 4.0`, `--no-rider`,
  `--width 1440 --height 960`, `--quality high`, `--radius auto|<m>` (how far from the spawn to look for a test track).
- The unit tests check the metric primitives on synthetic data with known answers, the joint-angle sign conventions,
  and the geometric probe on the real horse standing square.

## Outputs: `out/trotlab/<label>/`

| File | Content |
|---|---|
| `metrics.json` | Flat `metrics` map (the 4.0 m/s trot, then `robust.<scenario>.*`, `v3.2.*`, `v5.0.*`), units, per-speed results, robustness context, the 60 Hz check, the square-stand angles, hoof geometry, every contact, the reference rows, the git commit and any uncommitted change under `src/` |
| `metrics.md` | The same as Markdown tables: each value with its reference range and an `ok` / `OUT` mark, after a result line (see [the reference ranges](#the-reference-ranges)) |
| `trace_steady_4.0.json` | The main run sample by sample (240 Hz): times, phase, labels, markers, angles |
| `plots/a_gait.png` | Gait diagram after Hildebrand: contact bars per hoof over two strides, suspensions shaded |
| `plots/b_vertical.png` | Vertical travel of withers, sacrum and poll against stride phase |
| `plots/c_hoof_paths.png` | Sole paths in the body frame and in the world, slip during contact |
| `plots/d_joint_angles.png` | Carpus, fore fetlock and elbow; hock, hind fetlock and stifle, against stride phase |
| `side_left_sheet.png` | 12 frames over one stride, the camera square to the heading, 21° lens |
| `side_right_sheet.png`, `front34_sheet.png`, `rear34_sheet.png` | 6 frames each of the same stride |
| `legs_closeup_sheet.png` | The LF/RH diagonal at touchdown, mid-stance, breakover, lift-off, mid-swing, terminal swing |
| `rider_side_sheet.png` | 6 frames with the samurai in the saddle |
| `frames/`, `capture.json` | Every single frame; the track, light, times, phases and contacts of each frame |

The plots are also saved as SVG; where a plot shows a quantity that has a reference range, the range is drawn in green.
Every tile of the sheets carries its stride phase (0 = left fore touchdown) and the hooves in contact at that instant.
Legs are named LF, RF, LH, RH (left/right, fore/hind).

## How it measures

### Simulation (`scripts/trotlab/sim.mjs`)

The real `Horse` runs on stand-ins for the game, as in `scripts/horse.test.mjs`: a document whose canvas draws
nothing, an analytic ground `groundAt(x, z)`, no colliders, no wind, and `Math.random` seeded per scenario
(mulberry32), so a run repeats exactly. The horse is driven without its own behaviour: `ridden = true`, with
`want.speed` and `want.yaw` set at every step (and the speed set directly when a scenario starts at speed). Samples are
taken every 1/240 s, after the world matrices are updated as the renderer would.

| Scenario | Ground | Speed | Settle | Recorded |
|---|---|---|---|---|
| `steady_3.2`, `steady_4.0` (main), `steady_5.0` | flat | constant | 4 s | 6.5 s |
| `accel` | flat | stand → walk 1.8 → trot 4.0 → canter 8.5 → stop | 1 s | 18 s |
| `turn_left`, `turn_right` | flat | 4.0 m/s on an 8 m circle | 4 s | 6.5 s |
| `slope_up`, `slope_down` | 15 % grade along the heading | 4.0 m/s | 4 s | 6.5 s |
| `walk`, `canter`, `gallop` | flat | 1.8, 8.5, 13.5 m/s | 4 s | 7, 5, 4.5 s |
| `stand` | flat | 0 | 2 s | 0.5 s: the square stand, zero of every "relative to standing" angle |

The main trot is run again at 1/60 s, the game's fixed step, to show what sampling changes.

### Markers (`scripts/trotlab/markers.mjs`)

- **Hoof**: the vertices of the hoof capsule skinned to the hoof bone alone (weight ≥ 0.999), read in the bone's
  frame. Its ground ring gives the **sole centre**, the **toe** and the **heel**; the **lowest point** is the lowest
  vertex of the whole capsule. If the hoof's shape changes, the probe follows it; if no rigid capsule is found, the lab
  stops with an error.
- **Joints**: the origins of the rig's bones: coronet, fetlock, carpus, elbow, shoulder joint and top of the scapula;
  hock, stifle and hip.
- **Trunk**: the body centre, the **withers** and the **croup** (rigid points on the chest and pelvis bones at the
  dorsal line), the poll, the muzzle, and the axes of the body, chest and pelvis bones.

### Contacts, plants and scrapes (`scripts/trotlab/metrics.mjs`)

- A hoof is **in contact** when its lowest point is within **4 mm** of the ground; touchdown and lift-off times are
  interpolated where the height crosses that threshold.
- A **plant** is a contact in which the hoof lies **flat** (toe and heel both within 4 mm) at least once after the
  first 10 % of the contact. A contact that is never flat is a **scrape**: a toe or a rim brushing the ground. Strides
  and contact metrics follow the plants; duty factor and suspension count every contact.
- The **planted window** runs from 10 % of the contact (or the first flat sample after it) to the start of the
  **breakover**, the first instant the heel rises above 4 mm.
- A **stride** runs from one LF plant to the next; stride phase 0 is the LF touchdown. Only whole strides are analysed.

### Joint angles

Each angle is the angle between the two segments that meet at a joint, in the plane of the limb: **0 means aligned,
positive means flexion**. The sign comes from the trunk's right axis (chest for the fore limb, pelvis for the hind).
In anatomical terms, flexion is 180° minus the included angle on the side the joint flexes toward, which is why a
standing fetlock reads negative (extended past straight). Ranges of motion are peak-to-peak per stride, averaged over
the strides and both limbs of a pair. The scapula and the femur are also measured as segment angles in the chest and
pelvis frames.

## Metric families

All metrics describe the straight 4.0 m/s trot on flat ground unless the key says otherwise. The catalogue of every
key, with its unit and definition, is [`scripts/trotlab/catalog.mjs`](../scripts/trotlab/catalog.mjs); keys flagged
`extra` are cross-checks and diagnostics.

- **Stride** (`stride.*`): period, frequency, length (horizontal travel of the body centre per stride), measured speed.
- **Support** (`duty.*`, `suspension.*`, `diag.*`): duty factor of fore and hind hooves; the fraction of the stride
  time with no hoof in contact and the number of suspensions per stride; diagonal dissociation at touchdown and lift-off, fore minus hind
  diagonal, positive when the hind lands (or leaves) first.
- **Contact quality** (`contact.*`): slip of the sole centre in the planted window and over the whole contact; scrape
  travel and count; penetration below the ground; float (the lowest point's height between 20 and 70 % of a plant);
  hoof velocity in the last 1/60 s before touchdown (horizontal, along the heading, and vertical); sole pitch at
  touchdown (positive = heel first); toe slip during breakover and when breakover starts, as a fraction of the contact.
- **Trunk and head** (`trunk.*`, `head.*`): vertical travel of withers, sacrum and body centre; when the withers and
  sacrum are lowest within the concurrent diagonal stance (0 = first touchdown of the pair, 1 = last lift-off); mean
  vertical acceleration of the body centre in suspension (free fall would be −9.81 m/s²); pitch, roll, pelvis roll and
  lateral sway per stride; vertical travel of poll and muzzle; how long the poll's low lags behind the withers' low.
- **Fore limb** (`fore.*`): carpus deviation in stance and peak flexion in swing (and when); extra fetlock extension
  under load relative to the stand (and when); ranges of motion of elbow, shoulder, scapula, carpus and fetlock; peak
  hoof height in swing (and when).
- **Hind limb** (`hind.*`): hock yield in stance and peak flexion in swing relative to the stand (and when); ranges of
  motion of stifle, hock, hip angle and fetlock; fetlock extension; peak hoof height in swing.
- **Tracking and compression**: overtrack (hind print minus the previous fore print of the same side, along the
  heading; positive = the hind lands ahead); limb compression in stance, shoulder (or hip) joint to sole centre.
- **Smoothness** (`smooth.*`): the largest rotation of a bone relative to its parent between two 60 Hz frames (trunk,
  neck, head and limbs; ears and tail apart), and the 60 Hz frames with an IK target out of reach, the one metric read
  from an internal label.
- **Robustness** (`robust.<scenario>.*`, for `accel`, the turns, the slopes, `walk`, `canter` and `gallop`): slip,
  scrape, penetration, float, the largest bone step, IK frames out of reach, duty factors, and `hover_mm`, the highest
  of the four hooves' lowest points (above 4 mm, a hoof never touches the ground).
- **Other speeds**: every trot key again at 3.2 and 5.0 m/s, as `v3.2.<key>` and `v5.0.<key>`.

## The reference ranges

[`scripts/trotlab/reference.json`](../scripts/trotlab/reference.json) holds 174 ranges keyed by metric. Each entry has
`lo` and/or `hi` (a missing bound leaves the range open), a `unit` (those of `catalog.mjs`: Hz, m, s, m/s, m/s²,
fraction, /stride, ms, mm, °, %, frame) and a `note`. Notes give the source (author, year) of each literature-derived
range; entries marked "engineering tolerance" are limits of the instrument, and "hard limit N" names a robustness bound
(the one a test enforces is the largest bone step: under 25° at the gallop and 20° trotting downhill,
`scripts/horse.test.mjs`). Every entry also has `dim`, its metric group (timing 26, contact 22, trunk 15, head 3,
limbs 28, smoothness 2, robustness 78), and `main`, true for the 79 principal metrics and false for the other 95; the
lab reads neither, they only classify the ranges. `_meta` holds the horse, the scaling and the conventions text.

A value inside its range, bounds included, is `ok`; outside it, `OUT`; a value that cannot be measured gets no mark.
`metrics.md` opens with "Result: N ok · M OUT · K not measurable" and lists reference keys outside its main and
robustness tables (such as the 3.2 and 5.0 m/s ranges) under "Other reference keys"; its numbers use a decimal point
and the minus sign "−". In `metrics.json`, `reference.rows[].pass` is `true`, `false` or `null`.

### The subject and the scaling

The horse is modelled on a native Japanese horse of the Kiso, Misaki or Taishū type: **1.35 m at the withers**, about
330 kg, hip joint 0.98 m and shoulder joint 1.00 m above the ground (a Kiso is about 1.28 m and 390 kg; Matsuura et
al. 2018). The gait allele of DMRT3 linked to ambling is absent in these breeds (Chandra Paul et al. 2020), so a
normal diagonal trot is expected.

Most published data come from larger horses. They are brought to this size by **dynamic similarity** (Alexander &
Jayes 1983; Farley et al. 1993): at the same Froude number, Fr = v² / (g·h) with h the hip height, quadrupeds share
joint angles, duty factors, phase fractions and stride length in units of h. Lengths scale by h / h_ref, times and
speeds by √(h / h_ref), frequencies by √(h_ref / h); Alexander and Jayes give λ / h ≈ 2.3·Fr^0.3 for stride length.

| Source horses | Hip height | Speed at Fr 1.66 | Length factor |
|---|---|---|---|
| This horse at 4.0 m/s | 0.98 m | Fr = 16 / (9.81 × 0.98) = 1.66 | 1 |
| Warmbloods, ~1.65 m (Hardeman 2020; Rhodin 2022; Back 1995) | ~1.20 m | 4.4 m/s | 0.82 |
| Dressage horses, ~1.68 m (Clayton 1994) | ~1.22 m | 4.5 m/s, their medium trot | 0.80 |
| Icelandic horses, 1.41–1.42 m (Rhodin 2022, 2025) | ~1.03 m | 4.1 m/s, their ridden trot | 0.95 |

At 4.0 m/s the pony therefore trots the equivalent of a medium trot: a higher cadence than a warmblood (about
1.5–1.75 Hz against 1.35 Hz), the same relative stride and the same angles. The control speeds are 3.2 m/s (Fr 1.07,
a working trot) and 5.0 m/s (Fr 2.60, an extended trot). Scaling is not the whole story: at the same Froude number,
small compact breeds move less vertically than warmbloods (withers 47 mm in Icelandic horses against 92 mm; Rhodin
2022), so the vertical ranges are wide enough for both.

### From the literature to the lab's conventions

- **Joint angles**: the rig's square stand is anatomical at the fetlocks and the elbow but far more flexed than a real
  hock and stifle (a standing tarsus is at about 150–165°; Gnagey et al. 2006). The ranges therefore compare **ranges
  of motion and changes relative to the stand**, never absolute angles (the carpus, straight in both, is the
  exception).
- **Contact**: force plates (threshold ~50 N) give slightly shorter stances than hoof-mounted sensors, so duty-factor
  ranges are about ±0.05 wide. A toe dragging within 4 mm counts as contact and can inflate the duty factor.
- **Diagonal dissociation** follows the literature's sign (positive = hind first); values given in % of the stride are
  multiplied by this horse's stride period (about 0.56–0.69 s at 4.0 m/s).
- **Trunk minimum**: the literature times it within the fore (withers) or hind (sacrum) stance; the lab uses the union
  of the diagonal pair, which maps the published 39–45 % to about 0.40–0.46, hence a 0.35–0.55 range.
- **Limb compression**: Hobbs & Clayton (2019) measure from the scapular spine (or the trochanter) to the coffin joint,
  relative to standing length; the lab measures from the shoulder (or hip) joint to the sole centre, relative to the
  length at touchdown, which reads about 1–2 points higher.

### Selected ranges (4.0 m/s)

| Metric | Range | Main sources |
|---|---|---|
| `stride.freq_hz` | 1.45–1.80 Hz | Clayton 1994 scaled (1.53 Hz); Rhodin 2022 (Icelandic, ~1.73 Hz); Alexander & Jayes 1983 (1.52 Hz) |
| `stride.length_m` | 2.20–2.80 m | speed / frequency; Alexander & Jayes 1983 (2.62 m) |
| `duty.fore` / `duty.hind` | 0.35–0.48 / 0.32–0.46 | Clayton & Hobbs 2019; Rhodin 2022; Weishaupt et al. 2010 |
| `suspension.frac` | 0.04–0.25 | Rhodin 2022; Clayton 1997; Weishaupt et al. 2010 |
| `diag.dap_td_ms` | −20 to +35 ms | Holmström et al. 1994; Rhodin 2022; Hobbs et al. 2016 |
| `contact.slip_mm.fore`, `.hind` | 0–5 mm | engineering tolerance: impact slip falls in the excluded first 10 % (Holden-Douilly et al. 2013; Pardoe et al. 2001) |
| `contact.breakover_at.fore`, `.hind` | 0.68–0.88 | Gottleib et al. 2025 (breakover 70–77 ms of a ~330 ms stance) |
| `trunk.withers_dy_mm` / `trunk.sacrum_dy_mm` | 40–85 / 45–87 mm | Hardeman et al. 2020; Rhodin 2022; Hobbs & Clayton 2019 |
| `trunk.flight_accel_mps2` | −11.8 to −7.8 m/s² | free fall ± 20 % |
| `trunk.pitch_deg` / `roll_deg` / `pelvis_roll_deg` | 0.8–4 / 2–7 / 4–12° | Hobbs et al. 2016; Faber et al. 2001; Hardeman et al. 2020 |
| `fore.carpus_max_flex_deg` | 60–100° | Clayton et al. 2004; Martuzzi et al. 2009; Cruz et al. 2018 |
| `fore.fetlock_ext_deg` | 18–38° | Martuzzi et al. 2009; McGuigan & Wilson 2003 |
| `hind.hock_max_flex_deg` | 35–60° | Martuzzi et al. 2009; Gnagey et al. 2006 |
| `leg.compression_pct.fore` / `.hind` | 5–12 / 6–14 % | Hobbs & Clayton 2019, plus the convention offset |
| `head.poll_dy_mm` / `head.lag_ms` | 40–90 mm / −15 to +40 ms | Hardeman et al. 2020; Rhodin 2022, 2025 |
| `smooth.max_bone_step_deg` | 0–18° | fetlocks and carpi turn at most ~600–1000°/s in swing, about 15–17° per 60 Hz frame |

Every other key, the control speeds and the per-key notes are in `reference.json`.

**Robustness tolerances** are engineering limits, not literature: slip at most 10–20 mm depending on the scenario,
penetration at most 5 mm, the largest bone step at most 15–25°, float within ±2 mm, and `hover_mm` at most 4 mm (on a
slope, all four hooves must touch down). Duty-factor ranges for the walk come from Rhodin 2022, slope stances follow
the level ones (Dutto et al. 2004), and the gallop values are Froude-scaled estimates.

### Visual reference: Muybridge's plates

Eadweard Muybridge, *Animal Locomotion* (1887), public domain, via Wikimedia Commons from the USC Digital Library. The
plates are not included in this repository; open the Commons pages to compare them with the contact sheets:

- Plate 596, "Eagle", trotting free, 12 lateral and 12 rear frames:
  <https://commons.wikimedia.org/wiki/File:Horse_Eagle_trotting,_free_(rbm-QP301M8-1887-596).jpg>
- Plate 601, "Beauty", trotting saddled with a rider, 12 lateral and 12 rear frames:
  <https://commons.wikimedia.org/wiki/File:Horse_Beauty_trotting_saddled_with_rider_(rbm-QP301M8-1887-601).jpg>

What to compare with the contact sheets: at lift-off the fore limb is well behind the vertical, heel up, rolling over
its toe, the carpus starting to bend; in swing the fore limb folds (carpus near 90°, cannon back, fetlock flexed, the
hoof tucked under the forearm) while the hind swings forward with the hock bent; in suspension one diagonal has just
left, joints folding, and the other reaches forward to land; at mid-stance both legs of the diagonal are near vertical
with the fetlock visibly sunk; from behind, the pelvis rolls, the tail swings and the hind hooves track narrowly.

### Uncertainty

- **Direct values** (measured on real horses, only scaled): stances, dissociations, suspensions, vertical travel, limb
  compression, pelvis roll, hoof velocities, carpus and fetlock ranges of motion.
- **Breed**: this pony sits between warmbloods and Icelandic horses, whose vertical travel differs almost twofold.
- **Partial sources**: Martuzzi et al. (2009, a mountain breed of similar size) was read through an indexed excerpt
  and agrees with Clayton et al. (2004, 2007); Back et al. (1995a, 1995b) through their abstracts only.
- **Estimates**, kept wide: shoulder and scapula ranges, hock yield and peak flexion, hind hoof height, hind vertical
  touchdown velocity, gallop duty factors.
- **Method**: hoof sensors lengthen stances compared with force plates; skin markers inflate axial rotations (roll
  ranges start from bone-marker data; Faber et al. 2001); many data are from treadmills, in-hand trots or ridden
  dressage horses. The simulated horse carries no rider, and a rider reduces withers travel (Rhodin 2025), so lower
  bounds stay open enough.

## Limits of the measurement

- **The 4 mm threshold** is the one free parameter: another value shifts the duty factor and can split a contact in
  two. `metrics.json` reports the duty factor at 2, 4 and 8 mm and the contacts per stride, so splits are counted.
- **Sampling**: at 60 Hz contact instants move by a few milliseconds; the touchdown velocity is an average over the
  last 1/60 s, not the instant of impact. The lowest capsule vertex is exact on the flat sole, within a fraction of a
  millimetre on the rounded rim.
- **Ground**: the metrics use an exact analytic ground. In the capture the terrain mesh (a 2 m grid) departs from it by
  millimetres to centimetres, so a planted hoof may look slightly above or below the drawn surface: the capture is for
  looking.
- **Joints are bone origins**, not anatomical centres of rotation. **Withers and croup** are rigid points on the chest
  and pelvis: they include the trunk's pitch, not any bending of the spine between them.
- **Breathing** moves the trunk by a few millimetres at a period unrelated to the stride and shows in the per-stride
  peak-to-peak values. **Flight acceleration** cannot be measured without enough samples in suspension.
- **The capture** shows one stride per sheet, on the flattest straight track found near the spawn; the right side and
  the rear three-quarter views are backlit.

## Files

In `scripts/trotlab/`: `sim.mjs` (stand-ins, scenarios, recorder), `markers.mjs` (geometric markers, shared by Node
and the page), `metrics.mjs` (primitives and analysis), `catalog.mjs` (keys, units, definitions), `report.mjs` (full
run, JSON and Markdown, trace, plots), `plots.mjs` (SVG plots), `capture.mjs` and `page.mjs` (browser capture: track,
lab grid, cameras, stepping the horse), `all.mjs` (both steps) and `reference.json`. Tests: `scripts/trotlab.test.mjs`.

## Bibliography

- Alexander RMcN, Jayes AS (1983). A dynamic similarity hypothesis for the gaits of quadrupedal mammals. *Journal of Zoology* 201:135–152.
- Back W, Schamhardt HC, Savelberg HHCM et al. (1995a). How the horse moves: 1. Significance of graphical representations of equine forelimb kinematics. *Equine Veterinary Journal* 27:31–38.
- Back W, Schamhardt HC, Savelberg HHCM et al. (1995b). How the horse moves: 2. Significance of graphical representations of equine hind limb kinematics. *Equine Veterinary Journal* 27:39–45.
- Back W, Schamhardt HC, Hartman W, Barneveld A (1995c). Kinematic differences between the distal portions of the forelimbs and hind limbs of horses at the trot. *American Journal of Veterinary Research* 56:1522–1528.
- Biknevicius AR, Mullineaux DR, Clayton HM (2006). Locomotor mechanics of the tölt in Icelandic horses. *American Journal of Veterinary Research* 67:1505–1510.
- Buchner HHF, Obermüller S, Scheidl M (2000). Body centre of mass movement in the sound horse. *The Veterinary Journal* 160:225–234.
- Chandra Paul R, Nguyen TB, Okuda Y et al. (2020). Distribution of the mutant allele of the DMRT3 gene associated with ambling gaits in Japanese native horse populations. *Animal Science Journal* 91:e13431.
- Clayton HM (1990). The effect of an acute hoof wall angulation on the stride kinematics of trotting horses. *Equine Veterinary Journal Supplement* 9:86–90.
- Clayton HM (1994). Comparison of the stride kinematics of the collected, working, medium and extended trot in horses. *Equine Veterinary Journal* 26:230–234.
- Clayton HM (1997). Classification of collected trot, passage and piaffe based on temporal variables. *Equine Veterinary Journal Supplement* 23:54–57.
- Clayton HM, Sha D, Stick JA, Mullineaux DR (2004). Three-dimensional carpal kinematics of trotting horses. *Equine Veterinary Journal* 36:671–676.
- Clayton HM, Sha D, Stick J, Elvin N (2007). 3D kinematics of the equine metacarpophalangeal joint at walk and trot. *Veterinary and Comparative Orthopaedics and Traumatology* 20:86–91.
- Clayton HM, Hobbs SJ (2019). A review of biomechanical gait classification with reference to collected trot, passage and piaffe in dressage horses. *Animals* 9:763.
- Clayton HM. *Mechanics of equine locomotion* (lecture notes).
- Cruz AM, Vidondo B, Ramseyer AA, Maninchedda UE (2018). Effect of trotting speed on kinematic variables measured by use of extremity-mounted inertial measurement units in nonlame horses. *American Journal of Veterinary Research* 79:211–218.
- Dutto DJ, Hoyt DF, Cogger EA, Wickler SJ (2004). Ground reaction forces in horses trotting up an incline and on the level over a range of speeds. *Journal of Experimental Biology* 207:3507–3514.
- Faber M, Johnston C, Schamhardt H et al. (2001). Basic three-dimensional kinematics of the vertebral column of horses trotting on a treadmill. *American Journal of Veterinary Research* 62:757–764.
- Farley CT, Glasheen J, McMahon TA (1993). Running springs: speed and animal size. *Journal of Experimental Biology* 185:71–86.
- Gnagey L, Clayton HM, Lanovaz JL (2006). Effect of standing tarsal angle on joint kinematics and kinetics. *Equine Veterinary Journal* 38:628–633.
- Gorissen BMC, Serra Bragança FM, Wolschrijn CF et al. (2018). The development of hoof balance and landing preference in the post-natal period. *Equine Veterinary Journal* 50.
- Gottleib K, Trager-Burns L, Santonastaso A et al. (2025). Comparison of gait characteristics for horses without shoes, with steel shoes, and with aluminum shoes. *Animals* 15:2376.
- Hardeman AM, Byström A, Roepstorff L et al. (2020). Range of motion and between-measurement variation of spinal kinematics in sound horses at trot on the straight line and on the lunge. *PLoS ONE* 15:e0222822.
- Hildebrand M (1965). Symmetrical gaits of horses. *Science* 150:701–708.
- Hobbs SJ, Bertram JEA, Clayton HM (2016). An exploration of the influence of diagonal dissociation and moderate changes in speed on locomotor parameters in trotting horses. *PeerJ* 4:e2190.
- Hobbs SJ, Clayton HM (2019). Collisional mechanics of the diagonal gaits of horses over a range of speeds. *PeerJ* 7:e7689.
- Holden-Douilly L, Pourcelot P, Desquilbet L et al. (2013). Equine hoof slip distance during trot at training speed: comparison between kinematic and accelerometric measurement techniques. *The Veterinary Journal* 197:198–204.
- Holmström M, Fredricson I, Drevemo S (1994). Biokinematic analysis of the Swedish Warmblood riding horse at trot. *Equine Veterinary Journal* 26:235–240.
- Martuzzi F, Ranieri A, Gosi S, Vaccari Simonini F, Catalano AL (2009). Two-dimensional kinematics in gait evaluation of Bardigiano horse breeding stock. *Italian Journal of Animal Science* 8 (Suppl 2):718–720.
- Matsuura A, Inoue S, Irimajiri M, Hodate K (2018). Maximum permissible load for Kiso horses trotting over a short, straight course. *Animal Science Journal* 89.
- McGuigan MP, Wilson AM (2003). The effect of gait and digital flexor muscle activation on limb compliance in the forelimb of the horse *Equus caballus*. *Journal of Experimental Biology* 206:1325–1336.
- Morales JL, Manchado M, Vivo J et al. (1998). Angular kinematic patterns of limbs in elite and riding horses at trot. *Equine Veterinary Journal* 30:528–533.
- Muybridge E (1887). *Animal Locomotion*, plates 596 and 601.
- Pardoe CH, McGuigan MP, Rogers KM et al. (2001). The effect of shoe material on the kinetics and kinematics of foot slip at impact on concrete. *Equine Veterinary Journal Supplement* 33:70–73.
- Reiser RF, Peterson ML, Kawcak CE, McIlwraith CW (2005). Forelimb hoof landing velocities in treadmill trotting and galloping horses. *Proceedings of the SEM Annual Conference on Experimental and Applied Mechanics*.
- Rhodin M, Smit IH, Persson-Sjodin E et al. (2022). Timing of vertical head, withers and pelvis movements relative to the footfalls in different equine gaits and breeds. *Animals* 12:3053.
- Rhodin M, Serra Bragança FM, Persson-Sjodin E et al. (2025). Adaptation strategies of Icelandic horses with induced transient hindlimb lameness at walk, trot and tölt. *Equine Veterinary Journal*.
- Weishaupt MA, Hogg HP, Auer JA, Wiestner T (2010). Velocity-dependent changes of time, force and spatial parameters in Warmblood horses walking and trotting on a treadmill. *Equine Veterinary Journal* 42 (Suppl 38):530–537.
