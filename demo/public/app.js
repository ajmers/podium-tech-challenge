// GatewayKit demo UI. Plain DOM, no framework. All text is set with
// textContent, so request/response data can never inject markup.

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return res.json();
}

const pretty = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const statusClass = (code) => `s${String(code)[0]}`;

// ── State ──────────────────────────────────────────────────────────────────
let scenarios = [];
const results = new Map(); // id -> { status: 'running' | 'pass' | 'fail', data }
let selectedId = null;

// ── Header: gateway + upstreams ───────────────────────────────────────────
async function refreshState() {
  const state = await api('/api/state');
  $('#gateway-url').textContent = state.gatewayUrl;
  $('#config-path').textContent = state.configPath;
  renderUpstreams(state.upstreams);
  routesState = state.routes;
  renderRoutes(state);
  renderBalancer();
}

const lastCounts = new Map();
let routesState = [];

function renderUpstreams(upstreams) {
  const hits = new Set(upstreams.filter((u) => lastCounts.has(u.id) && u.requestCount > lastCounts.get(u.id)).map((u) => u.id));
  for (const u of upstreams) lastCounts.set(u.id, u.requestCount);
  $('#upstream-list').replaceChildren(
    ...upstreams.map((u) =>
      el(
        'div',
        { class: `upstream ${u.up ? '' : 'down'} ${hits.has(u.id) ? 'hit' : ''}`, title: u.up ? 'Running' : 'Stopped' },
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('span', { class: 'id' }, u.id),
        el('span', { class: 'routes' }, u.routes.join(', ')),
        el('span', { class: 'count', title: 'Requests received' }, `${u.requestCount} req`),
        el(
          'button',
          {
            onclick: async () => {
              const state = await api(`/api/upstreams/${encodeURIComponent(u.id)}/${u.up ? 'stop' : 'start'}`, { method: 'POST' });
              renderUpstreams(state.upstreams);
            },
          },
          u.up ? 'Stop' : 'Start',
        ),
      ),
    ),
  );
}

function renderRoutes(state) {
  const implemented = new Set(state.implementedFeatures);
  $('#routes-table').replaceChildren(
    el('thead', {}, el('tr', {}, ['Path', 'Methods', 'strip_prefix', 'Timeout', 'Upstreams', 'Rate limit', 'Features'].map((h) => el('th', {}, h)))),
    el(
      'tbody',
      {},
      state.routes.map((r) =>
        el(
          'tr',
          {},
          el('td', {}, el('code', {}, r.path)),
          el('td', {}, el('code', {}, r.methods ? r.methods.join(', ') : 'any')),
          el('td', {}, r.stripPrefix ? 'yes' : 'no'),
          el('td', {}, `${r.timeoutMs / 1000}s`),
          el('td', {}, r.upstreams.map((u) => el('div', {}, el('code', {}, u)))),
          el('td', {}, rateLimitCell(r.rateLimit)),
          el(
            'td',
            {},
            r.features.length
              ? r.features.map((f) => el('span', { class: `feature ${implemented.has(f) ? 'on' : 'off'}` }, f))
              : el('span', { class: 'muted' }, '-'),
          ),
        ),
      ),
    ),
  );
}

function rateLimitCell(limit) {
  if (!limit) return el('span', { class: 'muted' }, 'none');
  return el(
    'div',
    { class: 'rate-limit' },
    el('code', {}, `${limit.requests} / ${limit.windowMs / 1000}s`),
    el('span', { class: 'feature on' }, limit.strategy),
    el('span', { class: 'feature on' }, `per ${limit.per}`),
    el('span', { class: 'muted source' }, limit.source === 'route' ? 'route rate_limit' : 'from global_rate_limit'),
  );
}

// ── Scenario list ─────────────────────────────────────────────────────────
function renderScenarioList() {
  const groups = [...new Set(scenarios.map((s) => s.group))];
  $('#scenario-list').replaceChildren(
    ...groups.flatMap((group) => [
      el('div', { class: 'group-label' }, group),
      ...scenarios
        .filter((s) => s.group === group)
        .map((s) =>
          el(
            'button',
            { class: `scenario-item ${s.id === selectedId ? 'active' : ''}`, onclick: () => select(s.id) },
            statusIcon(results.get(s.id)?.status ?? 'idle'),
            el('span', {}, s.title),
          ),
        ),
    ]),
  );

  const done = [...results.values()].filter((r) => r.status === 'pass' || r.status === 'fail');
  const passed = done.filter((r) => r.status === 'pass').length;
  $('#run-summary').textContent = done.length ? `${passed}/${done.length} passing` : `${scenarios.length} scenarios`;
}

function statusIcon(status) {
  const glyph = { pass: '✓', fail: '✕', idle: '', running: '' }[status];
  return el('span', { class: `status-icon ${status}`, 'aria-label': status }, glyph);
}

function select(id) {
  selectedId = id;
  renderScenarioList();
  renderDetail();
}

// ── Scenario detail ───────────────────────────────────────────────────────
function renderDetail() {
  const scenario = scenarios.find((s) => s.id === selectedId);
  if (!scenario) return;
  const result = results.get(scenario.id);
  const running = result?.status === 'running';

  $('#scenario-detail').replaceChildren(
    el(
      'div',
      { class: 'detail-head' },
      el('div', {}, el('h2', {}, scenario.title), el('p', {}, scenario.description)),
      el('button', { class: 'btn primary', disabled: running, onclick: () => runScenario(scenario.id) }, running ? 'Running…' : result ? 'Run again' : 'Run'),
    ),
    result?.data
      ? el('div', {}, result.data.steps.map(renderStep))
      : el('p', { class: 'empty' }, running ? 'Sending requests through the gateway…' : 'Not run yet.'),
  );
}

function renderStep(step) {
  const allPass = step.checks?.every((c) => c.pass);
  return el(
    'article',
    { class: 'step' },
    el(
      'div',
      { class: 'step-head' },
      el('span', { class: 'label' }, step.label ?? `${step.request.method} ${step.request.path}`),
      step.checks ? statusIcon(allPass ? 'pass' : 'fail') : null,
    ),
    step.summary ? renderSummary(step.summary) : renderFlow(step),
    step.checks
      ? el(
          'ul',
          { class: 'checks' },
          step.checks.map((c) => el('li', { class: c.pass ? 'pass' : 'fail' }, el('span', { class: 'tick' }, c.pass ? '✓' : '✕'), c.label)),
        )
      : null,
  );
}

function renderFlow({ request, response, upstream }) {
  return el(
    'div',
    { class: 'flow' },
    el(
      'section',
      { class: 'pane' },
      paneTitle('1', 'Client → Gateway'),
      el('div', { class: 'reqline' }, el('span', { class: 'method' }, request.method), request.path),
      headersBlock(request.headers),
      bodyBlock(request.body),
    ),
    el(
      'section',
      { class: 'pane' },
      paneTitle('2', 'Gateway → Upstream'),
      upstream.length === 0
        ? el('div', { class: 'not-reached' }, 'Not reached. The gateway answered on its own.')
        : upstream.map((u) =>
            el(
              'div',
              {},
              el(
                'div',
                { class: 'badges' },
                el('span', { class: 'badge neutral' }, u.upstream),
                u.aborted ? el('span', { class: 'badge err' }, 'cancelled by gateway') : null,
              ),
              el('div', { class: 'reqline' }, el('span', { class: 'method' }, u.method), u.url),
              headersBlock(u.headers),
              bodyBlock(u.body),
            ),
          ),
    ),
    el(
      'section',
      { class: 'pane' },
      paneTitle('3', 'Gateway → Client'),
      response.aborted
        ? el('div', { class: 'badges' }, el('span', { class: 'badge err' }, 'client hung up'), durationBadge(response))
        : response.error
          ? el('div', { class: 'badges' }, el('span', { class: 'badge err' }, response.error))
          : [
              el('div', { class: 'badges' }, el('span', { class: `badge ${statusClass(response.status)}` }, response.status), durationBadge(response)),
              headersBlock(response.headers),
              bodyBlock(response.body),
            ],
    ),
  );
}

function renderSummary(summary) {
  const statuses = Object.entries(summary.statusCounts).map(([code, n]) => `${n} × ${code}`).join(', ');
  return el(
    'div',
    { class: 'stats' },
    stat(summary.requests, 'requests'),
    stat(statuses, 'responses'),
    stat(`${summary.totalMs} ms`, 'total time'),
  );
}

const stat = (value, key) => el('div', { class: 'stat' }, el('div', { class: 'value' }, value), el('div', { class: 'key' }, key));
const paneTitle = (n, text) => el('div', { class: 'pane-title' }, el('span', { class: 'arrow' }, n), text);
const durationBadge = (response) => el('span', { class: 'badge neutral' }, `${response.durationMs} ms`);

function headersBlock(headers = {}) {
  const entries = Object.entries(headers);
  if (!entries.length) return null;
  return el('details', {}, el('summary', {}, `Headers (${entries.length})`), el('pre', { class: 'block' }, entries.map(([k, v]) => `${k}: ${v}`).join('\n')));
}

function bodyBlock(body) {
  if (body === undefined || body === null || body === '') return null;
  return el('pre', { class: 'block' }, pretty(body));
}

// ── Running scenarios ─────────────────────────────────────────────────────
async function runScenario(id) {
  results.set(id, { status: 'running' });
  renderScenarioList();
  if (id === selectedId) renderDetail();
  try {
    const data = await api(`/api/scenarios/${id}/run`, { method: 'POST' });
    results.set(id, { status: data.pass ? 'pass' : 'fail', data });
  } catch (err) {
    results.set(id, { status: 'fail', data: { steps: [{ label: 'Error', checks: [{ label: err.message, pass: false }], summary: { requests: 0, statusCounts: {}, totalMs: 0 } }] } });
  }
  renderScenarioList();
  if (id === selectedId) renderDetail();
  refreshState();
}

$('#run-all').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  for (const s of scenarios) results.delete(s.id);
  renderScenarioList();
  for (const s of scenarios) {
    if (!selectedId) select(s.id);
    await runScenario(s.id);
  }
  button.disabled = false;
});

// ── Playground ────────────────────────────────────────────────────────────
const PRESETS = [
  { label: 'Proxy GET', method: 'GET', path: '/api/users/42?expand=true' },
  { label: 'strip_prefix', method: 'GET', path: '/api/products/123' },
  { label: 'Load balancing (3:1)', method: 'GET', path: '/api/products/1' },
  { label: '405', method: 'POST', path: '/api/products/1', body: '{ "x": 1 }' },
  { label: '404', method: 'GET', path: '/api/nope' },
  { label: 'Auth: no key', method: 'GET', path: '/api/internal/data' },
  { label: 'Auth: valid key', method: 'GET', path: '/api/internal/data', headers: 'X-API-Key: sk_live_abc123' },
  { label: 'Upstream 503', method: 'GET', path: '/api/legacy/status/503' },
  { label: 'Timeout (5s)', method: 'GET', path: '/api/orders/slow?ms=6000' },
  { label: 'POST JSON', method: 'POST', path: '/api/users', body: '{ "name": "Ada" }' },
];

const form = $('#playground-form');
$('#presets').replaceChildren(
  el('span', { class: 'muted' }, 'Presets (click to send):'),
  ...PRESETS.map((p) =>
    el(
      'button',
      {
        type: 'button',
        onclick: (event) => {
          form.method.value = p.method;
          form.path.value = p.path;
          form.headers.value = p.headers ?? '';
          form.body.value = p.body ?? '';
          for (const b of $('#presets').querySelectorAll('button')) b.classList.toggle('active', b === event.currentTarget);
          // Presets send straight away, so every click shows a result.
          form.requestSubmit();
        },
      },
      p.label,
    ),
  ),
);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = form.querySelector('button[type=submit]');
  submit.disabled = true;
  const headers = {};
  for (const line of form.headers.value.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  let body = form.body.value.trim() || undefined;
  if (body) {
    try {
      body = JSON.parse(body);
    } catch {
      // send as text
    }
  }
  $('#playground-result').replaceChildren(el('p', { class: 'muted' }, 'Sending…'));
  const result = await api('/api/request', { method: 'POST', body: { method: form.method.value, path: form.path.value, headers, body } });
  const route = matchRoute(form.path.value);
  if (route && result.upstream[0]) servedHistory.push({ route: route.path, id: result.upstream[0].upstream });
  $('#playground-result').replaceChildren(renderStep(result));
  submit.disabled = false;
  refreshState();
});

// Mirrors src/router.js: longest route path that matches on a segment boundary.
function matchRoute(path) {
  const pathname = path.split('?')[0];
  return [...routesState]
    .sort((a, b) => b.path.length - a.path.length)
    .find((r) => r.path === '/' || pathname === r.path || pathname.startsWith(`${r.path}/`));
}

const servedHistory = [];

function renderBalancer() {
  const view = $('#balancer-view');
  const route = matchRoute(form.path.value);
  if (!route) {
    view.replaceChildren(el('div', { class: 'balancer muted' }, 'No route matches this path, so the gateway will answer 404 itself.'));
    return;
  }
  const last = servedHistory.at(-1);
  const total = route.targets.reduce((n, t) => n + t.weight, 0);
  view.replaceChildren(
    el(
      'div',
      { class: 'balancer' },
      el(
        'div',
        { class: 'balancer-head' },
        el('span', {}, 'Route ', el('code', {}, route.path), ' → load balancer'),
        el('span', { class: 'feature on' }, route.targets.length > 1 ? route.balance : 'single target'),
      ),
      el(
        'div',
        { class: 'targets' },
        route.targets.map((t) =>
          el(
            'div',
            { class: `target ${last?.route === route.path && last.id === t.id ? 'served' : ''}` },
            el('code', {}, t.id),
            route.targets.length > 1 ? el('span', { class: 'muted' }, `weight ${t.weight} · ${Math.round((t.weight / total) * 100)}%`) : null,
            el('span', { class: 'count' }, `${servedHistory.filter((h) => h.route === route.path && h.id === t.id).length} served`),
          ),
        ),
      ),
      el(
        'div',
        { class: 'history muted' },
        'Recent: ',
        servedHistory.filter((h) => h.route === route.path).slice(-12).map((h) => el('code', { class: 'pill-id' }, h.id.split(':')[1])),
      ),
    ),
  );
}

form.path.addEventListener('input', renderBalancer);
for (const button of $('#presets').querySelectorAll('button')) button.addEventListener('click', renderBalancer);

// ── Test suite ────────────────────────────────────────────────────────────
$('#run-tests').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  const output = $('#test-output');
  output.replaceChildren();
  $('#test-stats').replaceChildren();

  const res = await fetch('/api/test-run', { method: 'POST' });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let all = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    all += value;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) output.append(testLine(line));
    output.scrollTop = output.scrollHeight;
  }
  if (buffer) output.append(testLine(buffer));

  const count = (name) => Number(all.match(new RegExp(`ℹ ${name} (\\d+)`))?.[1] ?? 0);
  const pass = count('pass');
  const fail = count('fail');
  $('#test-stats').replaceChildren(
    el('span', { class: 'badge s2' }, `${pass} passed`),
    el('span', { class: `badge ${fail ? 's5' : 'neutral'}` }, `${fail} failed`),
  );
  button.disabled = false;
});

function testLine(line) {
  const trimmed = line.trimStart();
  const cls = trimmed.startsWith('✔')
    ? 'l-pass'
    : trimmed.startsWith('✖')
      ? 'l-fail'
      : trimmed.startsWith('▶')
        ? 'l-suite'
        : trimmed.startsWith('ℹ')
          ? 'l-info'
          : '';
  return el('span', { class: cls }, `${line}\n`);
}

// ── Tabs ──────────────────────────────────────────────────────────────────
for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[role=tab]')) t.setAttribute('aria-selected', String(t === tab));
    for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.id !== `tab-${tab.dataset.tab}`;
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────
scenarios = await api('/api/scenarios');
renderScenarioList();
refreshState();
