// FIRST in Wisconsin engagement map. Plain JavaScript, no build step.
// Geometry comes from data/map.json, numbers and events from data/data.json.
const cfg = window.MAP_CONFIG ?? {};
const PROGRAMS = [
  { id: 'fll', label: 'FLL' },
  { id: 'ftc', label: 'FTC' },
  { id: 'frc', label: 'FRC' },
];
const ROLES = ['Parent or guardian', 'Educator', 'Mentor or volunteer', 'Sponsor or community partner', 'Student'];
const mapEl = document.getElementById('map');
const panel = document.getElementById('panel');
const params = new URLSearchParams(location.search);
const state = { region: null, view: 'overview', prog: 'all', pins: true, sending: false };
let map;
let data;
let turnstileId = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the visitor's time zone
const region = () => map.regions.find((r) => r.id === state.region) ?? null;
const chevron = (d) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="${d}"></path></svg>`;
const BACK = chevron('M10,3l-5,5 5,5');
const FORWARD = chevron('M6,3l5,5 -5,5');

// ---- Numbers ---------------------------------------------------------------
const areaCount = (area, p) => area.counties.reduce((n, c) => n + (data.counties[c]?.[p] ?? 0), 0);
const regionCount = (r, p) => r.areas.reduce((n, a) => n + areaCount(a, p), 0);
const sumIfAll = (values) => (values.length && values.every((v) => Number.isFinite(v)) ? values.reduce((a, b) => a + b, 0) : null);
function goal(scope, p) {
  if (scope === 'state') return data.goals.state?.[p] ?? sumIfAll(map.regions.map((r) => goal(r, p)));
  return data.goals[scope.id]?.[p] ?? sumIfAll(scope.areas.map((a) => data.goals[a.id]?.[p]));
}
const swatch = (r) => (r.areas.length > 1 ? `linear-gradient(90deg, ${r.areas[0].color} 50%, ${r.areas[1].color} 50%)` : r.areas[0].color);

// ---- Dates and events --------------------------------------------------------
const day = (iso) => new Date(`${iso}T12:00:00Z`);
const fmt = (iso, opts) => day(iso).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
function dateRange(e) {
  if (e.start === e.end) return fmt(e.start, { month: 'short', day: 'numeric', year: 'numeric' });
  const sameMonth = e.start.slice(0, 7) === e.end.slice(0, 7);
  return `${fmt(e.start, { month: 'short', day: 'numeric' })}–${fmt(e.end, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}, ${e.end.slice(0, 4)}`;
}
const upcoming = () => data.events.filter((e) => e.end >= today());
const shows = (e) => state.prog === 'all' || state.prog === e.program;

// ---- Map ---------------------------------------------------------------------
function drawMap() {
  const groups = map.regions.map((r) => {
    const areas = r.areas.map((a) => `<g fill="${esc(a.color)}">${a.counties.map((c) => {
      const n = data.counties[c] ?? {};
      return `<path class="county" d="${map.counties[c].d}"><title>${esc(c)} County: ${PROGRAMS.map((p) => `${p.label} ${n[p.id] ?? 0}`).join(', ')}</title></path>`;
    }).join('')}</g>`).join('');
    const labels = r.areas.flatMap((a) => a.counties).map((c) => `<text class="county-label" x="${map.counties[c].x}" y="${map.counties[c].y + 3}">${esc(map.counties[c].label)}</text>`).join('');
    return `<g class="region" data-region="${esc(r.id)}" tabindex="0" role="button" aria-label="${esc(r.name)} region">${areas}${labels}</g>`;
  }).join('');
  mapEl.innerHTML = `<svg viewBox="${map.viewBox.join(' ')}" role="group" aria-label="Map of Wisconsin counties, colored by region">${groups}<path class="mesh" d="${map.mesh}"></path><g class="pins" id="pins"></g></svg>`;
}

const PIN = {
  fll: (x, y) => `<circle class="pin pin-fll" cx="${x - 4}" cy="${y}" r="4"></circle>`,
  ftc: (x, y) => `<path class="pin pin-ftc" d="M${x + 4},${y - 5}l5,5 -5,5 -5,-5z"></path>`,
  frc: (x, y) => `<path class="pin pin-frc" d="M${x},${y - 11}l5,9 -10,0z"></path>`,
  other: (x, y) => `<circle class="pin pin-other" cx="${x}" cy="${y + 6}" r="3.5"></circle>`,
};
function drawPins() {
  const seen = new Set();
  const out = [];
  if (state.pins) {
    for (const e of upcoming()) {
      if (e.x == null || !shows(e)) continue;
      const key = `${e.program}:${Math.round(e.x / 5)}:${Math.round(e.y / 5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push((PIN[e.program] ?? PIN.other)(e.x, e.y));
    }
  }
  document.getElementById('pins').innerHTML = out.join('');
  for (const g of mapEl.querySelectorAll('.region')) g.classList.toggle('dim', Boolean(state.region) && g.dataset.region !== state.region);
}

// ---- Panel pieces --------------------------------------------------------------
function tiles(scope) {
  return `<div class="tiles">${PROGRAMS.map((p) => {
    const count = scope === 'state' ? data.totals[p.id] : regionCount(scope, p.id);
    const g = goal(scope, p.id);
    const pct = g > 0 ? Math.round((count / g) * 100) : null;
    return `<div class="tile ${p.id}">
      <div class="tile-figure">${count}</div>
      <div class="tile-caption">${p.label} teams</div>
      <div class="tile-goal"><span>${g == null ? 'Goal not set' : `Goal ${g}`}</span><span>${pct == null ? '' : `${pct}%`}</span></div>
      <div class="bar" role="img" aria-label="${pct == null ? `No ${p.label} goal set` : `${p.label}: ${pct}% of goal`}"><span style="width:${Math.min(pct ?? 0, 100)}%"></span></div>
    </div>`;
  }).join('')}</div>`;
}
const tableHead = (first) => `<div class="row row-head${first === 'Area' ? ' no-arrow' : ''}"><span>${first}</span>${PROGRAMS.map((p) => `<span class="num ${p.id}">${p.label}</span>`).join('')}${first === 'Area' ? '' : '<span></span>'}</div>`;

function overview() {
  const rows = map.regions.map((r) => `<button type="button" class="row row-item" data-action="open" data-region="${esc(r.id)}">
    <span class="row-name"><span class="swatch" style="background:${swatch(r)}"></span><span>${esc(r.name)}</span></span>
    ${PROGRAMS.map((p) => `<span class="num">${regionCount(r, p.id)}</span>`).join('')}${FORWARD}</button>`).join('');
  return `<div><div class="kicker">${esc(data.season.label)} season</div><h2 tabindex="-1">Statewide</h2></div>
    ${tiles('state')}
    <div class="table">${tableHead('Region')}${rows}</div>
    <p class="note">Team counts come from the <i>FIRST</i> team search for the ${esc(data.season.label)} season. FLL counts Challenge and Explore teams together.</p>`;
}

function regionHead(r) {
  const split = r.areas.length > 1;
  return `<div class="head">
    <button type="button" class="link-btn" data-action="home">${BACK}All regions</button>
    <div class="head-title"><span class="swatch lg" style="background:${swatch(r)}"></span><h2 tabindex="-1">${esc(r.name)}</h2></div>
    ${r.areas.map((a) => `<div class="area-line"><span class="swatch sm" style="background:${esc(a.color)}"></span><span><b>${split ? `${esc(a.name)}:` : 'Counties:'}</b> ${esc(a.counties.join(', '))}</span></div>`).join('')}
    <div class="tabs" role="tablist">
      <button type="button" class="tab" role="tab" aria-selected="${state.view === 'teams'}" data-action="view" data-view="teams">Teams and goals</button>
      <button type="button" class="tab" role="tab" aria-selected="${state.view === 'events'}" data-action="view" data-view="events">Events</button>
    </div>
  </div>`;
}

function teams(r) {
  const champion = data.champions[r.id]?.name;
  const areaTable = r.areas.length > 1
    ? `<div class="table">${tableHead('Area')}${r.areas.map((a) => `<div class="row row-item no-arrow"><span class="row-name"><span class="swatch" style="background:${esc(a.color)}"></span><span>${esc(a.name)}</span></span>${PROGRAMS.map((p) => `<span class="num">${areaCount(a, p.id)}</span>`).join('')}</div>`).join('')}</div>`
    : '';
  return `${regionHead(r)}${tiles(r)}${areaTable}
    <div class="card">
      <div class="kicker">Region champion</div>
      <div class="card-name">${champion ? esc(champion) : 'To be announced'}</div>
      <p>Ask about starting a team, volunteering or sponsoring. Your message is forwarded by email, and the champion's address stays private.</p>
      <button type="button" class="btn link" data-action="view" data-view="contact">${champion ? 'Contact the champion' : 'Contact FIRST Wisconsin'}</button>
    </div>`;
}

function events(r) {
  const list = upcoming().filter((e) => e.region === r.id);
  const chips = [{ id: 'all', label: 'All' }, ...PROGRAMS, { id: 'other', label: 'Other' }]
    .map((c) => `<button type="button" class="chip" aria-pressed="${state.prog === c.id}" data-action="prog" data-prog="${c.id}">${c.label}</button>`).join('');
  const groups = [...PROGRAMS.map((p) => ({ id: p.id, title: `${p.label} events` })), { id: 'other', title: 'Other events' }]
    .filter((g) => state.prog === 'all' || state.prog === g.id)
    .map((g) => ({ ...g, items: list.filter((e) => e.program === g.id) }))
    .filter((g) => g.items.length)
    .map((g) => `<div class="group-head ${g.id}">${g.title}</div>${g.items.map((e) => {
      const name = e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>` : esc(e.name);
      return `<div class="event"><div class="event-date">${esc(dateRange(e))}</div><div><div>${name}</div><div class="event-where">${esc([e.city, e.type].filter(Boolean).join(' · '))}</div></div></div>`;
    }).join('')}`).join('');
  return `${regionHead(r)}<div class="chips">${chips}</div>
    <div class="events">${groups || '<p class="empty">No upcoming events are listed here for this region yet.</p>'}</div>`;
}

function contact(r) {
  const champion = data.champions[r.id]?.name;
  return `<form class="form" id="contact-form" novalidate>
    <button type="button" class="link-btn" data-action="view" data-view="teams">${BACK}Back to ${esc(r.name)}</button>
    <div><h2 tabindex="-1">${champion ? 'Contact the champion' : 'Contact FIRST Wisconsin'}</h2><div class="area-line">${esc(r.name)}${champion ? ` · ${esc(champion)}` : ''}</div></div>
    <label class="field">Your name<input name="name" type="text" autocomplete="name" maxlength="120" required><span class="field-error" data-error="name"></span></label>
    <label class="field">Email<input name="email" type="email" autocomplete="email" maxlength="254" required><span class="field-error" data-error="email"></span></label>
    <label class="field">Your role<select name="role">${ROLES.map((x) => `<option>${x}</option>`).join('')}</select></label>
    <fieldset><legend>Programs you are interested in</legend><div class="checks">
      ${[...PROGRAMS, { id: 'unsure', label: 'Not sure yet' }].map((p) => `<label class="check"><input type="checkbox" name="programs" value="${p.id}">${p.label}</label>`).join('')}
    </div></fieldset>
    <label class="field">Message<textarea name="message" rows="4" maxlength="4000" required></textarea><span class="field-error" data-error="message"></span></label>
    <label class="hp" aria-hidden="true">Website<input name="website" type="text" tabindex="-1" autocomplete="off"></label>
    <div id="turnstile"></div>
    <p class="note">Your message is emailed to the region champion, and <i>FIRST</i> Wisconsin keeps your contact details so it can follow up. The champion's address is never shown on this page.</p>
    <div class="form-error" id="form-error" role="alert" hidden></div>
    <button type="submit" class="btn">Send message</button>
  </form>`;
}

function sent(r) {
  const champion = data.champions[r.id]?.name;
  return `<div class="card"><h2 tabindex="-1">Message sent</h2>
    <p>${champion ? esc(champion) : 'Someone from <i>FIRST</i> Wisconsin'} will reply to the email address you gave. Thank you for your interest in <i>FIRST</i> in Wisconsin.</p>
    <button type="button" class="link-btn" data-action="view" data-view="teams">${BACK}Back to ${esc(r.name)}</button></div>`;
}

function render(focus = false) {
  const r = region();
  if (!r) state.view = 'overview';
  panel.innerHTML = { overview: () => overview(), teams: () => teams(r), events: () => events(r), contact: () => contact(r), sent: () => sent(r) }[state.view]();
  drawPins();
  if (state.view === 'contact') mountTurnstile();
  if (focus) {
    panel.scrollTop = 0;
    panel.querySelector('h2')?.focus({ preventScroll: true });
  }
}

// ---- Contact form ---------------------------------------------------------------
function mountTurnstile() {
  turnstileId = null;
  if (!cfg.turnstileSiteKey) return;
  const mount = () => {
    const el = document.getElementById('turnstile');
    if (el && window.turnstile) turnstileId = window.turnstile.render(el, { sitekey: cfg.turnstileSiteKey });
  };
  if (window.turnstile) return mount();
  if (!document.getElementById('turnstile-script')) {
    const s = document.createElement('script');
    s.id = 'turnstile-script';
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = mount;
    document.head.append(s);
  }
}

function showErrors(form, fields, message) {
  for (const el of form.querySelectorAll('[data-error]')) {
    const text = fields[el.dataset.error] ?? '';
    el.textContent = text;
    form.elements[el.dataset.error].setAttribute('aria-invalid', text ? 'true' : 'false');
  }
  const box = form.querySelector('#form-error');
  box.textContent = message ?? '';
  box.hidden = !message;
  const first = Object.keys(fields)[0];
  if (first) form.elements[first]?.focus();
}

async function submit(form) {
  if (state.sending) return;
  const f = new FormData(form);
  const body = {
    region: state.region,
    name: f.get('name').trim(),
    email: f.get('email').trim(),
    role: f.get('role'),
    programs: f.getAll('programs'),
    message: f.get('message').trim(),
    website: f.get('website'),
    turnstileToken: turnstileId != null ? window.turnstile.getResponse(turnstileId) : '',
  };
  const fields = {};
  if (!body.name) fields.name = 'Enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) fields.email = 'Enter a valid email address.';
  if (!body.message) fields.message = 'Enter a message.';
  if (Object.keys(fields).length) return showErrors(form, fields);
  if (!cfg.contactEndpoint) return showErrors(form, {}, 'The contact form is not connected yet. Please try again later.');
  if (cfg.turnstileSiteKey && !body.turnstileToken) return showErrors(form, {}, 'Please complete the check above the Send button.');

  const button = form.querySelector('[type="submit"]');
  state.sending = true;
  button.disabled = true;
  button.textContent = 'Sending';
  showErrors(form, {});
  try {
    const res = await fetch(cfg.contactEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      state.view = 'sent';
      return render(true);
    }
    if (json.error === 'validation') showErrors(form, json.fields ?? {}, 'Please check the highlighted fields.');
    else if (json.error === 'bot_check') showErrors(form, {}, 'The spam check did not pass. Please reload the page and try again.');
    else showErrors(form, {}, 'Your message could not be sent. Please try again in a few minutes.');
    if (turnstileId != null) window.turnstile.reset(turnstileId);
  } catch {
    showErrors(form, {}, 'Your message could not be sent. Check your connection and try again.');
  } finally {
    state.sending = false;
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = 'Send message';
    }
  }
}

// ---- Events ------------------------------------------------------------------------
function openRegion(id) {
  state.region = id;
  state.view = 'teams';
  state.prog = 'all';
  render(true);
}
panel.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'open') return openRegion(el.dataset.region);
  if (a === 'home') Object.assign(state, { region: null, view: 'overview', prog: 'all' });
  if (a === 'view') {
    state.view = el.dataset.view;
    if (state.view !== 'events') state.prog = 'all'; // the program filter only applies on the Events tab
  }
  if (a === 'prog') state.prog = el.dataset.prog;
  render(a !== 'prog');
  if (a === 'prog') panel.querySelector(`[data-prog="${state.prog}"]`)?.focus();
});
panel.addEventListener('submit', (ev) => {
  ev.preventDefault();
  submit(ev.target);
});
mapEl.addEventListener('click', (ev) => {
  const g = ev.target.closest('.region');
  if (g) openRegion(g.dataset.region);
});
mapEl.addEventListener('keydown', (ev) => {
  const g = ev.target.closest('.region');
  if (g && (ev.key === 'Enter' || ev.key === ' ')) {
    ev.preventDefault();
    openRegion(g.dataset.region);
  }
});
document.getElementById('pins-toggle').addEventListener('change', (ev) => {
  state.pins = ev.target.checked;
  drawPins();
});

// ---- Start --------------------------------------------------------------------------
async function load(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}
try {
  if (params.get('header') === '0') document.body.classList.add('no-header');
  [map, data] = await Promise.all([load('data/map.json'), load('data/data.json')]);
  const start = params.get('region');
  if (map.regions.some((r) => r.id === start)) Object.assign(state, { region: start, view: 'teams' });
  drawMap();
  render();
} catch (err) {
  console.error(err);
  panel.innerHTML = '<p class="form-error">The map data could not be loaded. Please reload the page.</p>';
}
