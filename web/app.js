'use strict';

/*
 * Management UI for the aptly-backed APT repository.
 * Talks to the aptly REST API through nginx at ../api/, which requires the admin
 * login. The page asks for it with its own form and sends it as a basic-auth
 * header, so it never depends on the browser's login dialog.
 */

const API_BASE = new URL('../api/', location.href);
const REPO_BASE = new URL('../', location.href);
const app = document.getElementById('app');
const enc = encodeURIComponent;

// Written by the container entrypoint; defaults keep the UI usable without it.
let info = { fingerprint: '', origin: '', label: 'apt-repo', architectures: ['amd64'], private: false, readUser: '' };

// ------------------------------------------------------------------ helpers

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const props = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value' || k === 'checked') props[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  // Applied last so a <select> already has its options.
  Object.assign(el, props);
  return el;
}

function parseJSON(text) {
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

function errorMessage(data, fallback) {
  if (data && typeof data === 'object') {
    if (data.error) return data.error;
    if (Array.isArray(data) && data[0] && data[0].error) return data[0].error;
  }
  if (typeof data === 'string' && data.trim() && !data.trim().startsWith('<')) return data.trim().slice(0, 300);
  return fallback;
}

// "Basic …" header for the admin login, kept for this tab only.
let authHeader = '';
try { authHeader = sessionStorage.getItem('auth') || ''; } catch { /* storage unavailable */ }

function setAuth(value) {
  authHeader = value;
  try {
    if (value) sessionStorage.setItem('auth', value);
    else sessionStorage.removeItem('auth');
  } catch { /* storage unavailable */ }
}

function basicAuth(user, password) {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

// Same-origin fetch with our own Authorization header. credentials: 'omit' keeps the
// browser from adding a login it cached and from popping up its own dialog on a 401.
function authFetch(url, init = {}, auth = authHeader) {
  const headers = { ...init.headers };
  if (auth) headers.Authorization = auth;
  return fetch(url, { ...init, headers, credentials: 'omit' });
}

function sessionExpired() {
  showLogin('Your login is no longer valid. Please sign in again.');
  return new Error('Not signed in');
}

async function api(method, path, body) {
  const init = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await authFetch(new URL(path, API_BASE), init);
  if (res.status === 401) throw sessionExpired();
  const data = parseJSON(await res.text());
  if (!res.ok) throw new Error(errorMessage(data, `${res.status} ${res.statusText}`));
  return data;
}

// XHR instead of fetch so we can show upload progress.
function uploadFiles(dir, files, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append('file', f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', new URL(`files/${enc(dir)}`, API_BASE));
    xhr.setRequestHeader('Authorization', authHeader);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status === 401) return reject(sessionExpired());
      const data = parseJSON(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(errorMessage(data, `Upload failed (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(form);
  });
}

function toast(message, kind = 'info') {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  el.addEventListener('click', () => el.remove());
  const stack = document.getElementById('toasts');
  stack.append(el);
  while (stack.children.length > 4) stack.firstChild.remove();
  setTimeout(() => el.remove(), kind === 'error' ? 10000 : 5000);
}

// Disables the button while fn runs and reports failures as a toast.
async function busy(button, fn) {
  button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : n} ${units[i]}`;
}

function fmtDate(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s || '' : d.toLocaleString();
}

function escapeRegex(s) {
  return s.replace(/[\^$\\.*+?()[\]{}|/]/g, '\\$&');
}

const settings = {
  get autoPublish() {
    try { return localStorage.getItem('autoPublish') !== '0'; } catch { return true; }
  },
  set autoPublish(v) {
    try { localStorage.setItem('autoPublish', v ? '1' : '0'); } catch { /* storage unavailable */ }
  },
};

// Debian version ordering (port of dpkg's verrevcmp).
function cmpVersion(a, b) {
  const split = v => {
    let epoch = 0;
    let rest = v;
    const colon = rest.indexOf(':');
    if (colon > -1) { epoch = parseInt(rest.slice(0, colon), 10) || 0; rest = rest.slice(colon + 1); }
    const dash = rest.lastIndexOf('-');
    return dash > -1 ? [epoch, rest.slice(0, dash), rest.slice(dash + 1)] : [epoch, rest, ''];
  };
  const [ea, ua, ra] = split(a);
  const [eb, ub, rb] = split(b);
  return (ea - eb) || verrevcmp(ua, ub) || verrevcmp(ra, rb);
}

function isDigit(ch) { return ch !== undefined && ch >= '0' && ch <= '9'; }

function charOrder(ch) {
  if (ch === undefined || isDigit(ch)) return 0;
  if (/[A-Za-z]/.test(ch)) return ch.charCodeAt(0);
  if (ch === '~') return -1;
  return ch.charCodeAt(0) + 256;
}

function verrevcmp(a, b) {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    let firstDiff = 0;
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const diff = charOrder(a[i]) - charOrder(b[j]);
      if (diff) return diff;
      i++; j++;
    }
    while (a[i] === '0') i++;
    while (b[j] === '0') j++;
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (!firstDiff) firstDiff = a.charCodeAt(i) - b.charCodeAt(j);
      i++; j++;
    }
    if (isDigit(a[i])) return 1;
    if (isDigit(b[j])) return -1;
    if (firstDiff) return firstDiff;
  }
  return 0;
}

// ------------------------------------------------------------------ dialogs

// Resolves to an object of field values, or null when cancelled.
function openDialog({ title, text, content, fields = [], submit = 'OK', cancel = 'Cancel', danger = false, wide = false }) {
  return new Promise(resolve => {
    const dlg = document.getElementById('dialog');
    const inputs = {};
    const fieldEls = fields.map(f => {
      let input;
      if (f.type === 'select') {
        input = h('select', { name: f.name, value: f.value }, f.options.map(o => h('option', { value: o }, o)));
      } else if (f.type === 'checkbox') {
        input = h('input', { type: 'checkbox', name: f.name, checked: !!f.value });
      } else {
        input = h('input', {
          type: f.type || 'text', name: f.name, value: f.value ?? '', placeholder: f.placeholder ?? ' ',
          required: f.required, pattern: f.pattern, min: f.min, autocomplete: 'off', spellcheck: 'false',
        });
      }
      inputs[f.name] = input;
      return f.type === 'checkbox'
        ? h('label', { class: 'check field' }, input, f.label)
        : h('label', { class: 'field' }, h('span', {}, f.label), input, f.hint ? h('small', {}, f.hint) : null);
    });
    const form = h('form', { method: 'dialog' },
      h('h2', {}, title),
      text ? h('p', { class: 'dialog-text' }, text) : null,
      content ? h('div', { class: 'dialog-body' }, content) : null,
      fieldEls,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', onclick: () => dlg.close('cancel') }, cancel),
        submit ? h('button', { type: 'submit', value: 'ok', class: danger ? 'danger' : 'primary' }, submit) : null));
    dlg.className = wide ? 'wide' : '';
    dlg.replaceChildren(form);
    dlg.returnValue = '';
    dlg.onclose = () => {
      const values = {};
      for (const [k, el] of Object.entries(inputs)) values[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
      dlg.replaceChildren();
      resolve(dlg.returnValue === 'ok' ? values : null);
    };
    dlg.showModal();
    const first = form.querySelector('input:not([type=checkbox]), select');
    if (first) first.focus();
  });
}

function showPackage(p) {
  const hidden = new Set(['Key', 'ShortKey', 'FilesHash']);
  const rows = Object.entries(p).filter(([k]) => !hidden.has(k));
  rows.push(['Key', p.Key]);
  openDialog({
    title: `${p.Package} ${p.Version}`,
    content: h('dl', { class: 'details' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])),
    submit: null,
    cancel: 'Close',
    wide: true,
  });
}

// ------------------------------------------------------------------ publishing

// aptly's URL encoding for publish prefixes: "." -> ":.", "_" -> "__", "/" -> "_".
function prefixParam(p) {
  const prefix = p.Prefix === '.' ? '.' : p.Prefix.replace(/_/g, '__').replace(/\//g, '_');
  if (p.Storage) return `${p.Storage}:${prefix}`;
  return prefix === '.' ? ':.' : prefix;
}

function pubName(p) {
  return (p.Prefix && p.Prefix !== '.' ? `${p.Prefix}/` : '') + p.Distribution;
}

function pubsForRepo(pubs, name) {
  return pubs.filter(p => p.SourceKind === 'local' && (p.Sources || []).some(s => s.Name === name));
}

async function republish(name) {
  const targets = pubsForRepo(await api('GET', 'publish') || [], name);
  for (const p of targets) {
    await api('PUT', `publish/${prefixParam(p)}/${enc(p.Distribution)}`, { Signing: { Batch: true }, ForceOverwrite: false });
  }
  return targets.map(pubName);
}

// Call after any change to a repo's contents.
async function afterChange(name) {
  if (!settings.autoPublish) {
    toast(`Saved. ${name} has unpublished changes — use Republish when ready.`, 'warn');
    return;
  }
  const done = await republish(name);
  if (done.length) toast(`Published ${done.join(', ')}`, 'ok');
  else toast(`${name} is not published, so clients won't see the change`, 'warn');
}

// ------------------------------------------------------------------ views: repositories

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'value' }, value), h('div', { class: 'label' }, label));
}

async function viewRepos() {
  const [repos, pubs, snaps] = await Promise.all([api('GET', 'repos'), api('GET', 'publish'), api('GET', 'snapshots')]);
  repos.sort((a, b) => a.Name.localeCompare(b.Name));
  const counts = await Promise.all(repos.map(r =>
    api('GET', `repos/${enc(r.Name)}/packages`).then(list => (list || []).length, () => null)));
  const total = counts.reduce((sum, n) => sum + (n || 0), 0);

  const cleanup = h('button', {
    title: 'Delete pool files no longer referenced by any repository or snapshot',
    onclick: e => busy(e.currentTarget, async () => {
      await api('POST', 'db/cleanup');
      toast('Storage cleanup finished', 'ok');
    }),
  }, 'Clean up storage');

  return h('div', {},
    h('div', { class: 'page-head' },
      h('h1', {}, 'Repositories'),
      h('div', { class: 'actions' },
        cleanup,
        h('button', { class: 'primary', onclick: () => createRepoDialog(pubs) }, 'New repository'))),
    h('div', { class: 'stats' },
      stat('Repositories', repos.length),
      stat('Packages', total),
      stat('Published distributions', pubs.length),
      stat('Snapshots', snaps.length)),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Name'), h('th', {}, 'Distribution'), h('th', {}, 'Component'),
        h('th', { class: 'num' }, 'Packages'), h('th', {}, 'Published as'), h('th', {}, 'Comment'))),
      h('tbody', {}, repos.length ? repos.map((r, i) => h('tr', {},
        h('td', {}, h('a', { href: `#/repo/${enc(r.Name)}` }, h('strong', {}, r.Name))),
        h('td', {}, r.DefaultDistribution || '—'),
        h('td', {}, r.DefaultComponent || '—'),
        h('td', { class: 'num' }, counts[i] ?? '?'),
        h('td', {}, pubsForRepo(pubs, r.Name).map(p => h('span', { class: 'tag ok' }, pubName(p)))),
        h('td', { class: 'desc' }, r.Comment || '')))
        : h('tr', {}, h('td', { colspan: 6, class: 'empty' }, 'No repositories yet.'))))),
    h('h2', {}, 'Published distributions'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Distribution'), h('th', {}, 'Sources'), h('th', {}, 'Architectures'), h('th', {}, 'Origin / Label'))),
      h('tbody', {}, pubs.length ? pubs.map(p => h('tr', {},
        h('td', {}, h('a', { href: new URL(`${p.Prefix === '.' ? '' : `${p.Prefix}/`}dists/${p.Distribution}/`, REPO_BASE).href, target: '_blank' }, pubName(p))),
        h('td', {}, (p.Sources || []).map(s => h('span', { class: 'tag' }, `${s.Component}: ${s.Name}`)), p.SourceKind === 'snapshot' ? ' (snapshot)' : ''),
        h('td', {}, (p.Architectures || []).join(', ')),
        h('td', { class: 'desc' }, [p.Origin, p.Label].filter(Boolean).join(' / '))))
        : h('tr', {}, h('td', { colspan: 4, class: 'empty' }, 'Nothing is published yet.'))))));
}

async function createRepoDialog(pubs) {
  const v = await openDialog({
    title: 'New repository',
    text: 'Creates an aptly local repository and publishes it as its own distribution (suite).',
    fields: [
      { name: 'name', label: 'Name', required: true, pattern: '[A-Za-z0-9][\\w.\\-]*', placeholder: 'trixie-testing' },
      { name: 'dist', label: 'Distribution', required: true, placeholder: 'trixie-testing', hint: 'The "Suites:" value clients put in their sources file' },
      { name: 'comp', label: 'Component', value: 'main', required: true },
      { name: 'comment', label: 'Comment' },
      { name: 'archs', label: 'Architectures', value: info.architectures.join(', '), hint: 'Comma-separated; used when publishing' },
      { name: 'publish', type: 'checkbox', label: 'Publish now', value: true },
    ],
    submit: 'Create',
  });
  if (!v) return;
  if (v.publish && pubs.some(p => p.Prefix === '.' && p.Distribution === v.dist)) {
    toast(`Distribution ${v.dist} is already published — pick another distribution name`, 'error');
    return;
  }
  try {
    await api('POST', 'repos', { Name: v.name, Comment: v.comment, DefaultDistribution: v.dist, DefaultComponent: v.comp });
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  if (v.publish) {
    try {
      await api('POST', 'publish/:.', {
        SourceKind: 'local',
        Sources: [{ Component: v.comp, Name: v.name }],
        Distribution: v.dist,
        Architectures: v.archs.split(/[\s,]+/).filter(Boolean),
        Origin: info.origin,
        Label: info.label,
        Signing: { Batch: true },
      });
    } catch (e) {
      toast(`Repository created, but publishing failed: ${e.message}`, 'error');
    }
  }
  toast(`Created ${v.name}`, 'ok');
  location.hash = `#/repo/${enc(v.name)}`;
}

// ------------------------------------------------------------------ views: one repository

const repoView = { filter: '', sort: 'Package', dir: 1 };

async function viewRepo(match) {
  const name = decodeURIComponent(match[1]);
  const [repo, initial, pubs, repos] = await Promise.all([
    api('GET', `repos/${enc(name)}`),
    api('GET', `repos/${enc(name)}/packages?format=details`),
    api('GET', 'publish'),
    api('GET', 'repos'),
  ]);
  let packages = initial || [];
  const published = pubsForRepo(pubs, name);
  const otherRepos = repos.map(r => r.Name).filter(n => n !== name).sort();
  const selected = new Set();

  const tbody = h('tbody');
  const countEl = h('span', { class: 'muted' });
  const selectionEl = h('span');
  const allBox = h('input', {
    type: 'checkbox', 'aria-label': 'Select all shown',
    onchange: e => {
      for (const p of visible()) e.target.checked ? selected.add(p.Key) : selected.delete(p.Key);
      render();
    },
  });
  const removeBtn = h('button', { class: 'danger', onclick: () => removeSelected() }, 'Remove');
  const copyBtn = h('button', { onclick: () => copySelected() }, 'Copy to…');

  function visible() {
    const q = repoView.filter.toLowerCase();
    const list = q
      ? packages.filter(p => `${p.Package} ${p.Version} ${p.Architecture} ${p.Description || ''}`.toLowerCase().includes(q))
      : packages.slice();
    const { sort, dir } = repoView;
    return list.sort((a, b) =>
      (sort === 'Version' ? cmpVersion(a.Version, b.Version) : String(a[sort]).localeCompare(String(b[sort]))) * dir
      || a.Package.localeCompare(b.Package)
      || cmpVersion(b.Version, a.Version)
      || a.Architecture.localeCompare(b.Architecture));
  }

  function render() {
    const list = visible();
    countEl.textContent = `${list.length} of ${packages.length} packages`;
    tbody.replaceChildren(...list.map(p => h('tr', {},
      h('td', { class: 'col-check' }, h('input', {
        type: 'checkbox', 'aria-label': `Select ${p.Package} ${p.Version}`, checked: selected.has(p.Key),
        onchange: e => { e.target.checked ? selected.add(p.Key) : selected.delete(p.Key); updateSelection(); },
      })),
      h('td', {}, h('a', { href: '#', onclick: e => { e.preventDefault(); showPackage(p); } }, p.Package)),
      h('td', { class: 'mono' }, p.Version),
      h('td', {}, p.Architecture),
      h('td', { class: 'num' }, p.Size ? fmtBytes(Number(p.Size)) : ''),
      h('td', { class: 'desc' }, (p.Description || '').split('\n')[0]))));
    if (!list.length) {
      tbody.append(h('tr', {}, h('td', { colspan: 6, class: 'empty' },
        packages.length ? 'No packages match the filter.' : 'No packages yet — upload some .deb files above.')));
    }
    allBox.checked = list.length > 0 && list.every(p => selected.has(p.Key));
    updateSelection();
  }

  function updateSelection() {
    selectionEl.textContent = selected.size ? `${selected.size} selected` : '';
    removeBtn.disabled = copyBtn.disabled = !selected.size;
  }

  async function reload() {
    packages = await api('GET', `repos/${enc(name)}/packages?format=details`) || [];
    const keys = new Set(packages.map(p => p.Key));
    for (const k of [...selected]) if (!keys.has(k)) selected.delete(k);
    render();
  }

  async function removeRefs(refs, title) {
    const ok = await openDialog({
      title,
      text: `They are removed from ${name}. Their files stay in the pool until you run "Clean up storage".`,
      submit: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('DELETE', `repos/${enc(name)}/packages`, { PackageRefs: refs });
      for (const r of refs) selected.delete(r);
      await afterChange(name);
    } catch (e) {
      toast(e.message, 'error');
    }
    await reload();
  }

  function removeSelected() {
    return removeRefs([...selected], `Remove ${selected.size} package(s)?`);
  }

  async function copySelected() {
    if (!otherRepos.length) return toast('Create another repository first (e.g. a stable channel to promote into).', 'warn');
    const v = await openDialog({
      title: `Copy ${selected.size} package(s)`,
      text: 'Adds the selected packages to another repository, e.g. to promote them from testing to stable.',
      fields: [{ name: 'dest', label: 'Target repository', type: 'select', options: otherRepos }],
      submit: 'Copy',
    });
    if (!v) return;
    try {
      await api('POST', `repos/${enc(v.dest)}/packages`, { PackageRefs: [...selected] });
      toast(`Copied ${selected.size} package(s) to ${v.dest}`, 'ok');
      await afterChange(v.dest);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function prune() {
    const v = await openDialog({
      title: 'Prune old versions',
      text: 'Keeps the newest N versions of every package (per architecture) and removes the rest.',
      fields: [{ name: 'keep', label: 'Versions to keep', type: 'number', value: '3', min: '1', required: true }],
      submit: 'Preview',
    });
    if (!v) return;
    const keep = Math.max(1, parseInt(v.keep, 10) || 1);
    const groups = new Map();
    for (const p of packages) {
      const k = `${p.Package}\0${p.Architecture}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    const doomed = [];
    for (const list of groups.values()) doomed.push(...list.sort((a, b) => cmpVersion(b.Version, a.Version)).slice(keep));
    if (!doomed.length) return toast(`Nothing to prune: no package has more than ${keep} version(s)`, 'ok');
    const shown = doomed.slice(0, 50).map(p => h('li', { class: 'mono' }, `${p.Package} ${p.Version} ${p.Architecture}`));
    if (doomed.length > 50) shown.push(h('li', { class: 'muted' }, `…and ${doomed.length - 50} more`));
    const ok = await openDialog({
      title: `Remove ${doomed.length} old package version(s)?`,
      content: h('ul', {}, shown),
      submit: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('DELETE', `repos/${enc(name)}/packages`, { PackageRefs: doomed.map(p => p.Key) });
      await afterChange(name);
    } catch (e) {
      toast(e.message, 'error');
    }
    await reload();
  }

  async function snapshot() {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const v = await openDialog({
      title: `Snapshot ${name}`,
      text: 'A snapshot is a frozen copy of the package list. You can restore the repository from it later.',
      fields: [
        { name: 'name', label: 'Snapshot name', value: `${name}-${stamp}`, required: true },
        { name: 'desc', label: 'Description', placeholder: 'e.g. before upgrading to 2.0' },
      ],
      submit: 'Create snapshot',
    });
    if (!v) return;
    try {
      // Keep aptly's default wording so the restore dialog can suggest the source repo.
      const desc = `Snapshot from local repo [${name}]${v.desc ? `: ${v.desc}` : ''}`;
      await api('POST', `repos/${enc(name)}/snapshots`, { Name: v.name, Description: desc });
      toast(`Created snapshot ${v.name}`, 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function deleteRepo() {
    const v = await openDialog({
      title: `Delete ${name}?`,
      text: `This unpublishes ${published.map(pubName).join(', ') || 'nothing'} (clients will get errors on apt update) and deletes the repository. Snapshots are kept.`,
      fields: [{ name: 'confirm', label: `Type "${name}" to confirm`, required: true, pattern: escapeRegex(name) }],
      submit: 'Delete repository',
      danger: true,
    });
    if (!v) return;
    try {
      for (const p of published) await api('DELETE', `publish/${prefixParam(p)}/${enc(p.Distribution)}`);
      await api('DELETE', `repos/${enc(name)}?force=1`);
      toast(`Deleted ${name}`, 'ok');
      location.hash = '#/';
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  const sortHeader = (key, label, cls) => {
    const active = repoView.sort === key;
    return h('th', {
      class: `sortable ${cls || ''}`,
      'aria-sort': active ? (repoView.dir > 0 ? 'ascending' : 'descending') : null,
      onclick: e => {
        repoView.dir = active ? -repoView.dir : 1;
        repoView.sort = key;
        e.currentTarget.closest('thead').replaceWith(thead());
        render();
      },
    }, label, active ? h('span', { class: 'arrow' }, repoView.dir > 0 ? ' ▲' : ' ▼') : null);
  };
  const thead = () => h('thead', {}, h('tr', {},
    h('th', { class: 'col-check' }, allBox),
    sortHeader('Package', 'Package'),
    sortHeader('Version', 'Version'),
    sortHeader('Architecture', 'Arch'),
    h('th', { class: 'num' }, 'Size'),
    h('th', {}, 'Description')));

  const upload = uploadPanel([name], name, reload);
  upload.hidden = packages.length > 0;

  const node = h('div', {},
    h('div', { class: 'page-head' },
      h('h1', {}, name),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: () => { upload.hidden = !upload.hidden; } }, 'Upload .deb'),
        h('button', {
          onclick: e => busy(e.currentTarget, async () => {
            const done = await republish(name);
            toast(done.length ? `Published ${done.join(', ')}` : `${name} is not published`, done.length ? 'ok' : 'warn');
          }),
        }, 'Republish'),
        h('button', { onclick: snapshot }, 'Snapshot'),
        h('button', { onclick: prune }, 'Prune old versions'),
        h('button', { class: 'danger', onclick: deleteRepo }, 'Delete')),
      h('div', { class: 'sub muted' },
        `Distribution ${repo.DefaultDistribution || '—'} · component ${repo.DefaultComponent || '—'} · `,
        published.length ? ['published as ', published.map(p => h('span', { class: 'tag ok' }, pubName(p)))] : 'not published',
        repo.Comment ? ` · ${repo.Comment}` : '')),
    upload,
    h('div', { class: 'toolbar' },
      h('input', {
        type: 'search', placeholder: 'Filter packages…', value: repoView.filter, 'aria-label': 'Filter packages',
        oninput: e => { repoView.filter = e.target.value; render(); },
      }),
      countEl,
      h('span', { class: 'spacer' }),
      selectionEl, copyBtn, removeBtn),
    h('div', { class: 'table-wrap' }, h('table', {}, thead(), tbody)));
  render();
  return node;
}

// ------------------------------------------------------------------ upload

function uploadPanel(repoNames, fixedRepo, onUploaded) {
  let files = [];
  const input = h('input', {
    type: 'file', multiple: true, hidden: true, accept: '.deb,.udeb,.ddeb,.dsc,.gz,.xz,.bz2,.zst',
    onchange: () => { addFiles(input.files); input.value = ''; },
  });
  const drop = h('div', {
    class: 'dropzone', tabindex: '0', role: 'button',
    onclick: () => input.click(),
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
    ondragover: e => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); },
  }, h('strong', {}, 'Drop .deb files here'), h('span', { class: 'muted' }, ' or click to choose'));
  const list = h('ul', { class: 'file-list' });
  const repoSelect = fixedRepo ? null : h('select', { 'aria-label': 'Target repository' }, repoNames.map(n => h('option', { value: n }, n)));
  const force = h('input', { type: 'checkbox' });
  const progress = h('progress', { max: '1', hidden: true });
  const report = h('div', { class: 'report' });
  const button = h('button', { class: 'primary', disabled: true, onclick: run }, 'Upload');

  function addFiles(fileList) {
    for (const f of fileList) {
      if (!files.some(x => x.name === f.name && x.size === f.size)) files.push(f);
    }
    renderList();
  }

  function renderList() {
    list.replaceChildren(...files.map((f, i) => h('li', {},
      h('span', {}, f.name),
      h('span', { class: 'muted' }, fmtBytes(f.size)),
      h('button', { class: 'link', title: `Remove ${f.name}`, onclick: () => { files.splice(i, 1); renderList(); } }, '×'))));
    button.disabled = !files.length;
  }

  function section(title, items, cls) {
    if (!items.length) return null;
    return [h('h4', { class: cls }, `${title} (${items.length})`), h('ul', {}, items.map(x => h('li', { class: 'mono' }, x)))];
  }

  async function run() {
    const repo = fixedRepo || repoSelect.value;
    if (!repo) return toast('Choose a repository first', 'warn');
    const dir = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let leftovers = true; // aptly deletes the upload dir itself when every file imports
    button.disabled = true;
    progress.hidden = false;
    progress.value = 0;
    report.replaceChildren();
    try {
      await uploadFiles(dir, files, f => { progress.value = f; });
      progress.removeAttribute('value'); // indeterminate while aptly imports
      const res = await api('POST', `repos/${enc(repo)}/file/${enc(dir)}${force.checked ? '?forceReplace=1' : ''}`) || {};
      const r = res.Report || {};
      const added = r.Added || [];
      const removed = r.Removed || [];
      const failed = (res.FailedFiles || []).map(f => f.split('/').pop());
      leftovers = failed.length > 0;
      report.replaceChildren(h('div', {},
        section('Added', added, 'ok'),
        section('Replaced', removed, 'warn'),
        section('Warnings', r.Warnings || [], 'warn'),
        section('Failed files', failed, 'error')));
      if (added.length || removed.length) {
        files = files.filter(f => failed.includes(f.name));
        renderList();
        await afterChange(repo);
        if (onUploaded) await onUploaded();
      } else {
        toast('Nothing was added — see the report below', 'warn');
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      progress.hidden = true;
      button.disabled = !files.length;
      if (leftovers) api('DELETE', `files/${enc(dir)}`).catch(() => {});
    }
  }

  return h('div', { class: 'panel' },
    h('h3', {}, fixedRepo ? `Upload to ${fixedRepo}` : 'Upload packages'),
    drop, input, list,
    h('div', { class: 'upload-controls' },
      repoSelect ? h('label', { class: 'check' }, 'Repository ', repoSelect) : null,
      h('label', { class: 'check', title: 'Overwrite packages with the same name, version and architecture but different contents' },
        force, 'Replace conflicting packages (not recommended — bump the version instead)'),
      button),
    progress,
    report);
}

async function viewUpload() {
  const repos = (await api('GET', 'repos')).map(r => r.Name).sort();
  if (!repos.length) {
    return h('div', { class: 'panel' }, 'Create a repository first on the ', h('a', { href: '#/' }, 'Repositories'), ' page.');
  }
  return h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, 'Upload')),
    uploadPanel(repos, null, null));
}

// ------------------------------------------------------------------ snapshots

async function viewSnapshots() {
  const [snaps, repos] = await Promise.all([api('GET', 'snapshots'), api('GET', 'repos')]);
  const repoNames = repos.map(r => r.Name).sort();
  snaps.sort((a, b) => String(b.CreatedAt).localeCompare(String(a.CreatedAt)));

  async function showPackages(s) {
    const pkgs = await api('GET', `snapshots/${enc(s.Name)}/packages?format=details`) || [];
    pkgs.sort((a, b) => a.Package.localeCompare(b.Package) || cmpVersion(b.Version, a.Version));
    openDialog({
      title: `${s.Name} (${pkgs.length} packages)`,
      content: h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Package'), h('th', {}, 'Version'), h('th', {}, 'Arch'))),
        h('tbody', {}, pkgs.map(p => h('tr', {}, h('td', {}, p.Package), h('td', { class: 'mono' }, p.Version), h('td', {}, p.Architecture))))),
      submit: null,
      cancel: 'Close',
      wide: true,
    });
  }

  // Makes the repository contain exactly the snapshot's packages.
  async function restore(s) {
    if (!repoNames.length) return toast('There is no repository to restore into', 'warn');
    const source = (String(s.Description).match(/local repo \[(.+?)\]/) || [])[1];
    const v = await openDialog({
      title: `Restore ${s.Name}`,
      text: 'The repository will contain exactly the packages in this snapshot. Packages added since the snapshot are removed from it.',
      fields: [{ name: 'repo', label: 'Repository', type: 'select', options: repoNames, value: repoNames.includes(source) ? source : repoNames[0] }],
      submit: 'Restore',
      danger: true,
    });
    if (!v) return;
    try {
      const [snapRefs, repoRefs] = await Promise.all([
        api('GET', `snapshots/${enc(s.Name)}/packages`),
        api('GET', `repos/${enc(v.repo)}/packages`),
      ]);
      const want = new Set(snapRefs || []);
      const have = new Set(repoRefs || []);
      const toRemove = [...have].filter(k => !want.has(k));
      const toAdd = [...want].filter(k => !have.has(k));
      if (toRemove.length) await api('DELETE', `repos/${enc(v.repo)}/packages`, { PackageRefs: toRemove });
      if (toAdd.length) await api('POST', `repos/${enc(v.repo)}/packages`, { PackageRefs: toAdd });
      toast(`Restored ${v.repo}: ${toAdd.length} added, ${toRemove.length} removed`, 'ok');
      if (toAdd.length || toRemove.length) await afterChange(v.repo);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function remove(s) {
    const ok = await openDialog({ title: `Delete snapshot ${s.Name}?`, submit: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `snapshots/${enc(s.Name)}`);
      toast(`Deleted ${s.Name}`, 'ok');
      route();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  return h('div', {},
    h('div', { class: 'page-head' },
      h('h1', {}, 'Snapshots'),
      h('div', { class: 'sub muted' }, 'Create snapshots from a repository page. Take one before big changes so you can roll back.')),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Created'), h('th', {}, 'Description'), h('th', {}))),
      h('tbody', {}, snaps.length ? snaps.map(s => h('tr', {},
        h('td', {}, h('strong', {}, s.Name)),
        h('td', {}, fmtDate(s.CreatedAt)),
        h('td', { class: 'desc' }, s.Description || ''),
        h('td', { class: 'row-actions' },
          h('button', { class: 'small', onclick: e => busy(e.currentTarget, () => showPackages(s)) }, 'Packages'),
          h('button', { class: 'small', onclick: () => restore(s) }, 'Restore…'),
          h('button', { class: 'small danger', onclick: () => remove(s) }, 'Delete'))))
        : h('tr', {}, h('td', { colspan: 4, class: 'empty' }, 'No snapshots yet.'))))));
}

// ------------------------------------------------------------------ client setup

function codeBlock(text) {
  const pre = h('pre', {}, text);
  const copy = h('button', {
    class: 'small',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = 'Copied';
      } catch {
        getSelection().selectAllChildren(pre);
        copy.textContent = 'Press Ctrl+C';
      }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    },
  }, 'Copy');
  return h('div', { class: 'code' }, pre, copy);
}

async function viewSetup() {
  const [pubs, repos] = await Promise.all([api('GET', 'publish'), api('GET', 'repos')]);
  const root = REPO_BASE.href.replace(/\/$/, '');
  const name = (info.label || 'apt-repo').toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
  const keyring = `/etc/apt/keyrings/${name}.gpg`;
  const firstRepo = repos.map(r => r.Name).sort()[0] || 'trixie-main';

  const sources = pubs.map(p => {
    const uri = p.Prefix && p.Prefix !== '.' ? `${root}/${p.Prefix}` : root;
    const components = [...new Set((p.Sources || []).map(s => s.Component))].join(' ');
    return [
      h('h3', {}, pubName(p)),
      codeBlock(
        `sudo tee /etc/apt/sources.list.d/${name}-${p.Distribution.replace(/\//g, '-')}.sources > /dev/null <<'EOF'\n` +
        `Types: deb\nURIs: ${uri}\nSuites: ${p.Distribution}\nComponents: ${components}\nSigned-By: ${keyring}\nEOF\n` +
        'sudo apt update'),
    ];
  });

  return h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, 'Client setup')),
    h('div', { class: 'panel' },
      h('h2', {}, '1. Trust the signing key'),
      info.fingerprint ? h('p', {}, 'Fingerprint: ', h('code', {}, info.fingerprint)) : null,
      codeBlock(
        'sudo install -d -m 0755 /etc/apt/keyrings\n' +
        `curl -fsSL ${root}/repo.gpg | sudo tee ${keyring} > /dev/null\n` +
        `gpg --show-keys ${keyring}   # check the fingerprint matches`)),
    info.private ? h('div', { class: 'panel' },
      h('h2', {}, '2. Store the repository login'),
      h('p', { class: 'muted' }, 'This repository requires a login. apt reads credentials from auth.conf.d:'),
      codeBlock(
        `sudo tee /etc/apt/auth.conf.d/${name}.conf > /dev/null <<'EOF'\n` +
        `machine ${REPO_BASE.host}\nlogin ${info.readUser}\npassword YOUR_REPO_READ_PASSWORD\nEOF\n` +
        `sudo chmod 600 /etc/apt/auth.conf.d/${name}.conf`)) : null,
    h('div', { class: 'panel' },
      h('h2', {}, `${info.private ? '3' : '2'}. Add the repository`),
      h('p', { class: 'muted' }, 'One deb822 sources file per distribution. Pick the one matching your machines.'),
      sources.length ? sources : h('p', {}, 'Nothing is published yet.')),
    h('div', { class: 'panel' },
      h('h2', {}, 'Uploading from CI'),
      h('p', { class: 'muted' }, 'Use scripts/apt-upload.sh from this project (needs curl and jq):'),
      codeBlock(
        `export APT_REPO_URL=${root}\nexport APT_REPO_USER=admin\nexport APT_REPO_PASSWORD=...\n` +
        `./scripts/apt-upload.sh ${firstRepo} build/*.deb`),
      h('p', { class: 'muted' }, 'Or call the aptly API directly:'),
      codeBlock(
        `curl -u admin:PASSWORD -F file=@pkg.deb ${root}/api/files/ci-upload\n` +
        `curl -u admin:PASSWORD -X POST ${root}/api/repos/${firstRepo}/file/ci-upload\n` +
        `curl -u admin:PASSWORD -X PUT -H 'Content-Type: application/json' \\\n` +
        `     -d '{"Signing":{"Batch":true}}' ${root}/api/publish/:./DISTRIBUTION`)));
}

// ------------------------------------------------------------------ login

function showLogin(message) {
  setAuth('');
  routeToken++; // drop pages that are still loading
  document.body.classList.add('logged-out');
  const field = (label, attrs) => {
    const input = h('input', { placeholder: ' ', required: true, spellcheck: 'false', ...attrs });
    return [input, h('label', { class: 'field' }, h('span', {}, label), input)];
  };
  const [user, userField] = field('Username', { type: 'text', name: 'username', autocomplete: 'username' });
  const [password, passwordField] = field('Password', { type: 'password', name: 'password', autocomplete: 'current-password' });
  const error = h('p', { class: 'login-error', role: 'alert' }, message || '');
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Sign in');

  const form = h('form', {
    class: 'panel login',
    onsubmit: async e => {
      e.preventDefault();
      submit.disabled = true;
      error.textContent = '';
      try {
        const auth = basicAuth(user.value, password.value);
        const res = await authFetch(new URL('version', API_BASE), {}, auth);
        if (res.status === 401) throw new Error('Wrong username or password.');
        if (!res.ok) throw new Error(`Could not reach the API (${res.status} ${res.statusText}).`);
        setAuth(auth);
        start();
      } catch (err) {
        error.textContent = err.message;
        password.select();
      } finally {
        submit.disabled = false;
      }
    },
  }, h('h2', {}, 'Sign in'), userField, passwordField, error, submit);

  app.replaceChildren(form);
  user.focus();
}

// Loads what every page needs once signed in, then shows the current page.
async function start() {
  document.body.classList.remove('logged-out');
  app.replaceChildren();
  try {
    const res = await authFetch('info.json', { cache: 'no-store' });
    if (res.ok) info = { ...info, ...await res.json() };
  } catch { /* keep defaults */ }

  api('GET', 'version')
    .then(v => { document.getElementById('version').textContent = `aptly ${String(v.Version).trim()}`; })
    .catch(() => {});

  route();
}

// ------------------------------------------------------------------ router

const routes = [
  [/^#?\/?$/, viewRepos, 'repos'],
  [/^#\/repo\/(.+)$/, viewRepo, 'repos'],
  [/^#\/upload$/, viewUpload, 'upload'],
  [/^#\/snapshots$/, viewSnapshots, 'snapshots'],
  [/^#\/setup$/, viewSetup, 'setup'],
];

let routeToken = 0;

async function route() {
  if (!authHeader) return showLogin();
  const hash = location.hash || '#/';
  const token = ++routeToken;
  for (const [pattern, view, nav] of routes) {
    const match = hash.match(pattern);
    if (!match) continue;
    for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === nav);
    if (!app.firstChild) app.append(h('p', { class: 'muted loading' }, 'Loading…'));
    try {
      const node = await view(match);
      if (token === routeToken) app.replaceChildren(node);
    } catch (e) {
      if (token === routeToken) {
        app.replaceChildren(h('div', { class: 'panel error-panel' }, h('h2', {}, 'Could not load this page'), h('p', {}, e.message)));
      }
    }
    return;
  }
  location.hash = '#/';
}

function init() {
  const auto = document.getElementById('auto-publish');
  auto.checked = settings.autoPublish;
  auto.addEventListener('change', () => { settings.autoPublish = auto.checked; });

  document.getElementById('logout').addEventListener('click', () => showLogin());

  window.addEventListener('hashchange', route);
  if (authHeader) start();
  else showLogin();
}

init();
