/* SDD dashboard — vanilla JS, READ-ONLY over docs/features/. It renders the
   pipeline + artifacts off disk and drives the pipeline back into the live
   Claude session (validated /sdd: commands). All edits happen through the
   pipeline in the terminal — the dashboard never writes artifact text. */
'use strict';

const qs = new URLSearchParams(location.search);
const TOKEN = qs.get('token') || '';
const SESSION = qs.get('session') || '';

const state = {
  features: [],
  slug: null,
  detail: null,
  artifact: null, // {path, kind, label, raw, mtime}
  runs: new Map(), // request_id -> {slug, command, phase: queued|running|done, verdict}
};

// ---- api -------------------------------------------------------------------

function withToken(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(TOKEN)}`;
}

async function api(path, opts = {}) {
  const res = await fetch(withToken(path), {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-sdd-token': TOKEN, ...(opts.headers || {}) },
  });
  return res;
}

async function apiJson(path, opts) {
  const res = await api(path, opts);
  if (!res.ok) {
    let msg = res.status;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(String(msg));
  }
  return res.json();
}

// ---- console / log ---------------------------------------------------------

const consoleLog = () => document.getElementById('console-log');

function logLine(kind, text) {
  const el = document.createElement('div');
  el.className = `log-line ${kind}`;
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = new Date().toLocaleTimeString();
  el.appendChild(ts);
  const body = document.createElement('span');
  body.textContent = text;
  el.appendChild(body);
  const log = consoleLog();
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

// ---- websocket -------------------------------------------------------------

let ws = null;
let wsRetry = 0;

function setConn(on, text) {
  const dot = document.getElementById('conn-dot');
  dot.className = 'dot ' + (on ? 'on' : 'off');
  document.getElementById('conn-text').textContent = text;
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(TOKEN)}&session=${encodeURIComponent(SESSION)}`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    const isReconnect = wsRetry > 0; // read before reset
    wsRetry = 0;
    setConn(true, 'connected');
    if (isReconnect) refresh(); // full re-sync — frames missed while disconnected
  };
  ws.onclose = () => {
    setConn(false, 'disconnected');
    wsRetry = Math.min(wsRetry + 1, 6);
    setTimeout(connectWs, 500 * wsRetry);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = (ev) => {
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    onFrame(frame);
  };
}

function onFrame(f) {
  switch (f.type) {
    case 'hello':
    case 'project':
      if (f.project) document.getElementById('project').textContent = f.project;
      break;
    case 'log':
      logLine(f.level || 'info', f.message + (f.slug ? `  ·${f.slug}` : ''));
      markRunning(f.slug);
      break;
    case 'command':
      logLine('command', `→ queued ${f.command}`);
      // Another tab (or a race with our own POST) queued it — track it too.
      if (f.request_id && !state.runs.has(f.request_id)) {
        state.runs.set(f.request_id, { slug: f.slug, command: f.command, phase: 'queued' });
        renderRuns();
      }
      break;
    case 'update':
      logLine('info', `[${f.stage}] ${f.status}${f.message ? ' — ' + f.message : ''}  ·${f.slug || ''}`);
      markRunning(f.slug);
      break;
    case 'done':
      logLine('done', `✓ ${f.stage} done — ${f.summary}${f.verdict ? ' [' + f.verdict + ']' : ''}`);
      if (f.next_command) logLine('system', `next: ${f.next_command}`);
      finishRun(f.slug, f.verdict);
      break;
    case 'ask':
      renderAsk(f);
      break;
    case 'answer':
      markAskAnswered(f.ask_id, f.option);
      logLine('system', `answered: ${f.label}`);
      break;
    case 'refresh':
      refresh(f.slug);
      break;
  }
}

// ---- run lifecycle (queued → running → done, one line per queued command) ----

function renderRuns() {
  const el = document.getElementById('run-status');
  const runs = [...state.runs.values()];
  if (!runs.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.className = 'run-status';
  el.innerHTML = '';
  for (const r of runs) {
    const line = document.createElement('div');
    line.className = 'run-line ' + r.phase;
    line.textContent =
      r.phase === 'queued' ? `queued: ${r.command} — runs when the session is idle at the prompt`
      : r.phase === 'running' ? `running ${r.command} in the session…`
      : `done ${r.command}${r.verdict ? ' — ' + r.verdict : ''}`;
    el.appendChild(line);
  }
}

// The dashboard_update/done frames carry a slug but no request_id (Claude does
// not know it), so queued→running→done correlation is by slug — approximate,
// but honest for the common one-run-per-feature case.
function findRun(phase, slug) {
  return [...state.runs.entries()].find(
    ([, r]) => r.phase === phase && (!slug || !r.slug || r.slug === slug),
  );
}

function markRunning(slug) {
  if (findRun('running', slug)) return; // already tracking one for this slug
  const entry = findRun('queued', slug);
  if (!entry) return;
  entry[1].phase = 'running';
  renderRuns();
}

function finishRun(slug, verdict) {
  const entry = findRun('running', slug) || findRun('queued', slug);
  if (!entry) return;
  entry[1].phase = 'done';
  entry[1].verdict = verdict || null;
  renderRuns();
  setTimeout(() => { state.runs.delete(entry[0]); renderRuns(); }, 60_000);
}

function currentDepth() {
  const el = document.getElementById('depth');
  return el && el.value ? el.value : 'easy';
}

async function runCommand(slug, command) {
  try {
    const res = await api('/api/command', {
      method: 'POST',
      body: JSON.stringify({ slug, command, depth: currentDepth() }),
    });
    const data = await res.json();
    if (!res.ok) { logLine('error', `command rejected: ${data.error || res.status}`); return; }
    state.runs.set(data.request_id, { slug, command: data.command, phase: 'queued' });
    renderRuns();
  } catch (e) {
    logLine('error', `command failed: ${e.message}`);
  }
}

// ---- decision questions (dashboard_ask → option click → /api/answer) --------

function renderAsk(f) {
  const card = document.createElement('div');
  card.className = 'ask-card';
  card.dataset.askId = f.ask_id;
  const q = document.createElement('div');
  q.className = 'ask-q';
  q.textContent = `? ${f.question}` + (f.slug ? `  ·${f.slug}` : '');
  card.appendChild(q);
  const opts = document.createElement('div');
  opts.className = 'ask-opts';
  (f.options || []).forEach((o, i) => {
    const b = document.createElement('button');
    b.className = 'ghost small';
    b.textContent = o.label;
    if (o.description) b.title = o.description;
    b.onclick = () => answerAsk(f.ask_id, i);
    opts.appendChild(b);
  });
  card.appendChild(opts);
  const hint = document.createElement('div');
  hint.className = 'ask-hint';
  hint.textContent = 'pick an option here, or answer in the terminal';
  card.appendChild(hint);
  const log = consoleLog();
  log.appendChild(card);
  log.scrollTop = log.scrollHeight;
}

async function answerAsk(askId, option) {
  try {
    const res = await api('/api/answer', { method: 'POST', body: JSON.stringify({ ask_id: askId, option }) });
    const data = await res.json();
    if (!res.ok) { logLine('error', `answer rejected: ${data.error || res.status}`); return; }
    markAskAnswered(askId, option);
  } catch (e) {
    logLine('error', `answer failed: ${e.message}`);
  }
}

function markAskAnswered(askId, option) {
  document.querySelectorAll('.ask-card').forEach((card) => {
    if (card.dataset.askId !== askId) return;
    card.classList.add('answered');
    [...card.querySelectorAll('button')].forEach((b, i) => {
      b.disabled = true;
      if (i === option) b.classList.add('picked');
    });
  });
}

// ---- feature list ----------------------------------------------------------

async function loadFeatures() {
  try {
    const data = await apiJson('/api/features');
    if (data.project) document.getElementById('project').textContent = data.project;
    state.features = data.features || [];
    renderFeatureList();
  } catch (e) {
    logLine('error', `could not load features: ${e.message}`);
  }
}

function renderFeatureList() {
  const ul = document.getElementById('feature-list');
  ul.innerHTML = '';
  if (state.features.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.style.padding = '10px';
    li.textContent = 'no features yet';
    ul.appendChild(li);
    return;
  }
  for (const f of state.features) {
    const li = document.createElement('li');
    li.className = 'feature-item' + (f.slug === state.slug ? ' active' : '');
    li.onclick = () => selectFeature(f.slug);

    const top = document.createElement('div');
    top.className = 'fi-top';
    const slug = document.createElement('span');
    slug.className = 'fi-slug';
    slug.textContent = f.slug;
    top.appendChild(slug);
    if (f.size) {
      const sz = document.createElement('span');
      sz.className = 'badge size';
      sz.textContent = f.size;
      top.appendChild(sz);
    }
    li.appendChild(top);

    const stage = document.createElement('div');
    stage.className = 'fi-stage';
    stage.textContent = f.shipped ? 'shipped' : f.stage + (f.progress ? `  ${f.progress.pct}%` : '');
    li.appendChild(stage);

    const mini = document.createElement('div');
    mini.className = 'mini-stepper';
    for (const s of f.stages) {
      const d = document.createElement('span');
      d.className = 'mini-dot ' + s.status;
      d.title = `${s.label}: ${s.status}`;
      mini.appendChild(d);
    }
    li.appendChild(mini);
    ul.appendChild(li);
  }
}

// ---- feature detail --------------------------------------------------------

async function selectFeature(slug) {
  state.slug = slug;
  state.artifact = null;
  renderFeatureList();
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('feature-view').classList.remove('hidden');
  await loadDetail(slug);
}

async function loadDetail(slug) {
  try {
    const d = await apiJson(`/api/feature/${encodeURIComponent(slug)}`);
    state.detail = d;
    renderDetail();
  } catch (e) {
    logLine('error', `could not load ${slug}: ${e.message}`);
  }
}

const STATUS_ICON = { done: '●', skipped: '◌', pending: '○', blocked: '✗' };

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  document.getElementById('f-title').textContent = d.title || d.slug;

  const badges = document.getElementById('f-badges');
  badges.innerHTML = '';
  const add = (cls, text) => { const s = document.createElement('span'); s.className = 'badge ' + cls; s.textContent = text; badges.appendChild(s); };
  if (d.size) add('size', d.size);
  if (d.specStatus) add('status', d.specStatus);
  if (d.reviewVerdict === 'PASS') add('pass', 'review: PASS');
  if (d.reviewVerdict === 'CHANGES REQUESTED') add('changes', 'changes requested');
  if (d.shipped) add('shipped', 'shipped');
  for (const s of (d.surfaces || [])) add('surface', s);

  document.getElementById('run-fix').classList.toggle('hidden', d.reviewVerdict !== 'CHANGES REQUESTED');

  renderStepper(d);
  renderArtifactTabs(d);
}

function renderStepper(d) {
  const wrap = document.getElementById('stepper');
  wrap.innerHTML = '';
  for (const s of d.stages) {
    const step = document.createElement('div');
    step.className = 'step ' + s.status;

    const top = document.createElement('div');
    top.className = 'step-top';
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = STATUS_ICON[s.status] || '○';
    top.appendChild(ico);
    const label = document.createElement('span');
    label.className = 'step-label';
    label.textContent = s.label;
    top.appendChild(label);
    step.appendChild(top);

    const st = document.createElement('span');
    st.className = 'step-status';
    st.textContent = s.status;
    step.appendChild(st);

    if (s.status === 'pending' || s.status === 'blocked') {
      const btn = document.createElement('button');
      btn.className = 'ghost run-stage';
      btn.textContent = '▶ run';
      btn.onclick = () => runCommand(d.slug, s.skill);
      step.appendChild(btn);
    }
    wrap.appendChild(step);
  }
}

function nextStage(d) {
  return d.stages.find((s) => s.status === 'pending') || d.stages.find((s) => s.status === 'blocked');
}

// ---- artifacts (read-only render) -------------------------------------------

function renderArtifactTabs(d) {
  const tabs = document.getElementById('artifact-tabs');
  tabs.innerHTML = '';
  for (const a of d.artifacts) {
    const t = document.createElement('div');
    t.className = 'artifact-tab' + (state.artifact && state.artifact.path === a.path ? ' active' : '');
    t.textContent = a.label;
    t.title = a.path;
    t.onclick = () => openArtifact(a);
    tabs.appendChild(t);
  }
  if (d.artifacts.length && !state.artifact) {
    openArtifact(d.artifacts[0]);
  } else if (state.artifact) {
    // re-mark active tab
    [...tabs.children].forEach((c) => c.classList.toggle('active', c.title === state.artifact.path));
  } else {
    document.getElementById('artifact-toolbar').classList.add('hidden');
    document.getElementById('artifact-viewer').innerHTML = '';
  }
}

async function openArtifact(a) {
  try {
    const res = await api(`/api/artifact?slug=${encodeURIComponent(state.slug)}&path=${encodeURIComponent(a.path)}`);
    if (!res.ok) throw new Error(res.status);
    const raw = await res.text();
    const mtime = Number(res.headers.get('x-sdd-mtime') || 0);
    state.artifact = { path: a.path, kind: a.kind, label: a.label, raw, mtime };
    renderArtifactTabs(state.detail);
    renderArtifact();
  } catch (e) {
    logLine('error', `could not open ${a.path}: ${e.message}`);
  }
}

function renderArtifact() {
  const a = state.artifact;
  const toolbar = document.getElementById('artifact-toolbar');
  const viewer = document.getElementById('artifact-viewer');
  toolbar.classList.remove('hidden');
  document.getElementById('artifact-path').textContent = a.path;

  viewer.innerHTML = '';
  if (a.kind === 'json') {
    const pre = document.createElement('pre');
    pre.className = 'raw';
    try { pre.textContent = JSON.stringify(JSON.parse(a.raw), null, 2); } catch { pre.textContent = a.raw; }
    viewer.appendChild(pre);
    return;
  }
  if (a.kind === 'text' || a.kind === 'openapi') {
    // openapi renders as plain yaml — no in-browser API console
    const pre = document.createElement('pre');
    pre.className = 'raw';
    pre.textContent = a.raw;
    viewer.appendChild(pre);
    return;
  }
  // markdown
  renderMarkdown(a.raw, viewer);
}

function stripFrontmatter(md) {
  // A leading --- … --- YAML block renders as a setext h2 under marked
  // (text + a line of --- = heading). The frontmatter is already shown as
  // badges, so drop it before rendering.
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return md;
  return md.slice(md.indexOf('\n', end + 1) + 1).replace(/^\s+/, '');
}

function renderMarkdown(md, viewer) {
  const div = document.createElement('div');
  div.className = 'md';
  const body = stripFrontmatter(md);
  try {
    div.innerHTML = window.marked ? window.marked.parse(body, { breaks: false, gfm: true }) : escapeHtml(body);
  } catch {
    div.textContent = body;
  }
  viewer.appendChild(div);
  renderMermaidIn(div);
}

// Mermaid is 3.3 MB — load it only when a rendered artifact actually contains a
// ```mermaid block (same lazy pattern the OpenAPI renderer used to follow).
let mermaidLoading = null;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve();
  if (mermaidLoading) return mermaidLoading;
  mermaidLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/mermaid.min.js';
    s.onload = () => resolve();
    s.onerror = () => { mermaidLoading = null; reject(new Error('failed to load mermaid')); };
    document.head.appendChild(s);
  });
  return mermaidLoading;
}

let mermaidReady = false;
function initMermaid() {
  if (mermaidReady) return;
  window.mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: { fontFamily: 'monospace', background: '#0e160e' },
    securityLevel: 'strict',
  });
  mermaidReady = true;
}

async function renderMermaidIn(root) {
  const blocks = root.querySelectorAll('code.language-mermaid');
  if (blocks.length === 0) return; // markdown-only artifact — never load the lib
  try {
    await loadMermaid();
  } catch (e) {
    logLine('error', e.message);
    return;
  }
  initMermaid();
  let i = 0;
  for (const code of blocks) {
    const src = code.textContent;
    const host = document.createElement('div');
    host.className = 'mermaid';
    const pre = code.closest('pre') || code;
    pre.replaceWith(host);
    try {
      const id = 'mmd-' + Date.now() + '-' + i++;
      const { svg } = await window.mermaid.render(id, src);
      host.innerHTML = svg;
    } catch (e) {
      host.className = 'mermaid-error';
      host.textContent = 'mermaid render error: ' + (e && e.message ? e.message : e);
    }
  }
}

// ---- refresh ---------------------------------------------------------------

async function refresh(slug) {
  await loadFeatures();
  if (state.slug && (!slug || slug === state.slug)) {
    await loadDetail(state.slug);
    // keep the open artifact in sync if Claude rewrote it
    if (state.artifact) {
      const still = state.detail.artifacts.find((x) => x.path === state.artifact.path);
      if (still) await openArtifact(still);
    }
  }
}

// ---- create feature + roadmap ----------------------------------------------

function openModal(title, bodyEl) {
  document.getElementById('modal-title').textContent = title;
  const body = document.getElementById('modal-body');
  body.innerHTML = '';
  body.appendChild(bodyEl);
  document.getElementById('modal').classList.remove('hidden');
}
function closeModal() { document.getElementById('modal').classList.add('hidden'); }

function newFeatureDialog() {
  const wrap = document.createElement('div');
  const hint = document.createElement('div');
  hint.className = 'modal-hint';
  hint.textContent = 'Runs /sdd:specify <slug> in the session (depth from the topbar selector). Slug must be kebab-case.';
  const input = document.createElement('input');
  input.placeholder = 'feature-slug';
  input.autofocus = true;
  const err = document.createElement('div');
  err.className = 'field-err';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.className = 'ghost small';
  cancel.textContent = 'cancel';
  cancel.onclick = closeModal;
  const create = document.createElement('button');
  create.className = 'ghost small';
  create.textContent = 'create';
  const submit = () => {
    const slug = input.value.trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) { err.textContent = 'invalid slug (use a-z, 0-9, hyphen)'; return; }
    closeModal();
    runCommand(slug, 'specify');
    logLine('system', `requested new feature: ${slug}`);
  };
  create.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') closeModal(); };
  actions.append(cancel, create);
  wrap.append(hint, input, err, actions);
  openModal('Create feature', wrap);
  setTimeout(() => input.focus(), 10);
}

async function showRoadmap() {
  try {
    const r = await apiJson('/api/roadmap');
    const wrap = document.createElement('div');
    if (!r.exists) {
      wrap.className = 'modal-hint';
      wrap.textContent = 'No docs/roadmap.md yet.';
    } else {
      const div = document.createElement('div');
      div.className = 'md';
      div.style.maxHeight = '60vh';
      div.style.overflowY = 'auto';
      div.innerHTML = window.marked ? window.marked.parse(r.markdown) : escapeHtml(r.markdown);
      wrap.appendChild(div);
    }
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    // Repo-wide runs: the allowlist wants a slug, so pass the skill name as the
    // hint argument — the roadmap/survey skills tolerate it.
    const runBtn = (label, skill, title) => {
      const b = document.createElement('button');
      b.className = 'ghost small';
      b.textContent = label;
      b.title = title;
      b.onclick = () => { closeModal(); runCommand(skill, skill); };
      return b;
    };
    actions.appendChild(runBtn('↻ run /sdd:roadmap', 'roadmap', 'Regenerate docs/roadmap.md from the features on disk'));
    actions.appendChild(runBtn('run /sdd:survey', 'survey', 'Survey the repo and refresh docs/architecture-map.md'));
    const close = document.createElement('button');
    close.className = 'ghost small';
    close.textContent = 'close';
    close.onclick = closeModal;
    actions.appendChild(close);
    wrap.appendChild(actions);
    openModal('Roadmap', wrap);
  } catch (e) {
    logLine('error', `roadmap: ${e.message}`);
  }
}

// ---- utils -----------------------------------------------------------------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- wire up ---------------------------------------------------------------

function init() {
  document.getElementById('session').textContent = SESSION ? SESSION.slice(0, 8) : '';
  document.getElementById('run-next').onclick = () => {
    const d = state.detail;
    if (!d) return;
    const ns = nextStage(d);
    if (!ns) { logLine('system', 'pipeline complete — nothing pending'); return; }
    runCommand(d.slug, ns.skill);
  };
  document.getElementById('run-fix').onclick = () => {
    if (state.detail) runCommand(state.detail.slug, 'fix');
  };
  document.getElementById('new-feature').onclick = newFeatureDialog;
  document.getElementById('new-feature-2').onclick = newFeatureDialog;
  document.getElementById('roadmap-btn').onclick = showRoadmap;
  document.getElementById('clear-console').onclick = () => { consoleLog().innerHTML = ''; };
  document.getElementById('modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

  if (!TOKEN) {
    setConn(false, 'no token in URL');
    logLine('error', 'No capability token in the URL. Open the link printed by /sdd:start.');
    return;
  }
  setConn(false, 'connecting…');
  loadFeatures();
  connectWs();
}

document.addEventListener('DOMContentLoaded', init);
