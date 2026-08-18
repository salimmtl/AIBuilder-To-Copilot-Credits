<p align="center">
  <img src="tool-logo.png" alt="AI Builder Credit Analyzer" width="128" height="128">
</p>

<h1 align="center">AI Builder Credit Analyzer</h1>

<p align="center">
  A tool for <a href="https://www.powerplatformtoolbox.com/">Power Platform ToolBox</a> that
  shows how much your AI Builder usage would consume in <strong>Copilot Credits</strong>.
</p>

---

## What this is for

AI Builder usage is moving to Copilot Credits. The exchange rate is **not** one number — it
depends on which AI Builder capability each run used, and the rates differ by as much as
**20x** between capabilities.

So you cannot work this out from a single credit total. You need to know *what kind of work*
your AI Builder runs were doing. This tool reads that detail straight out of Dataverse and does
the conversion for you.

It only ever **reads**. It never changes anything in your environment.

---

## What you need

- **Power Platform ToolBox** installed, with a connection to the Dataverse environment you want
  to look at. ToolBox handles signing in, including multi-factor authentication.
- Permission to **read** three tables in that environment: **AI Event**, **AI Model** and
  **AI Template**.

> **A note on permissions.** AI Event records are owned by the user who ran them. If you are not
> an administrator you will only see *your own* runs, and the totals will look far too low. Run
> this as an administrator.

There is nothing else to install, no app registration to create, and no consent request to chase.

---

## How to run it

1. Open **Power Platform ToolBox**.
2. Connect to the environment you want to analyse.
3. Open **AI Builder Credit Analyzer** from the tool list.
4. Pick a **history window** — how far back to look. Longer is better; usage is usually uneven
   from month to month, so a short window can be misleading.
5. Leave **Exclude quick tests** ticked unless you have a reason not to. Quick tests are the
   test runs makers do while building a model, and they consume no credits.
6. Select **Scan this environment**.

The scan reads your AI Builder history and shows the results below. Large environments take
longer, and progress is shown as it goes.

> **For trends, scan a long window.** The **Trends** tab needs several complete months before it
> can say anything useful about spikes or direction. 180 days or more gives you something to
> work with; 365 days is better. If you are comparing several environments, scan them all with
> the **same** window.

### Do this for every environment

**Power Platform ToolBox connects to one environment at a time.** A scan only covers the
environment you are currently connected to.

To see your whole tenant, repeat the steps above for each environment: switch the connection in
ToolBox, then scan again. Results build up as you go, and the tool lists exactly which
environments are included.

> An environment you have not scanned is **missing from the totals**, not counted as zero. This
> is the single easiest way to end up with a number that is too low.

Scanning the same environment again simply replaces its earlier result.

---

## What you get

Results appear in four tabs.

### Summary

The headline numbers:

| | |
|---|---|
| **Counted runs** | How many AI Builder runs were included |
| **AI Builder credits** | What those runs consumed today |
| **Copilot Credits (est.)** | The estimated equivalent after the change |
| **Estimated cost** | Those Copilot Credits priced in US dollars |
| **Identified** | The share of runs the tool could match to a capability |

Below that you get a breakdown **by environment** and **by capability** (which kind of AI
Builder work is driving the cost).

There is also a **classification confidence** table, explained below.

### Trends

How consumption moves over time, grouped by **month** or **quarter**, measured in Copilot
Credits, AI Builder credits or runs.

- A chart of every period, with unusually high periods in red and unusually low ones in amber.
- Headline figures: the average and typical (median) period, the busiest one, and whether
  consumption is rising, falling or broadly flat.
- **Spikes** called out in plain language — for example *"2026-05: about 5.4x the typical
  month"*. When you find one, the **By tool** tab will usually tell you what caused it.
- A table of every period with its change against the previous one.

Two things this tab is deliberately careful about:

**Partial periods are never treated as real drops.** If your scan window starts mid-month, or
the current month is still running, that period is only partly covered. It is shown greyed out
for context but left out of all the statistics — otherwise it would look like consumption had
collapsed.

**Environments scanned over different windows are only compared where they overlap.** If one
environment is scanned over 90 days and another over a year, the early months contain just one
environment and would show a fake ramp-up. The tab tells you the comparable period, and suggests
rescanning with matching windows if you want a longer history.

"Unusual" also needs enough history to mean anything. With only two or three complete periods
the tool says so rather than guessing. A period must be both statistically distinct *and*
meaningfully different in size before it is flagged, so small wobbles on steady usage stay quiet.

### By tool

Every AI Builder tool, ranked by consumption, showing the language model it uses. This is
usually the most useful tab: it answers *which handful of tools account for most of the bill*,
which is where any optimisation effort should go.

This covers all the environments you have scanned, and it is kept between sessions.

### Events

The individual runs behind the numbers, so you can check any figure yourself. Filter by tool,
model, capability or environment.

You can export the runs as **JSON** or **CSV** from this tab. Individual run detail is only kept
while the tool is open — export it if you want to keep it. The summary figures are saved.

---

## Please read: this is an estimate

The tool works out which AI Builder capability each run used, then converts at that capability's
published rate. To do that it looks at, in order of reliability:

1. the model template behind the run,
2. the language model it used,
3. the name the maker gave the tool,
4. the type of data it processed.

**This matching will not be right every time.** Prompts are the weakest case: basic, standard
and premium prompt models differ enormously in price, and the tier has to be worked out from the
language model. Where nothing records which model was used, the tool assumes the standard tier.

So every run gets a **confidence** rating, shown on the Summary tab and against each row:

| Confidence | What it means |
|---|---|
| **High** | Matched on the model template or language model — the dependable signals |
| **Medium** | Matched on the tool's name, or the prompt tier had to be assumed |
| **Low** | Only the tool name or data type suggested a match |
| **Unidentified** | Could not be matched — reported to you, and **never** included in the cost |

If a lot of your runs come out medium or low, treat the total as a rough indication only.

**Use this for planning and budgeting.** It is not a bill, not a quote, and not a replacement
for official licensing guidance. Confirm anything commercially significant through Microsoft.

---

## Development

```bash
npm install
npm run build         # production build into dist/
npm run dev-watch     # rebuild on save, with sourcemaps
npm test              # costing engine regression check
npx pptb-validate     # manifest check
```

To debug inside Power Platform ToolBox: turn on **Show Debug Menu** in Settings, then
**Debug → Load Local Tool** and pick this folder (the one holding `package.json`, not `dist/`).
Use **Help → Toggle Tool DevTools** for the console. There is no hot reload — close and reopen
the tool tab after each rebuild.

### How it is put together

| Path | What it does |
|---|---|
| `src/app.ts` | The tool: reads Dataverse, builds the tabs |
| `src/credit-engine.js` | Classification and conversion. No DOM, no dependencies |
| `test/verify-engine.mjs` | Checks the engine still produces the expected figures |
| `test/build-fixture.js` | Regenerates the synthetic test data |
| `tools/build-icon.ps1` | Rebuilds the tool icon from `tool-logo.png` |

The test data is **synthetic**, not from any real tenant. It is built to exercise every
classification path, including runs that cannot be identified, and the expected results are
worked out by hand from the published rates. If the rate table or the matching logic changes,
`npm test` fails.

### Two things not to break

**The build output.** ToolBox loads `dist/index.html` directly, with no module loader. The build
must produce a single bundle loaded by a plain `<script>` at the end of `<body>` — no
`type="module"`, no `crossorigin`, no root-absolute asset paths. `vite.config.ts` enforces this.
A stock Vite config will produce a tool that loads blank.

**The icon.** ToolBox requires an `.svg`; `pptb-validate` rejects anything else. The logo is a
raster image, so `tools/build-icon.ps1` shrinks it, removes its solid background (otherwise it
shows as a white box in dark theme) and wraps it in an SVG. Re-run it if the logo changes:

```powershell
powershell -File tools/build-icon.ps1
```

`src/public/icons/tool-mono.svg` is a plain single-colour alternative, kept in case the full
colour version ever looks wrong against a theme.

---

## Licence

MIT — see [LICENSE](LICENSE).
