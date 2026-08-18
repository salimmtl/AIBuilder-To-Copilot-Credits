/*
 AI Builder -> Copilot Credits costing engine.

 Single source of truth for classification and conversion, used by:
   - src/app.ts                     (the Power Platform ToolBox tool)
   - test/verify-engine.mjs         (regression check)

 Classification is best effort: a run is matched to a capability from its model
 template, language model, tool name or data type, in that order of reliability.
 Every row carries a confidence rating, and anything unmatched is reported rather
 than costed.

 Dependency-free ES module. No DOM, no Node APIs, so it runs in a browser, in a
 bundler, and under plain node.
*/

export const CC_USD = 0.01;

export const CAPS = {
  'prompt-basic'      :{name:'Prompt — basic LLM model',        unit:'1K tokens',   cc:0.1, aib:1.2},
  'prompt-standard'   :{name:'Prompt — standard LLM model',     unit:'1K tokens',   cc:1.5, aib:24},
  'prompt-premium'    :{name:'Prompt — premium LLM model',      unit:'1K tokens',   cc:10,  aib:182},
  'contract'          :{name:'Contract / insurance card / image description', unit:'1 image', cc:8, aib:32},
  'object-detection'  :{name:'Object detection',                unit:'1 image',     cc:8,   aib:8},
  'custom-doc'        :{name:'Custom document processing',      unit:'1 page',      cc:8,   aib:100},
  'prebuilt-doc'      :{name:'Receipt / invoice / ID document', unit:'1 page',      cc:8,   aib:32},
  'ocr'               :{name:'Text recognition (OCR)',          unit:'1 page',      cc:0.1, aib:3},
  'simple-text'       :{name:'Simple text analysis',            unit:'1K chars',    cc:0.1, aib:2},
  'advanced-text'     :{name:'Advanced text analysis',          unit:'1K chars',    cc:1.5, aib:20},
  'translation'       :{name:'Text translation',                unit:'1K chars',    cc:1.5, aib:22},
  'free'              :{name:'No credit charge',                unit:'n/a',         cc:0,   aib:0}
};

/* Dataverse template unique names -> capability.
   Verified against a live Dataverse org: these are the real msdyn_aitemplate.msdyn_uniquename
   values, normalized to lowercase with non-letters stripped. */
export const TEMPLATE_MAP = {
  // text analysis
  sentimentanalysis:'simple-text', languagedetection:'simple-text', keyphraseextraction:'simple-text',
  textclassification:'advanced-text', textclassificationv:'advanced-text', entityextraction:'advanced-text',
  texttranslation:'translation', texttranslationinternal:'translation',
  textrecognition:'ocr',
  // image
  objectdetection:'object-detection', objectdetectionproposal:'object-detection',
  imageclassification:'object-detection',
  imagedescription:'contract',
  // documents
  receiptscanning:'prebuilt-doc', invoiceprocessing:'prebuilt-doc', identitydocument:'prebuilt-doc',
  taxus:'prebuilt-doc', businesscard:'free',
  contractdocument:'contract', healthinsurancecardus:'contract', contentunderstanding:'contract',
  documentscanning:'custom-doc', documentlayoutanalysis:'custom-doc',
  // prompts (tier resolved from the language model when available)
  gptpowerprompt:'PROMPT', gptpromptengineering:'PROMPT', dataversepromptcolumn:'PROMPT',
  intelligentapprovalprompt:'PROMPT', dvcopilotquery:'PROMPT', copilotsidepanepredict:'PROMPT',
  datagenieemailaddressvalidation:'PROMPT',
  // prediction / no credit charge
  binaryclassification:'free', personalizer:'free', personalizerinternal:'free',
  prediction:'free', genericprediction:'free', bringyourownmodel:'free'
};

/* Language model -> prompt tier.
   Real values seen in msdyn_eventdata.llmModelName include "gpt-41-2025-04-14" and
   "gpt-41-mini-2025-04-14" — note there is no dot in "gpt-41". */
export function tierFromModel(m){
  if(!m) return null;
  const s=String(m).toLowerCase();
  if(/mini|nano|small|haiku|basic|3\.?5-?turbo/.test(s)) return 'prompt-basic';
  if(/\bo1\b|\bo3\b|opus|premium|gpt-?4-?turbo|gpt-?4\.?5/.test(s)) return 'prompt-premium';
  if(/gpt-?4|sonnet|standard/.test(s)) return 'prompt-standard';
  return null;
}

/* Tool name keywords -> capability. */
export const KEYWORDS = [
  [/sentiment/i,'simple-text'],[/language\s*detect/i,'simple-text'],[/key\s*phrase/i,'simple-text'],
  [/entity\s*extract/i,'advanced-text'],[/category\s*class|text\s*class/i,'advanced-text'],
  [/translat/i,'translation'],
  [/\bocr\b|text\s*recognition/i,'ocr'],
  [/object\s*detect/i,'object-detection'],
  [/invoice/i,'prebuilt-doc'],[/receipt/i,'prebuilt-doc'],[/identity\s*doc|\bid\s*card/i,'prebuilt-doc'],
  [/contract/i,'contract'],[/insurance\s*card/i,'contract'],[/image\s*description/i,'contract'],
  [/business\s*card/i,'free'],[/prediction/i,'free'],
  [/form\s*process|document\s*process|extractor|custom\s*doc/i,'custom-doc'],
  [/prompt|\bgpt\b|generative|summar|classif|draft/i,'PROMPT']
];

/* Accept the capability names this tool itself displays, so a manually prepared sheet
   can name capabilities directly instead of using Dataverse template names. */
(function seedTemplateAliases(){
  const norm=s=>String(s).toLowerCase().replace(/[^a-z]/g,'');
  Object.keys(CAPS).forEach(id=>{
    TEMPLATE_MAP[norm(id)]=id;
    TEMPLATE_MAP[norm(CAPS[id].name)]=id;
  });
  const alias={
    promptbasic:'prompt-basic', promptstandard:'prompt-standard', promptpremium:'prompt-premium',
    basicprompt:'prompt-basic', standardprompt:'prompt-standard', premiumprompt:'prompt-premium',
    simpletextanalysis:'simple-text', advancedtextanalysis:'advanced-text',
    customdocumentprocessing:'custom-doc', documentprocessing:'custom-doc',
    receiptinvoiceiddocument:'prebuilt-doc', receipt:'prebuilt-doc', invoice:'prebuilt-doc',
    identitydocumentreading:'prebuilt-doc', textrecognitionocr:'ocr', ocr:'ocr',
    translation:'translation', nocreditcharge:'free', businesscard:'free'
  };
  Object.keys(alias).forEach(k=>{ if(!TEMPLATE_MAP[k]) TEMPLATE_MAP[k]=alias[k]; });
})();

export const PROMPT_DEFAULT = 'prompt-standard';

export function classify(row, promptDefault = PROMPT_DEFAULT){
  const tpl=(row.template||'').toLowerCase().replace(/[^a-z]/g,'');
  if(tpl&&TEMPLATE_MAP[tpl]){
    const cap=TEMPLATE_MAP[tpl];
    if(cap==='PROMPT'){
      const t=tierFromModel(row.model);
      if(t) return {cap:t,conf:'high',basis:'template + language model'};
      /* No language model recorded. Makers often name the tool after the model
         ("Extract w GPT-4o"), so try the tool name before assuming a tier. */
      const t2=tierFromModel(row.tool);
      if(t2) return {cap:t2,conf:'medium',basis:'template + model named in tool'};
      return {cap:promptDefault,conf:'medium',basis:'template (tier assumed)'};
    }
    return {cap,conf:'high',basis:'template'};
  }
  const t=tierFromModel(row.model);
  if(t) return {cap:t,conf:'high',basis:'language model'};
  const name=row.tool||'';
  for(const [re,cap] of KEYWORDS){
    if(re.test(name)){
      if(cap==='PROMPT'){
        const tt=tierFromModel(row.model);
        return tt?{cap:tt,conf:'medium',basis:'tool name + model'}
                 :{cap:promptDefault,conf:'low',basis:'tool name (tier assumed)'};
      }
      return {cap,conf:'medium',basis:'tool name'};
    }
  }
  /* Data type fallback. Real msdyn_datatype values are Text, Unknown, Jpeg, Png, Pdf,
     Tiff, Bmp — not the words "image" or "document". */
  const dt=(row.datatype||'').toLowerCase();
  if(row.credits>0){
    if(/jpe?g|png|bmp|tiff?|gif|image/.test(dt)) return {cap:'object-detection',conf:'low',basis:'data type + rate'};
    if(/pdf|docx?|document/.test(dt))            return {cap:'custom-doc',conf:'low',basis:'data type + rate'};
  }
  return {cap:null,conf:'none',basis:'unmatched'};
}

export function num(v){
  if(v===null||v===undefined) return 0;
  if(typeof v==='number') return isFinite(v)?v:0;
  const m=String(v).replace(/,/g,'').match(/-?\d+(\.\d+)?/);
  return m?parseFloat(m[0]):0;
}

export function parseDate(v){
  if(!v) return null;
  if(v instanceof Date) return isNaN(v.getTime())?null:v;
  const s=String(v).trim();
  /* Month-only input such as "2026-01" or "2026/1" — treat as the 1st, local time,
     so a manually prepared monthly sheet works without inventing day precision. */
  const ym=s.match(/^(\d{4})[-\/](\d{1,2})$/);
  if(ym) return new Date(+ym[1], +ym[2]-1, 1);
  let d=new Date(s);
  if(!isNaN(d.getTime())) return d;
  const m=s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})[,\s]+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if(m){
    let[,a,b,y,H,M,ap]=m;y=+y;if(y<100)y+=2000;H=+H;
    if(ap){if(/pm/i.test(ap)&&H<12)H+=12;if(/am/i.test(ap)&&H===12)H=0;}
    d=new Date(y,+a-1,+b,H,+M);
    if(!isNaN(d.getTime()))return d;
  }
  return null;
}

export const SOURCE = {0:'Power Automate',1:'Power Apps',2:'API',3:'Copilot Studio'};

/* msdyn_eventdata real shape, confirmed against a live org:
   {"consumptionSource":"PowerAutomate","partnerSource":"AIBuilder","llmModelName":"gpt-41-2025-04-14"}
   It is null on many rows, especially older ones. */
export function modelFromEventData(raw){
  if(!raw) return '';
  const s=String(raw);
  try{
    const o=JSON.parse(s);
    for(const p of ['llmModelName','languageModel','modelName','model','modelId','deploymentName','llm','engine']){
      if(o&&o[p]) return String(o[p]);
    }
  }catch(e){ /* not JSON — fall through to regex */ }
  const m=s.match(/(gpt-?[a-z0-9\-\.]*|o[13](?:-[a-z]+)?|text-[a-z0-9\-]+)/i);
  return m?m[0]:'';
}

export const truthy = v => {
  if(typeof v==='boolean') return v;
  const s=String(v).trim().toLowerCase();
  return s==='true'||s==='yes'||s==='1';
};

/*
 Normalize one loosely-shaped input record into a classified, costed row.

 Field names are matched leniently so the same function handles the live Dataverse
 projection built by fromDataverseEvent() and the column names used by the Power
 Automate Automation centre CSV export.
*/
export function buildRow(input, opts = {}){
  const promptDefault = opts.promptDefault || PROMPT_DEFAULT;
  const pick = (...keys) => {
    for(const k of keys){
      const v = input[k];
      if(v!==undefined && v!==null && String(v).trim()!=='') return v;
    }
    return '';
  };

  let used = pick('usedin','Used in','consumptionsource');
  if(/^\d+$/.test(String(used).trim())) used = SOURCE[+used] ?? used;

  let model = String(pick('model','Language model','languagemodel')||'').trim();
  if(!model) model = modelFromEventData(pick('eventdata','Event data','msdyn_eventdata'));

  const row = {
    date:     parseDate(pick('date','processed','Processed time','msdyn_processingdate')),
    tool:     String(pick('tool','Tool name','toolname')||'').trim(),
    credits:  num(pick('credits','Estimated consumption','AI Builder credits','msdyn_creditconsumed')),
    usedin:   String(used||'').trim(),
    datatype: String(pick('datatype','Data type')||'').trim(),
    model,
    template: String(pick('template','Model template','capability','Capability')||'').trim(),
    flow:     String(pick('flow','Automation name')||'').trim(),
    env:      String(pick('env','Environment','environment')||'').trim(),
    quicktest: truthy(pick('quicktest','Quick test'))
  };

  /* A pre-aggregated sheet can carry a run count, so one row may represent many runs. */
  const rc = num(pick('runs','Runs'));
  row.runs = rc > 0 ? rc : 1;
  if(!row.tool) row.tool = row.template ? row.template : '(unnamed)';

  const c = classify(row, promptDefault);
  row.cap = c.cap; row.conf = c.conf; row.basis = c.basis;

  const def = CAPS[row.cap];
  row.ccCredits = (def && def.aib > 0) ? row.credits * (def.cc / def.aib) : 0;
  return row;
}

/*
 Project a raw msdyn_aievent Web API record into buildRow() input.

 `lookups.models` maps msdyn_aimodelid -> { name, templateId } and
 `lookups.templates` maps msdyn_aitemplateid -> unique name. Both are optional;
 without them prompt rows fall back to tool-name and language-model inference.
*/
export function fromDataverseEvent(rec, lookups = {}, envName = ''){
  const models = lookups.models || {};
  const templates = lookups.templates || {};
  const modelId = rec['_msdyn_aimodelid_value'] || '';
  const mi = models[String(modelId)] || null;
  const templateName = mi && mi.templateId ? (templates[String(mi.templateId)] || '') : '';

  const usedIn = rec['msdyn_consumptionsource@OData.Community.Display.V1.FormattedValue']
              ?? rec.msdyn_consumptionsource;
  const status = rec['msdyn_processingstatus@OData.Community.Display.V1.FormattedValue']
              ?? rec.msdyn_processingstatus;

  return {
    env: envName,
    processed: rec.msdyn_processingdate,
    tool: (mi && mi.name) ? mi.name : (rec.msdyn_name || ''),
    template: templateName,
    eventdata: rec.msdyn_eventdata,
    datatype: rec.msdyn_datatype,
    credits: rec.msdyn_creditconsumed,
    usedin: usedIn,
    flow: rec.msdyn_automationname,
    quicktest: rec.msdyn_quicktest,
    status
  };
}

/* Aggregate classified rows into the totals the UI reports. */
export function summarize(rows){
  const byCap = new Map();
  const byEnv = new Map();
  const byMonth = new Map();
  const byTool = new Map();
  const byConf = new Map();
  let runs = 0, credits = 0, cc = 0, unclassified = 0;

  for(const r of rows){
    runs += r.runs;
    credits += r.credits;
    cc += r.ccCredits;
    if(!r.cap) unclassified += r.runs;

    const capKey = r.cap || '(unclassified)';
    const c = byCap.get(capKey) || {cap:capKey, name:(CAPS[r.cap] ? CAPS[r.cap].name : 'Unclassified'), runs:0, credits:0, cc:0};
    c.runs += r.runs; c.credits += r.credits; c.cc += r.ccCredits;
    byCap.set(capKey, c);

    const envKey = r.env || '(unknown)';
    const e = byEnv.get(envKey) || {env:envKey, runs:0, credits:0, cc:0};
    e.runs += r.runs; e.credits += r.credits; e.cc += r.ccCredits;
    byEnv.set(envKey, e);

    if(r.date){
      const mk = r.date.getFullYear()+'-'+String(r.date.getMonth()+1).padStart(2,'0');
      const m = byMonth.get(mk) || {month:mk, runs:0, credits:0, cc:0};
      m.runs += r.runs; m.credits += r.credits; m.cc += r.ccCredits;
      byMonth.set(mk, m);
    }

    /* Per-tool consumption, so you can see which makers' tools actually
       drive the bill and which language model each one runs on. */
    const toolKey = r.tool || '(unnamed)';
    const t = byTool.get(toolKey) || {
      tool: toolKey, template: r.template || '', env: r.env || '',
      models: new Set(), caps: new Set(), confs: new Set(),
      runs: 0, credits: 0, cc: 0
    };
    if(r.model) t.models.add(r.model);
    t.caps.add(r.cap || '(unclassified)');
    t.confs.add(r.conf || 'none');
    t.runs += r.runs; t.credits += r.credits; t.cc += r.ccCredits;
    byTool.set(toolKey, t);

    const conf = r.conf || 'none';
    byConf.set(conf, (byConf.get(conf) || 0) + r.runs);
  }

  const sortDesc = (a,b) => b.credits - a.credits;
  return {
    runs, credits,
    ccCredits: cc,
    usd: cc * CC_USD,
    unclassified,
    classifiedPct: runs ? ((runs - unclassified) / runs) * 100 : 0,
    byCapability: [...byCap.values()].sort(sortDesc),
    byEnvironment: [...byEnv.values()].sort(sortDesc),
    byMonth: [...byMonth.values()].sort((a,b) => a.month.localeCompare(b.month)),
    /* Sets are not JSON-serializable and these aggregates get persisted. */
    byTool: [...byTool.values()]
      .map(t => ({...t, models:[...t.models], caps:[...t.caps], confs:[...t.confs]}))
      .sort(sortDesc),
    byConfidence: ['high','medium','low','none']
      .map(k => ({conf:k, runs: byConf.get(k) || 0}))
      .filter(x => x.runs > 0)
  };
}
