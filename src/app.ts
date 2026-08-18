/// <reference types="@pptb/types" />

/**
 * AI Builder Credit Analyzer — Power Platform ToolBox tool.
 *
 * Reads msdyn_aievent (plus the AI model and template lookups needed to identify each
 * run) from the connected Dataverse environment, classifies every run to an AI Builder
 * capability, and estimates the equivalent consumption in Copilot Credits.
 *
 * The costing logic lives in src/credit-engine.js and is regression-tested by
 * test/verify-engine.mjs.
 */

import {
    buildRow,
    summarize,
    fromDataverseEvent,
    CAPS,
    CC_USD
} from './credit-engine.js';

const toolbox = window.toolboxAPI;
const dataverse = window.dataverseAPI;

const SETTINGS_KEY = 'scans.v2';
const PAGE_SIZE = 5000;
const MAX_PAGES = 200;
/** DOM cap for the detail table. Everything is still exported and still counted. */
const MAX_DETAIL_ROWS = 1000;

interface CapAggregate { cap: string; name: string; runs: number; credits: number; cc: number; }
interface MonthAggregate { month: string; runs: number; credits: number; cc: number; }
interface ConfAggregate { conf: string; runs: number; }
interface ToolAggregate {
    tool: string; template: string; env: string;
    models: string[]; caps: string[]; confs: string[];
    runs: number; credits: number; cc: number;
}

interface EnvAggregate {
    key: string;
    name: string;
    url: string;
    scannedAt: string;
    days: number;
    excludedQuickTests: boolean;
    quickTests: number;
    runs: number;
    credits: number;
    cc: number;
    unclassified: number;
    byCapability: CapAggregate[];
    byMonth: MonthAggregate[];
    byTool: ToolAggregate[];
    byConfidence: ConfAggregate[];
}

interface ClassifiedRow {
    date: Date | null; tool: string; credits: number; usedin: string; datatype: string;
    model: string; template: string; flow: string; env: string; quicktest: boolean;
    runs: number; cap: string | null; conf: string; basis: string; ccCredits: number;
}

let connection: ToolBoxAPI.Connection | null = null;
let scans: Record<string, EnvAggregate> = {};
/** Raw classified rows per environment scanned in this session. Never persisted. */
let sessionRows: Record<string, ClassifiedRow[]> = {};

/* ------------------------------------------------------------------ helpers */

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (s: unknown) =>
    String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const fmt = (n: number, dp = 0) =>
    n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });

const capName = (cap: string | null) => {
    const def = (CAPS as Record<string, { name: string } | undefined>)[cap ?? ''];
    return def ? def.name : 'Unclassified';
};

function notify(title: string, body: string, type: 'info' | 'success' | 'warning' | 'error') {
    try {
        toolbox.utils.showNotification({ title, body, type });
    } catch (e) {
        console.error('Notification failed', e);
    }
}

/** Map a Dataverse HTTP failure to something an admin can act on. */
function describeError(error: unknown): string {
    const err = error as { status?: number; message?: string };
    const status = err?.status;
    if (status === 401) return 'Authentication failed — reconnect the environment and try again.';
    if (status === 403) return 'You do not have permission to read AI Builder activity in this environment.';
    if (status === 404) return 'The AI Event table was not found. AI Builder may not be provisioned in this environment.';
    if (status === 429) return 'Dataverse is throttling the request. Wait a moment and scan again.';
    if (status && status >= 500) return 'Dataverse returned a server error. Try again shortly.';
    return err?.message || 'Unexpected error.';
}

function setStatus(msg: string, kind: 'info' | 'error' = 'info') {
    const el = $('scan-status');
    el.className = 'status ' + (kind === 'error' ? 'status-error' : 'status-info');
    el.textContent = msg;
}

/* ------------------------------------------------------------ FetchXML layer */

function attrs(names: string[]): string {
    return names.map(n => `<attribute name="${n}" />`).join('');
}

/**
 * Pull every page of a FetchXML query.
 *
 * queryData() cannot page (it returns no nextLink), so anything that might exceed the
 * 5,000-row page cap has to go through fetchXmlQuery and its paging cookie. Falls back
 * to plain page increments if the cookie cannot be parsed.
 */
async function fetchAllPages(
    buildFetch: (page: number, cookie: string | null) => string,
    onProgress?: (soFar: number) => void
): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let page = 1;
    let cookie: string | null = null;

    while (page <= MAX_PAGES) {
        const result = await dataverse.fetchXmlQuery(buildFetch(page, cookie));
        const batch = result?.value ?? [];
        out.push(...batch);
        if (onProgress) onProgress(out.length);

        if (batch.length < PAGE_SIZE) break;

        const rawCookie = result['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie'];
        cookie = rawCookie ? extractCookie(String(rawCookie)) : null;
        page++;
    }
    return out;
}

/** The service returns the cookie wrapped in a <cookie> element and double-encoded. */
function extractCookie(raw: string): string | null {
    const m = /pagingcookie="(.*?)"/.exec(raw);
    if (!m) return null;
    try {
        return decodeURIComponent(decodeURIComponent(m[1]));
    } catch {
        return null;
    }
}

function pagingAttrs(page: number, cookie: string | null): string {
    const c = cookie ? ` paging-cookie="${esc(cookie)}"` : '';
    return ` page="${page}" count="${PAGE_SIZE}"${c}`;
}

async function loadTemplates(): Promise<Record<string, string>> {
    const rows = await fetchAllPages((page, cookie) =>
        `<fetch${pagingAttrs(page, cookie)}><entity name="msdyn_aitemplate">` +
        attrs(['msdyn_aitemplateid', 'msdyn_uniquename']) +
        `</entity></fetch>`);

    const map: Record<string, string> = {};
    for (const r of rows) {
        const id = String(r['msdyn_aitemplateid'] ?? '');
        if (id) map[id] = String(r['msdyn_uniquename'] ?? '');
    }
    return map;
}

async function loadModels(): Promise<Record<string, { name: string; templateId: string }>> {
    const rows = await fetchAllPages((page, cookie) =>
        `<fetch${pagingAttrs(page, cookie)}><entity name="msdyn_aimodel">` +
        attrs(['msdyn_aimodelid', 'msdyn_name', 'msdyn_templateid']) +
        `</entity></fetch>`);

    const map: Record<string, { name: string; templateId: string }> = {};
    for (const r of rows) {
        const id = String(r['msdyn_aimodelid'] ?? '');
        if (!id) continue;
        map[id] = {
            name: String(r['msdyn_name'] ?? ''),
            templateId: String(r['_msdyn_templateid_value'] ?? r['msdyn_templateid'] ?? '')
        };
    }
    return map;
}

async function loadEvents(sinceIso: string): Promise<Record<string, unknown>[]> {
    return fetchAllPages(
        (page, cookie) =>
            `<fetch${pagingAttrs(page, cookie)}><entity name="msdyn_aievent">` +
            attrs([
                'msdyn_aieventid', 'msdyn_name', 'msdyn_creditconsumed', 'msdyn_processingdate',
                'msdyn_consumptionsource', 'msdyn_datatype', 'msdyn_automationname',
                'msdyn_quicktest', 'msdyn_processingstatus', 'msdyn_eventdata', 'msdyn_aimodelid'
            ]) +
            `<filter><condition attribute="msdyn_processingdate" operator="ge" value="${esc(sinceIso)}" /></filter>` +
            `<order attribute="msdyn_processingdate" descending="true" />` +
            `</entity></fetch>`,
        soFar => setStatus(`Reading AI Builder activity… ${fmt(soFar)} rows so far.`)
    );
}

/* ------------------------------------------------------------------- scanning */

async function scan() {
    if (!connection) {
        notify('No connection', 'Connect to a Dataverse environment first.', 'warning');
        return;
    }

    const btn = $('scan-btn') as HTMLButtonElement;
    const days = parseInt((($('days') as HTMLSelectElement).value) || '90', 10);
    const excludeQt = ($('exclude-qt') as HTMLInputElement).checked;

    btn.disabled = true;
    $('scan-status').classList.remove('hide');

    try {
        setStatus('Reading AI model templates…');
        const templates = await loadTemplates();

        setStatus('Reading AI models…');
        const models = await loadModels();

        const since = new Date(Date.now() - days * 86400000).toISOString();
        setStatus('Reading AI Builder activity…');
        const events = await loadEvents(since);

        const envName = connection.name || connection.url;
        const all = events.map(e =>
            buildRow(fromDataverseEvent(e, { models, templates }, envName))) as ClassifiedRow[];
        const quickTests = all.filter(r => r.quicktest).length;
        const rows = excludeQt ? all.filter(r => !r.quicktest) : all;

        const key = connection.id || connection.url;
        sessionRows[key] = rows;

        const s = summarize(rows);
        scans[key] = {
            key,
            name: envName,
            url: connection.url,
            scannedAt: new Date().toISOString(),
            days,
            excludedQuickTests: excludeQt,
            quickTests,
            runs: s.runs,
            credits: s.credits,
            cc: s.ccCredits,
            unclassified: s.unclassified,
            byCapability: s.byCapability,
            byMonth: s.byMonth,
            byTool: s.byTool,
            byConfidence: s.byConfidence
        };
        await saveScans();
        renderAll();

        if (!events.length) {
            setStatus(`No AI Builder activity found in the last ${days} days.`);
            notify('Scan complete', 'No AI Builder activity in this window.', 'info');
        } else {
            setStatus(
                `Scanned ${envName}: ${fmt(events.length)} events, ${fmt(s.runs)} counted runs, ` +
                `${fmt(s.credits)} AI Builder credits. Switch connection and scan again to add another environment.`
            );
            notify('Scan complete', `${envName}: ${fmt(s.credits)} AI Builder credits.`, 'success');
        }
    } catch (error) {
        console.error('Scan failed', error);
        setStatus(describeError(error), 'error');
        notify('Scan failed', describeError(error), 'error');
    } finally {
        btn.disabled = false;
    }
}

/* ------------------------------------------------------------------ rendering */

function totalsHtml(t: { runs: number; credits: number; cc: number; unclassified: number }): string {
    const usd = t.cc * CC_USD;
    const classified = t.runs ? ((t.runs - t.unclassified) / t.runs) * 100 : 0;
    const cards: [string, string][] = [
        ['Counted runs', fmt(t.runs)],
        ['AI Builder credits', fmt(t.credits)],
        ['Copilot Credits (est.)', fmt(t.cc, 1)],
        ['Estimated cost', '$' + fmt(usd, 2)],
        ['Identified', fmt(classified, 0) + '%']
    ];
    return cards
        .map(([label, value]) =>
            `<div class="stat"><span class="stat-value">${esc(value)}</span><span class="stat-label">${esc(label)}</span></div>`)
        .join('');
}

const CONF_LABEL: Record<string, string> = {
    high: 'High — matched on model template or language model',
    medium: 'Medium — matched on tool name, or prompt tier assumed',
    low: 'Low — inferred from tool name or data type',
    none: 'Unidentified — not costed'
};

function confidenceHtml(list: ConfAggregate[], totalRuns: number): string {
    if (!list.length) return '';
    const rows = list.map(c => {
        const pct = totalRuns ? (c.runs / totalRuns) * 100 : 0;
        return `<tr><td><span class="conf conf-${esc(c.conf)}">${esc(c.conf)}</span></td>` +
            `<td>${esc(CONF_LABEL[c.conf] || '')}</td>` +
            `<td class="num">${fmt(c.runs)}</td><td class="num">${fmt(pct, 1)}%</td></tr>`;
    }).join('');
    return `<h3>Classification confidence</h3>` +
        `<p class="hint">How each run was matched to a capability. Lower confidence means the ` +
        `Copilot Credit figure for those runs is more likely to be off.</p>` +
        `<div class="tblwrap"><table><thead><tr><th>Confidence</th><th>How it was matched</th>` +
        `<th class="num">Runs</th><th class="num">Share</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function capTableHtml(title: string, caps: CapAggregate[]): string {
    if (!caps.length) return '';
    const rows = caps.map(c =>
        `<tr><td>${esc(capName(c.cap === '(unclassified)' ? null : c.cap))}</td>` +
        `<td class="num">${fmt(c.runs)}</td>` +
        `<td class="num">${fmt(c.credits)}</td><td class="num">${fmt(c.cc, 1)}</td>` +
        `<td class="num">$${fmt(c.cc * CC_USD, 2)}</td></tr>`).join('');
    return `<h3>${esc(title)}</h3><div class="tblwrap"><table>` +
        `<thead><tr><th>Capability</th><th class="num">Runs</th><th class="num">AI Builder credits</th>` +
        `<th class="num">Copilot Credits (est.)</th><th class="num">Est. cost</th></tr></thead>` +
        `<tbody>${rows}</tbody></table></div>`;
}

function mergeAggregates(list: EnvAggregate[]) {
    const caps = new Map<string, CapAggregate>();
    const months = new Map<string, MonthAggregate>();
    const tools = new Map<string, ToolAggregate>();
    const confs = new Map<string, number>();
    let runs = 0, credits = 0, cc = 0, unclassified = 0;

    for (const env of list) {
        runs += env.runs; credits += env.credits; cc += env.cc; unclassified += env.unclassified;

        for (const c of env.byCapability) {
            const cur = caps.get(c.cap) || { cap: c.cap, name: c.name, runs: 0, credits: 0, cc: 0 };
            cur.runs += c.runs; cur.credits += c.credits; cur.cc += c.cc;
            caps.set(c.cap, cur);
        }
        for (const m of env.byMonth) {
            const cur = months.get(m.month) || { month: m.month, runs: 0, credits: 0, cc: 0 };
            cur.runs += m.runs; cur.credits += m.credits; cur.cc += m.cc;
            months.set(m.month, cur);
        }
        /* Same tool name can exist in several environments — keep them distinct. */
        for (const t of env.byTool ?? []) {
            const k = env.name + '\u0000' + t.tool;
            const cur = tools.get(k) || {
                tool: t.tool, template: t.template, env: env.name,
                models: [], caps: [], confs: [], runs: 0, credits: 0, cc: 0
            };
            cur.models = [...new Set([...cur.models, ...t.models])];
            cur.caps = [...new Set([...cur.caps, ...t.caps])];
            cur.confs = [...new Set([...cur.confs, ...t.confs])];
            cur.runs += t.runs; cur.credits += t.credits; cur.cc += t.cc;
            tools.set(k, cur);
        }
        for (const c of env.byConfidence ?? []) {
            confs.set(c.conf, (confs.get(c.conf) || 0) + c.runs);
        }
    }

    return {
        runs, credits, cc, unclassified,
        byCapability: [...caps.values()].sort((a, b) => b.credits - a.credits),
        byMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
        byTool: [...tools.values()].sort((a, b) => b.credits - a.credits),
        byConfidence: ['high', 'medium', 'low', 'none']
            .map(k => ({ conf: k, runs: confs.get(k) || 0 }))
            .filter(x => x.runs > 0)
    };
}

/** The weakest confidence seen for a tool — the honest one to show. */
function worstConf(confs: string[]): string {
    for (const c of ['none', 'low', 'medium', 'high']) if (confs.includes(c)) return c;
    return 'high';
}

function renderCoverage(list: EnvAggregate[]) {
    if (!list.length) { $('env-coverage').innerHTML = ''; return; }
    const names = list.map(e => esc(e.name)).join(', ');
    $('env-coverage').innerHTML =
        `<strong>${list.length} environment${list.length === 1 ? '' : 's'} scanned:</strong> ${names}. ` +
        `<span class="muted">Any environment not listed here is not included in these totals — ` +
        `switch the ToolBox connection and scan it to add it.</span>`;
}

function renderSummary(list: EnvAggregate[]) {
    const merged = mergeAggregates(list);
    $('rollup-totals').innerHTML = totalsHtml(merged);
    $('confidence').innerHTML = confidenceHtml(merged.byConfidence, merged.runs);

    const envRows = list
        .slice()
        .sort((a, b) => b.credits - a.credits)
        .map(e => {
            const when = new Date(e.scannedAt).toLocaleString();
            const qt = e.excludedQuickTests && e.quickTests ? `${fmt(e.quickTests)} excluded` : '—';
            return `<tr><td>${esc(e.name)}</td><td class="num">${fmt(e.runs)}</td>` +
                `<td class="num">${fmt(e.credits)}</td><td class="num">${fmt(e.cc, 1)}</td>` +
                `<td class="num">$${fmt(e.cc * CC_USD, 2)}</td><td>${esc(e.days)}d</td>` +
                `<td class="muted">${esc(qt)}</td><td class="muted">${esc(when)}</td>` +
                `<td><button class="btn btn-sm btn-secondary remove-env" data-key="${esc(e.key)}">Remove</button></td></tr>`;
        }).join('');

    $('by-environment').innerHTML =
        `<h3>By environment</h3><div class="tblwrap"><table>` +
        `<thead><tr><th>Environment</th><th class="num">Runs</th><th class="num">AI Builder credits</th>` +
        `<th class="num">Copilot Credits (est.)</th><th class="num">Est. cost</th><th>Window</th>` +
        `<th>Quick tests</th><th>Scanned</th><th></th></tr></thead><tbody>${envRows}</tbody></table></div>`;

    $('rollup-by-capability').innerHTML = capTableHtml('By capability', merged.byCapability);

    const monthRows = merged.byMonth.map(m =>
        `<tr><td>${esc(m.month)}</td><td class="num">${fmt(m.runs)}</td>` +
        `<td class="num">${fmt(m.credits)}</td><td class="num">${fmt(m.cc, 1)}</td>` +
        `<td class="num">$${fmt(m.cc * CC_USD, 2)}</td></tr>`).join('');
    $('by-month').innerHTML = merged.byMonth.length
        ? `<h3>By month</h3><div class="tblwrap"><table><thead><tr><th>Month</th><th class="num">Runs</th>` +
          `<th class="num">AI Builder credits</th><th class="num">Copilot Credits (est.)</th>` +
          `<th class="num">Est. cost</th></tr></thead><tbody>${monthRows}</tbody></table></div>`
        : '';

    document.querySelectorAll('.remove-env').forEach(btn =>
        btn.addEventListener('click', async () => {
            const key = (btn as HTMLElement).dataset.key;
            if (key && scans[key]) {
                delete scans[key];
                delete sessionRows[key];
                await saveScans();
                renderAll();
            }
        }));
}

function renderTools(list: EnvAggregate[]) {
    const merged = mergeAggregates(list);
    const q = (($('tool-filter') as HTMLInputElement)?.value || '').trim().toLowerCase();

    const matches = merged.byTool.filter(t => {
        if (!q) return true;
        const hay = [t.tool, t.template, t.env, ...t.models, ...t.caps.map(c => capName(c))]
            .join(' ').toLowerCase();
        return hay.includes(q);
    });

    if (!matches.length) {
        $('by-tool').innerHTML = `<p class="hint">No tools match that filter.</p>`;
        return;
    }

    const rows = matches.slice(0, MAX_DETAIL_ROWS).map(t => {
        const conf = worstConf(t.confs);
        const models = t.models.length ? t.models.join(', ') : '—';
        const caps = t.caps.map(c => capName(c === '(unclassified)' ? null : c)).join(', ');
        return `<tr><td title="${esc(t.tool)}">${esc(t.tool)}</td>` +
            `<td class="muted">${esc(t.env)}</td>` +
            `<td>${esc(t.template || '—')}</td>` +
            `<td>${esc(models)}</td>` +
            `<td>${esc(caps)}</td>` +
            `<td><span class="conf conf-${esc(conf)}">${esc(conf)}</span></td>` +
            `<td class="num">${fmt(t.runs)}</td>` +
            `<td class="num">${fmt(t.credits)}</td>` +
            `<td class="num">${fmt(t.cc, 1)}</td>` +
            `<td class="num">$${fmt(t.cc * CC_USD, 2)}</td></tr>`;
    }).join('');

    const capped = matches.length > MAX_DETAIL_ROWS
        ? `<p class="hint">Showing the top ${fmt(MAX_DETAIL_ROWS)} of ${fmt(matches.length)} tools by credits.</p>`
        : '';

    $('by-tool').innerHTML = capped +
        `<div class="tblwrap"><table><thead><tr><th>Tool</th><th>Environment</th><th>Template</th>` +
        `<th>Language model</th><th>Capability</th><th>Confidence</th><th class="num">Runs</th>` +
        `<th class="num">AI Builder credits</th><th class="num">Copilot Credits (est.)</th>` +
        `<th class="num">Est. cost</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function allSessionRows(): ClassifiedRow[] {
    return Object.values(sessionRows).flat();
}

function renderEvents() {
    const all = allSessionRows();
    if (!all.length) {
        $('events').innerHTML =
            `<p class="hint">No runs loaded in this session. Scan an environment to see individual runs. ` +
            `Detail from earlier sessions is not retained — only the aggregates on the other tabs.</p>`;
        return;
    }

    const q = (($('event-filter') as HTMLInputElement)?.value || '').trim().toLowerCase();
    const matches = all.filter(r => {
        if (!q) return true;
        return [r.tool, r.template, r.model, r.env, r.usedin, r.flow, capName(r.cap)]
            .join(' ').toLowerCase().includes(q);
    }).sort((a, b) => b.credits - a.credits);

    if (!matches.length) {
        $('events').innerHTML = `<p class="hint">No runs match that filter.</p>`;
        return;
    }

    const rows = matches.slice(0, MAX_DETAIL_ROWS).map(r => {
        const when = r.date ? r.date.toLocaleString() : '—';
        return `<tr><td class="muted">${esc(when)}</td>` +
            `<td>${esc(r.tool)}</td>` +
            `<td class="muted">${esc(r.env)}</td>` +
            `<td>${esc(r.template || '—')}</td>` +
            `<td>${esc(r.model || '—')}</td>` +
            `<td>${esc(capName(r.cap))}</td>` +
            `<td><span class="conf conf-${esc(r.conf)}" title="${esc(r.basis)}">${esc(r.conf)}</span></td>` +
            `<td class="muted">${esc(r.usedin || '—')}</td>` +
            `<td class="num">${fmt(r.credits)}</td>` +
            `<td class="num">${fmt(r.ccCredits, 2)}</td></tr>`;
    }).join('');

    const capped = matches.length > MAX_DETAIL_ROWS
        ? `<p class="hint">Showing the top ${fmt(MAX_DETAIL_ROWS)} of ${fmt(matches.length)} runs by credits. Export for the full list.</p>`
        : `<p class="hint">${fmt(matches.length)} run${matches.length === 1 ? '' : 's'}.</p>`;

    $('events').innerHTML = capped +
        `<div class="tblwrap"><table><thead><tr><th>Processed</th><th>Tool</th><th>Environment</th>` +
        `<th>Template</th><th>Language model</th><th>Capability</th><th>Confidence</th><th>Used in</th>` +
        `<th class="num">AI Builder credits</th><th class="num">Copilot Credits (est.)</th>` +
        `</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderAll() {
    const list = Object.values(scans);
    const card = $('results-card');
    if (!list.length) { card.classList.add('hide'); return; }
    card.classList.remove('hide');

    renderCoverage(list);
    renderSummary(list);
    renderTools(list);
    renderEvents();
}

function renderRateTable() {
    const rows = Object.keys(CAPS).map(id => {
        const c = (CAPS as Record<string, { name: string; unit: string; cc: number; aib: number }>)[id];
        const ratio = c.aib > 0 ? c.cc / c.aib : 0;
        return `<tr><td>${esc(c.name)}</td><td>${esc(c.unit)}</td>` +
            `<td class="num">${c.aib || '—'}</td><td class="num">${c.cc || '—'}</td>` +
            `<td class="num">${c.aib > 0 ? ratio.toFixed(4) : '—'}</td></tr>`;
    }).join('');
    $('rate-table').innerHTML =
        `<div class="tblwrap"><table><thead><tr><th>Capability</th><th>Unit</th>` +
        `<th class="num">AI Builder credits</th><th class="num">Copilot Credits</th>` +
        `<th class="num">Ratio</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* -------------------------------------------------------------- persistence */

async function saveScans() {
    try {
        await toolbox.settings.set(SETTINGS_KEY, scans);
    } catch (e) {
        console.error('Could not persist scans', e);
        notify('Could not save', 'Scan results could not be persisted between sessions.', 'warning');
    }
}

async function loadScans() {
    try {
        const stored = await toolbox.settings.get(SETTINGS_KEY);
        if (stored && typeof stored === 'object') scans = stored as Record<string, EnvAggregate>;
    } catch (e) {
        console.error('Could not read stored scans', e);
    }
}

/* ------------------------------------------------------------------- exports */

function toCsv(rows: ClassifiedRow[]): string {
    const cols: (keyof ClassifiedRow)[] = ['env', 'date', 'tool', 'template', 'model', 'datatype',
        'usedin', 'flow', 'credits', 'runs', 'cap', 'ccCredits', 'conf', 'basis'];
    const cell = (v: unknown) => {
        const s = v instanceof Date ? v.toISOString() : String(v ?? '');
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n');
}

async function exportRows(kind: 'json' | 'csv') {
    const rows = allSessionRows();
    if (!rows.length) {
        notify('Nothing to export', 'Scan an environment first.', 'warning');
        return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `ai-builder-activity-${stamp}.${kind}`;
    const content = kind === 'json' ? JSON.stringify(rows, null, 1) : toCsv(rows);

    try {
        const saved = await toolbox.fileSystem.saveFile(name, content, [
            { name: kind.toUpperCase(), extensions: [kind] }
        ]);
        if (saved) notify('Exported', `Saved ${fmt(rows.length)} runs.`, 'success');
    } catch (error) {
        console.error('Export failed', error);
        notify('Export failed', describeError(error), 'error');
    }
}

/* ---------------------------------------------------------------------- init */

function wireTabs() {
    document.querySelectorAll('.tab').forEach(tab =>
        tab.addEventListener('click', () => {
            const name = (tab as HTMLElement).dataset.tab;
            document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
            ['summary', 'tools', 'events'].forEach(p =>
                $('panel-' + p).classList.toggle('hide', p !== name));
        }));
}

async function showConnection() {
    const badge = $('conn-badge');
    const box = $('connection-info');

    if (!connection) {
        badge.textContent = 'Not connected';
        badge.className = 'badge badge-warn';
        box.innerHTML = '<p class="warn">No environment is connected. Choose a connection in Power Platform ToolBox, then reopen this tool.</p>';
        ($('scan-btn') as HTMLButtonElement).disabled = true;
        return;
    }

    badge.textContent = connection.environment || 'Connected';
    badge.className = 'badge badge-ok';
    ($('scan-btn') as HTMLButtonElement).disabled = false;

    const key = connection.id || connection.url;
    const prior = scans[key];
    const priorNote = prior
        ? `<div class="kv"><span>Last scan</span><strong>${esc(new Date(prior.scannedAt).toLocaleString())} — rescanning replaces it</strong></div>`
        : '';

    box.innerHTML =
        `<div class="kv"><span>Name</span><strong>${esc(connection.name)}</strong></div>` +
        `<div class="kv"><span>URL</span><strong>${esc(connection.url)}</strong></div>` +
        priorNote;
}

async function initialize() {
    renderRateTable();
    wireTabs();

    try {
        connection = await toolbox.connections.getActiveConnection();
    } catch (error) {
        console.error('Could not read the active connection', error);
        connection = null;
    }
    await showConnection();

    await loadScans();
    renderAll();

    $('scan-btn').addEventListener('click', scan);
    $('export-json-btn').addEventListener('click', () => exportRows('json'));
    $('export-csv-btn').addEventListener('click', () => exportRows('csv'));
    $('tool-filter').addEventListener('input', () => renderTools(Object.values(scans)));
    $('event-filter').addEventListener('input', renderEvents);
    $('clear-btn').addEventListener('click', async () => {
        scans = {};
        sessionRows = {};
        await saveScans();
        renderAll();
        await showConnection();
        notify('Cleared', 'All stored environment scans were removed.', 'info');
    });

    try {
        toolbox.events.on((_event, payload) => {
            try {
                const name = (payload as { event?: string })?.event;
                if (name && name.startsWith('connection:')) {
                    toolbox.connections.getActiveConnection()
                        .then(c => { connection = c; return showConnection(); })
                        .catch(e => console.error('Connection refresh failed', e));
                }
            } catch (e) {
                console.error('Event handler error', e);
            }
        });
    } catch (e) {
        console.error('Could not subscribe to events', e);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    void initialize();
}
