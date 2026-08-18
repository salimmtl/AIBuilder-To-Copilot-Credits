/*
 Builds the synthetic test fixture used by verify-engine.mjs.

 The data here is invented. It is shaped like real msdyn_aievent output but the tool
 names, models and volumes are fictional, chosen to exercise every branch of the
 classification logic:

   - a prompt resolved to the standard tier from its language model
   - a prompt resolved to the basic tier from a "mini" language model
   - a prompt with no language model recorded, so the tier has to be assumed
   - document, OCR and image capabilities matched from their template
   - a zero-credit capability (business card)
   - quick tests, which consume no credits and are excluded by default
   - a row nothing can identify, which must be reported and never costed

 Run `node test/build-fixture.js` to regenerate test/fixture.json.
*/
const fs = require('fs');
const path = require('path');

/* [template, toolName, languageModel, dataType, consumptionSource, creditsPerRun, runs] */
const SPEC = [
  ['GptPowerPrompt',        'Summarise Support Case',   'gpt-4o-2024-11-20',      'Text',    0, 40, 25],
  ['GptPowerPrompt',        'Draft Reply',              'gpt-4o-mini-2024-07-18', 'Text',    0,  6, 20],
  ['DataversePromptColumn', 'Classify Feedback',        'gpt-4o-mini-2024-07-18', 'Text',    2,  3, 30],
  ['GptPromptEngineering',  'Rewrite Article',          '',                       'Text',    1, 24, 10],
  ['ReceiptScanning',       'Expense Receipt Reader',   '',                       'Jpeg',    0, 32, 15],
  ['InvoiceProcessing',     'Supplier Invoice Reader',  '',                       'Pdf',     0, 32, 12],
  ['TextRecognition',       'Scanned Form OCR',         '',                       'Pdf',     0,  3, 50],
  ['ObjectDetection',       'Shelf Stock Counter',      '',                       'Png',     1,  8, 18],
  ['SentimentAnalysis',     'Review Sentiment',         '',                       'Text',    0,  2, 22],
  ['TextTranslation',       'Translate Description',    '',                       'Text',    0, 22,  8],
  ['DocumentScanning',      'Contract Page Extractor',  '',                       'Pdf',     0,100,  6],
  ['BusinessCard',          'Card Scanner',             '',                       'Jpeg',    0,  0,  9],
];

/* Runs that carry no template, no model and an unrecognisable name: the engine must
   report these as unidentified rather than guessing a capability. */
const UNIDENTIFIED = { name: 'Legacy Batch Job', dataType: 'Unknown', credits: 0, runs: 7 };

/* Quick tests never consume credits and are filtered out before costing. */
const QUICK_TESTS = { template: 'GptPowerPrompt', name: 'Summarise Support Case', runs: 11 };

const rows = [];
let seq = 0;
const start = Date.UTC(2026, 0, 5, 9, 0, 0);

function push(rec) {
  // Spread rows across ~6 months so the by-month rollup has something to show.
  const when = new Date(start + (seq % 180) * 86400000 + (seq % 60) * 60000);
  seq++;
  rows.push({
    Environment: 'Sample Environment',
    'Processed time': when.toISOString(),
    'Tool name': rec.tool,
    'Model template': rec.template,
    'Language model': rec.llm,
    'Data type': rec.dt,
    'Estimated consumption': rec.credits,
    'Used in': rec.src,
    'Automation name': '',
    'Quick test': rec.qt === true,
    Status: 'Processed',
    'Event data': rec.llm
      ? JSON.stringify({ consumptionSource: 'PowerAutomate', partnerSource: 'AIBuilder', llmModelName: rec.llm })
      : null,
  });
}

for (const [template, tool, llm, dt, src, credits, runs] of SPEC) {
  for (let i = 0; i < runs; i++) push({ template, tool, llm, dt, src, credits });
}
for (let i = 0; i < UNIDENTIFIED.runs; i++) {
  push({ template: '', tool: UNIDENTIFIED.name, llm: '', dt: UNIDENTIFIED.dataType, src: 0, credits: UNIDENTIFIED.credits });
}
for (let i = 0; i < QUICK_TESTS.runs; i++) {
  push({ template: QUICK_TESTS.template, tool: QUICK_TESTS.name, llm: 'gpt-4o-2024-11-20', dt: 'Text', src: 0, credits: 0, qt: true });
}

const out = path.join(__dirname, 'fixture.json');
fs.writeFileSync(out, JSON.stringify(rows, null, 1));

const credits = rows.reduce((s, r) => s + r['Estimated consumption'], 0);
const quick = rows.filter(r => r['Quick test']).length;
console.log(`Rows        : ${rows.length}`);
console.log(`Quick tests : ${quick}`);
console.log(`Credits     : ${credits}`);
console.log(`Written     : ${out}`);
