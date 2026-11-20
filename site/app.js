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
const crumbs = document.getElementById('crumbs');
const panel = document.getElementById('panel');
const params = new URLSearchParams(location.search);
const state = { region: null, county: null, view: 'overview', prog: 'all', pins: true, sending: false };
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
      return `<path class="county" data-county="${esc(c)}" d="${map.counties[c].d}"><title>${esc(c)} County: ${PROGRAMS.map((p) => `${p.label} ${n[p.id] ?? 0}`).join(', ')}</title></path>`;
    }).join('')}</g>`).join('');
    const labels = r.areas.flatMap((a) => a.counties).map((c) => `<text class="county-label" data-short="${esc(map.counties[c].label)}" data-full="${esc(c)}" x="${map.counties[c].x}" y="${map.counties[c].y}">${esc(map.counties[c].label)}</text>`).join('');
    return `<g class="region" data-region="${esc(r.id)}" tabindex="0" role="button" aria-label="${esc(r.name)} region">${areas}${labels}</g>`;
  }).join('');
  mapEl.innerHTML = `<svg viewBox="${map.viewBox.join(' ')}" role="group" aria-label="Map of Wisconsin counties, colored by region">${groups}<path class="mesh" d="${map.mesh}"></path><path class="county-outline" id="county-outline" fill="none" d=""></path><g class="pins" id="pins"></g></svg>`;
  svg = mapEl.querySelector('svg');
  const [x, y, w, h] = map.viewBox;
  base = { x, y, w, h };
  view = { ...base };
  applyView();
}

// Marker shapes are drawn around 0,0 and offset from each other so programs at one venue do not hide each other.
const PIN = {
  fll: '<circle class="pin pin-fll" cx="-4" cy="0" r="4"></circle>',
  ftc: '<path class="pin pin-ftc" d="M4,-5l5,5 -5,5 -5,-5z"></path>',
  frc: '<path class="pin pin-frc" d="M0,-11l5,9 -10,0z"></path>',
  other: '<circle class="pin pin-other" cx="0" cy="6" r="3.5"></circle>',
};
function drawPins() {
  const seen = new Set();
  const out = [];
  const s = zoomLevel() ** -0.6; // markers grow a little when zoomed in, not in step with the map
  const cell = 5 * s;
  if (state.pins) {
    for (const e of upcoming()) {
      if (e.x == null || !shows(e)) continue;
      const key = `${e.program}:${Math.round(e.x / cell)}:${Math.round(e.y / cell)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`<g transform="translate(${e.x},${e.y}) scale(${s.toFixed(3)})">${PIN[e.program] ?? PIN.other}</g>`);
    }
  }
  document.getElementById('pins').innerHTML = out.join('');
}

function drawSelection() {
  for (const g of mapEl.querySelectorAll('.region')) {
    g.classList.toggle('dim', Boolean(state.region) && g.dataset.region !== state.region);
    g.classList.toggle('active', g.dataset.region === state.region);
  }
  document.getElementById('county-outline').setAttribute('d', state.county ? map.counties[state.county].d : '');
  drawCrumbs();
  const sel = state.county ?? state.region ?? '';
  if (sel === lastSelection) return;
  lastSelection = sel;
  if (state.county) fitBox(mapEl.querySelector(`[data-county="${CSS.escape(state.county)}"]`).getBBox(), 2.6);
  else if (state.region) fitBox(mapEl.querySelector(`[data-region="${CSS.escape(state.region)}"]`).getBBox(), 1.15);
  else flyTo(base);
}

// The trail on the map itself, so there is always a way back next to where you clicked.
function drawCrumbs() {
  const r = region();
  const sep = '<span aria-hidden="true">›</span>';
  crumbs.hidden = !r;
  crumbs.innerHTML = !r ? '' : `<button type="button" data-up="home">Wisconsin</button>${sep}${state.county
    ? `<button type="button" data-up="region">${esc(r.name)}</button>${sep}<span aria-current="location">${esc(state.county)} County</span>`
    : `<span aria-current="location">${esc(r.name)}</span>`}`;
}
// One level up: county to region, region to the whole state.
function goUp(to = state.county ? 'region' : 'home') {
  if (!state.region) return;
  if (to === 'region') Object.assign(state, { county: null, view: 'teams', prog: 'all' });
  else Object.assign(state, { region: null, county: null, view: 'overview', prog: 'all' });
  render(true);
}

// ---- Zoom and pan (the SVG viewBox is the camera) ----------------------------------
const MAX_ZOOM = 8;
let svg;
let base;
let view;
let lastSelection = '';
let flight = 0;
let suppressClickUntil = 0;
const zoomLevel = () => (base ? base.w / view.w : 1);

function applyView() {
  view.w = Math.min(base.w, Math.max(base.w / MAX_ZOOM, view.w));
  view.h = (view.w * base.h) / base.w;
  view.x = Math.min(base.x + base.w - view.w, Math.max(base.x, view.x));
  view.y = Math.min(base.y + base.h - view.h, Math.max(base.y, view.y));
  const k = zoomLevel();
  svg.setAttribute('viewBox', [view.x, view.y, view.w, view.h].map((n) => n.toFixed(2)).join(' '));
  svg.style.setProperty('--inv', (1 / k).toFixed(4)); // keeps line widths steady on screen
  svg.style.setProperty('--lab', (k ** -0.6).toFixed(4)); // labels grow, but slower than the map
  svg.classList.toggle('zoomed', k > 1.01);
  const far = k >= 1.8;
  if (far !== svg.classList.contains('zoomed-far')) {
    svg.classList.toggle('zoomed-far', far);
    for (const t of svg.querySelectorAll('.county-label')) t.textContent = far ? t.dataset.full : t.dataset.short; // room for full names when zoomed in
  }
  document.getElementById('zoom-in').disabled = k >= MAX_ZOOM - 0.01;
  document.getElementById('zoom-out').disabled = k <= 1.01;
  document.getElementById('zoom-reset').disabled = k <= 1.01;
  drawPins();
}
function flyTo(target) {
  cancelAnimationFrame(flight);
  const from = { ...view };
  const to = { x: target.x, y: target.y, w: target.w };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    Object.assign(view, to);
    return applyView();
  }
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / 350);
    const e = 1 - (1 - t) ** 3;
    view.w = from.w + (to.w - from.w) * e;
    view.x = from.x + (to.x - from.x) * e;
    view.y = from.y + (to.y - from.y) * e;
    applyView();
    if (t < 1) flight = requestAnimationFrame(step);
  };
  flight = requestAnimationFrame(step);
}
function fitBox(b, pad) {
  const w = Math.min(base.w, Math.max(b.width * pad, (b.height * pad * base.w) / base.h, base.w / MAX_ZOOM));
  const h = (w * base.h) / base.w;
  flyTo({ x: b.x + b.width / 2 - w / 2, y: b.y + b.height / 2 - h / 2, w });
}
// Zoom by a factor while the map point (cx, cy) stays where it is on screen.
function zoomAt(factor, cx = view.x + view.w / 2, cy = view.y + view.h / 2, animate = true) {
  const w = Math.min(base.w, Math.max(base.w / MAX_ZOOM, view.w / factor));
  const r = w / view.w;
  const target = { x: cx - (cx - view.x) * r, y: cy - (cy - view.y) * r, w };
  if (animate) return flyTo(target);
  cancelAnimationFrame(flight);
  Object.assign(view, target);
  applyView();
}
function toMap(clientX, clientY) {
  const m = svg.getScreenCTM();
  return { x: (clientX - m.e) / m.a, y: (clientY - m.f) / m.d, scale: m.a };
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

function championCard(r) {
  const champion = data.champions[r.id]?.name;
  return `<div class="card">
      <div class="kicker">Region champion</div>
      <div class="card-name">${champion ? esc(champion) : 'To be announced'}</div>
      <p>Ask about starting a team, volunteering or sponsoring. Your message is forwarded by email, and the champion's address stays private.</p>
      <button type="button" class="btn link" data-action="view" data-view="contact">${champion ? 'Contact the champion' : 'Contact FIRST Wisconsin'}</button>
    </div>`;
}
function eventGroups(list) {
  return [...PROGRAMS.map((p) => ({ id: p.id, title: `${p.label} events` })), { id: 'other', title: 'Other events' }]
    .filter((g) => state.prog === 'all' || state.prog === g.id)
    .map((g) => ({ ...g, items: list.filter((e) => e.program === g.id) }))
    .filter((g) => g.items.length)
    .map((g) => `<div class="group-head ${g.id}">${g.title}</div>${g.items.map((e) => {
      const name = e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>` : esc(e.name);
      return `<div class="event"><div class="event-date">${esc(dateRange(e))}</div><div><div>${name}</div><div class="event-where">${esc([e.city, e.type].filter(Boolean).join(' · '))}</div></div></div>`;
    }).join('')}`).join('');
}

function overview() {
  const rows = map.regions.map((r) => `<button type="button" class="row row-item" data-action="open" data-region="${esc(r.id)}">
    <span class="row-name"><span class="swatch" style="background:${swatch(r)}"></span><span>${esc(r.name)}</span></span>
    ${PROGRAMS.map((p) => `<span class="num">${regionCount(r, p.id)}</span>`).join('')}${FORWARD}</button>`).join('');
  return `<div><div class="kicker">${esc(data.season.label)} season</div><h2 tabindex="-1">Statewide</h2></div>
    ${tiles('state')}
    <div class="table">${tableHead('Region')}${rows}</div>
    <p class="note">${data.teams?.source === 'report'
      ? `Team counts are teams registered for the ${esc(data.season.label)} season${data.teams.asOf ? `, as of ${fmt(data.teams.asOf, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}.`
      : `Team counts come from the <i>FIRST</i> team search for the ${esc(data.season.label)} season.`} FLL counts all <i>FIRST</i> LEGO League divisions together.</p>`;
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
  const split = r.areas.length > 1;
  const areaTable = split
    ? `<div class="table">${tableHead('Area')}${r.areas.map((a) => `<div class="row row-item no-arrow"><span class="row-name"><span class="swatch" style="background:${esc(a.color)}"></span><span>${esc(a.name)}</span></span>${PROGRAMS.map((p) => `<span class="num">${areaCount(a, p.id)}</span>`).join('')}</div>`).join('')}</div>`
    : '';
  const countyRows = r.areas.flatMap((a) => a.counties.map((c) => `<button type="button" class="row row-item" data-action="county" data-county="${esc(c)}">
    <span class="row-name"><span class="swatch" style="background:${esc(a.color)}"></span><span>${esc(c)}</span></span>
    ${PROGRAMS.map((p) => `<span class="num">${data.counties[c]?.[p.id] ?? 0}</span>`).join('')}${FORWARD}</button>`)).join('');
  return `${regionHead(r)}${tiles(r)}${areaTable}
    <div class="table">${tableHead('County')}${countyRows}</div>
    ${championCard(r)}`;
}

function events(r) {
  const chips = [{ id: 'all', label: 'All' }, ...PROGRAMS, { id: 'other', label: 'Other' }]
    .map((c) => `<button type="button" class="chip" aria-pressed="${state.prog === c.id}" data-action="prog" data-prog="${c.id}">${c.label}</button>`).join('');
  return `${regionHead(r)}<div class="chips">${chips}</div>
    <div class="events">${eventGroups(upcoming().filter((e) => e.region === r.id)) || '<p class="empty">No upcoming events are listed here for this region yet.</p>'}</div>`;
}

function county(r) {
  const c = state.county;
  const n = data.counties[c] ?? {};
  const area = r.areas.find((a) => a.counties.includes(c));
  const where = r.areas.length > 1 ? `${esc(area.name)}, ${esc(r.name)}` : esc(r.name);
  return `<div class="head">
      <button type="button" class="link-btn" data-action="view" data-view="teams">${BACK}Back to ${esc(r.name)}</button>
      <div class="head-title"><span class="swatch lg" style="background:${esc(area.color)}"></span><h2 tabindex="-1">${esc(c)} County</h2></div>
      <div class="area-line">${where}</div>
    </div>
    <div class="tiles">${PROGRAMS.map((p) => `<div class="tile ${p.id}"><div class="tile-figure">${n[p.id] ?? 0}</div><div class="tile-caption">${p.label} teams</div></div>`).join('')}</div>
    <p class="note">Goals are set for the whole region, not for single counties.</p>
    <div class="events"><div class="kicker">Upcoming events in ${esc(c)} County</div>${eventGroups(upcoming().filter((e) => e.county === c)) || '<p class="empty">No upcoming events are listed in this county yet.</p>'}</div>
    ${championCard(r)}`;
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
  if (state.view !== 'county') state.county = null;
  panel.innerHTML = { overview: () => overview(), teams: () => teams(r), county: () => county(r), events: () => events(r), contact: () => contact(r), sent: () => sent(r) }[state.view]();
  drawSelection();
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
  Object.assign(state, { region: id, county: null, view: 'teams', prog: 'all' });
  render(true);
}
function openCounty(name) {
  Object.assign(state, { region: map.counties[name].region, county: name, view: 'county', prog: 'all' });
  render(true);
}
panel.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'open') return openRegion(el.dataset.region);
  if (a === 'county') return openCounty(el.dataset.county);
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
// First click opens the region; a click on a county inside the open region opens that county.
mapEl.addEventListener('click', (ev) => {
  if (performance.now() < suppressClickUntil) return;
  const g = ev.target.closest('.region');
  if (!g) return goUp(); // empty space around the state
  const c = ev.target.closest('.county');
  if (c && g.dataset.region === state.region) openCounty(c.dataset.county);
  else openRegion(g.dataset.region);
});

// Mouse: drag to move when zoomed in. Ctrl + wheel (or a trackpad pinch) zooms; a plain wheel still scrolls the page.
let drag = null;
mapEl.addEventListener('pointerdown', (ev) => {
  if (ev.pointerType !== 'mouse' || ev.button !== 0 || zoomLevel() <= 1.01) return;
  drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, scale: svg.getScreenCTM().a, moved: false };
});
mapEl.addEventListener('pointermove', (ev) => {
  if (!drag || ev.pointerId !== drag.id) return;
  const dx = ev.clientX - drag.x;
  const dy = ev.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  if (!drag.moved) {
    drag.moved = true;
    cancelAnimationFrame(flight);
    svg.setPointerCapture(ev.pointerId);
    svg.classList.add('dragging');
  }
  view.x = drag.vx - dx / drag.scale;
  view.y = drag.vy - dy / drag.scale;
  applyView();
});
const endDrag = (ev) => {
  if (!drag || ev.pointerId !== drag.id) return;
  if (drag.moved) {
    suppressClickUntil = performance.now() + 250;
    svg.classList.remove('dragging');
  }
  drag = null;
};
mapEl.addEventListener('pointerup', endDrag);
mapEl.addEventListener('pointercancel', endDrag);
mapEl.addEventListener('wheel', (ev) => {
  if (!ev.ctrlKey && !ev.metaKey) return;
  ev.preventDefault();
  const p = toMap(ev.clientX, ev.clientY);
  zoomAt(Math.exp(-ev.deltaY * 0.01), p.x, p.y, false);
}, { passive: false });

// Touch: one finger scrolls the page as usual, two fingers move and zoom the map.
let pinch = null;
const touchInfo = (ts) => ({ x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2, dist: Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY) });
mapEl.addEventListener('touchstart', (ev) => {
  if (ev.touches.length !== 2) return;
  ev.preventDefault();
  cancelAnimationFrame(flight);
  const t = touchInfo(ev.touches);
  const p = toMap(t.x, t.y);
  // ox, oy: where map point 0,0 sits on screen at zoom 1 spacing; it does not move while the view changes.
  pinch = { dist: t.dist, w: view.w, scale: p.scale, px: p.x, py: p.y, ox: t.x - (p.x - view.x) * p.scale, oy: t.y - (p.y - view.y) * p.scale };
}, { passive: false });
mapEl.addEventListener('touchmove', (ev) => {
  if (!pinch || ev.touches.length !== 2) return;
  ev.preventDefault();
  const t = touchInfo(ev.touches);
  const w = Math.min(base.w, Math.max(base.w / MAX_ZOOM, (pinch.w * pinch.dist) / Math.max(t.dist, 1)));
  const scale = (pinch.scale * pinch.w) / w;
  view.w = w;
  view.x = pinch.px - (t.x - pinch.ox) / scale;
  view.y = pinch.py - (t.y - pinch.oy) / scale;
  applyView();
}, { passive: false });
const endPinch = () => {
  if (!pinch) return;
  pinch = null;
  suppressClickUntil = performance.now() + 400;
};
mapEl.addEventListener('touchend', endPinch);
mapEl.addEventListener('touchcancel', endPinch);

crumbs.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-up]');
  if (b) goUp(b.dataset.up);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || !state.region || ev.target.closest?.('input, textarea, select')) return;
  goUp();
});
document.getElementById('zoom-in').addEventListener('click', () => zoomAt(1.6));
document.getElementById('zoom-out').addEventListener('click', () => zoomAt(1 / 1.6));
document.getElementById('zoom-reset').addEventListener('click', () => flyTo(base));
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
