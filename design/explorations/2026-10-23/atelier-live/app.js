'use strict';
// Intentionally browser-only: no API, storage, credentials or real equipment access.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
let state = freshState();
let activeView = 'home';
let activeFilter = 'all';
let confirmIntent = null;
let dialogTrigger = null;
let operationTimer = null;
let routerTimer = null;
let toastTimer = null;
let busy = false;
let readingRouter = false;
const modal = $('#modal');

function freshState() {
  return { pcOn: true, system: 'CachyOS', hermesOn: true, pcFresh: false, hermesFresh: false, routerFresh: false,
    events: [{ title: 'FiberHome reportó su estado', detail: 'Lectura recibida · simulación', time: 'Hace 25 s', result: 'OBSERVADO' },
      { title: 'Hermes está disponible', detail: 'Estado de EC2 · no verifica aplicaciones', time: 'Hace 40 s', result: 'OBSERVADO' }] };
}
function render() {
  $('[data-pc-system]').textContent = state.system;
  $('[data-pc-state]').textContent = busy && confirmIntent?.resource === 'pc' ? 'En proceso' : state.pcOn ? 'En línea' : 'Apagada';
  $('#pc-led').className = `led${state.pcOn ? '' : ' off'}`;
  $('.pc-panel').classList.toggle('is-off', !state.pcOn);
  $('#pc-observed').textContent = state.pcFresh ? 'Último aviso ahora' : 'Último aviso hace 12 s';
  $('#power-label').textContent = state.pcOn ? 'Apagar' : 'Encender';
  $('[data-action="pc-power"]').setAttribute('aria-label', state.pcOn ? 'Apagar PC' : 'Encender PC');
  $('[data-action="pc-power"]').classList.toggle('danger', state.pcOn);
  $('[data-action="pc-power"]').classList.toggle('copper-outline', !state.pcOn);
  $$('[data-pc-control], [data-action="hermes-power"]').forEach((button) => { button.disabled = busy; });
  $('#hermes-state').textContent = state.hermesOn ? 'EC2 encendida' : 'EC2 detenida';
  $('#hermes-led').className = `led${state.hermesOn ? '' : ' off'}`;
  $('#hermes-observed').textContent = state.hermesFresh ? 'Observado ahora' : 'Observado hace 40 s';
  $('[data-router-time]').textContent = state.routerFresh ? 'ahora' : 'hace 25 s';
  $('[data-action="router"]').disabled = readingRouter;
  $('#router-button-label').textContent = readingRouter ? 'Leyendo…' : 'Leer';
  $('#global-status').textContent = busy ? 'Orden en curso' : 'Sin alertas';
  $('#global-led').className = `led${busy ? ' busy' : ''}`;
  renderDevices(); renderActivity();
}
function devices() {
  return [
    { id: 'pc', name: 'PC de casa', type: 'home', icon: 'monitor', status: `${state.pcOn ? 'En línea' : 'Apagada'} · ${state.system}`, detail: 'El estado y el sistema de este equipo se simulan en tu navegador. Cambiar de sistema o apagar requiere confirmar la intención.' },
    { id: 'router', name: 'FiberHome', type: 'home', icon: 'router', status: 'Reportando · Internet de casa', detail: 'Recibir un reporte del router no garantiza acceso completo a Internet. Aquí puedes explorar la lectura sin consultar tu red real.' },
    { id: 'hermes', name: 'Hermes', type: 'cloud', icon: 'activity', status: state.hermesOn ? 'EC2 encendida' : 'EC2 detenida', detail: 'El estado de EC2 no verifica la salud de sus aplicaciones. Apagar Hermes detendría también el orquestador; esta maqueta solo simula la acción.' },
    { id: 'mac', name: 'MacBook', type: 'home', icon: 'laptop', status: 'Sin agente', detail: 'Esta MacBook no tiene agente en el escenario de demostración. Sin agente no significa apagada. No hay controles de energía disponibles.' },
    { id: 'game', name: 'game-server', type: 'cloud', icon: 'cloud', status: 'EC2 detenida · AWS', detail: 'Instancia de ejemplo detenida. El prototipo no ofrece control real de este recurso.' },
    { id: 'cms', name: 'prod-cms', type: 'cloud', icon: 'cloud', status: 'En ejecución · Servicio', detail: 'Servicio de muestra. Su estado es ficticio y no describe la aplicación productiva.' }
  ];
}
function renderDevices() {
  const query = $('#device-search').value.trim().toLocaleLowerCase('es');
  const filtered = devices().filter((d) => (activeFilter === 'all' || d.type === activeFilter) && `${d.name} ${d.status}`.toLocaleLowerCase('es').includes(query));
  $('#device-results').innerHTML = filtered.length ? filtered.map((d) => `<button class="inventory-item" data-device="${d.id}">${icon(d.icon)}<span><b>${escapeHTML(d.name)}</b><small>${escapeHTML(d.status)}</small></span>${icon('chevron')}</button>`).join('') : '<p class="empty">Sin coincidencias. Prueba con otro nombre.</p>';
}
function renderActivity() {
  $('#activity-list').innerHTML = state.events.map((event) => `<article class="event"><h3>${escapeHTML(event.title)}</h3><p>${escapeHTML(event.detail)}</p><time>${escapeHTML(event.time)}</time><span class="event-state">${escapeHTML(event.result)}</span></article>`).join('');
}
function setView(view, updateHash = true) {
  if (!['home', 'devices', 'activity', 'costs'].includes(view)) view = 'home';
  activeView = view;
  $$('.view').forEach((el) => { el.hidden = el.id !== `view-${view}`; });
  $$('[data-view]').forEach((el) => { if (el.dataset.view === view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  const titles = { home: 'Admin', devices: 'Equipos', activity: 'Actividad', costs: 'Costes' };
  $('#greeting').textContent = view === 'home' ? 'Buenas noches,' : 'Tu espacio,';
  $('#page-title').innerHTML = `${titles[view]}<span>.</span>`;
  $('.edition strong').textContent = view === 'home' ? 'Control' : 'Atelier';
  if (view === 'activity') $('.nav-dot').hidden = true;
  if (updateHash) history.replaceState(null, '', `#${view}`);
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function openDialog(content) {
  if (!modal.open) dialogTrigger = document.activeElement;
  $('#modal-content').innerHTML = content;
  if (!modal.open) modal.showModal();
  else $('#modal-content').querySelector('button')?.focus();
}
function closeDialog() { modal.close(); }
modal.addEventListener('close', () => {
  if (dialogTrigger?.isConnected && !dialogTrigger.disabled) dialogTrigger.focus();
  dialogTrigger = null;
  if (!busy) confirmIntent = null;
});
modal.addEventListener('click', (event) => { if (event.target === modal) { const rect = modal.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); } });
function systemDialog() {
  if (busy) return;
  openDialog(`<h2 id="modal-title">Elige cómo continuar.</h2><p>Un mismo equipo. Dos formas de usarlo.</p><div class="choices">${['CachyOS', 'Windows 11'].map((os) => `<button class="choice ${state.system === os ? 'current' : ''}" data-system="${os}"><span class="os-mark">${os === 'CachyOS' ? 'C' : 'W'}</span><span><b>${os}</b><small>${os === state.system ? 'Sistema actual' : os === 'CachyOS' ? 'Tu entorno de trabajo' : 'Tu espacio para jugar'}</small></span>${icon(os === state.system ? 'check' : 'chevron')}</button>`).join('')}</div><p class="modal-foot">Demostración: no se modificará tu PC real.</p>`);
}
function confirmAction(intent) {
  if (busy) return;
  confirmIntent = intent;
  const isSystem = intent.action === 'system';
  const resource = intent.resource === 'pc' ? 'PC de casa' : 'Hermes';
  const title = isSystem ? `Cambiar a ${escapeHTML(intent.system)}` : `Apagar ${resource}`;
  const consequence = isSystem ? 'Se cerrarán las sesiones abiertas y el equipo se reiniciará en el sistema elegido.' : intent.resource === 'hermes' ? 'Esto detendría también el orquestador. El panel seguiría disponible.' : 'Se cerrarán las sesiones abiertas. Podrás encender el equipo de nuevo desde aquí.';
  openDialog(`<h2 id="modal-title">${title}<span class="demo-text">.</span></h2><p>${consequence}</p><p class="dialog-notice">Solo se simula el recorrido. Ningún equipo real recibirá una orden.</p><div class="dialog-actions"><button class="button" data-action="close">Cancelar</button><button class="button ${isSystem ? 'copper' : 'danger'}" data-action="confirm">${isSystem ? 'Confirmar cambio' : 'Confirmar apagado'}</button></div>`);
}
function notify(text, pending = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text;
  $('#toast').classList.toggle('pending', pending);
  $('#toast').hidden = false;
  if (!pending) toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3800);
}
function addEvent(title, detail) {
  state.events.unshift({ title, detail, time: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }), result: 'SIMULACIÓN COMPLETADA' });
  if (activeView !== 'activity') $('.nav-dot').hidden = false;
}
function runOperation(intent) {
  if (busy) return;
  busy = true;
  confirmIntent = intent;
  if (modal.open) closeDialog();
  const resource = intent.resource === 'pc' ? 'PC de casa' : 'Hermes';
  const progress = intent.action === 'system' ? `Cambiando a ${intent.system}…` : intent.action === 'start' ? `Encendiendo ${resource}…` : `Apagando ${resource}…`;
  render(); notify(`${progress} · simulación`, true);
  operationTimer = setTimeout(() => {
    if (intent.resource === 'pc') {
      if (intent.action === 'system') { state.system = intent.system; state.pcOn = true; }
      else state.pcOn = intent.action === 'start';
      state.pcFresh = true;
    } else { state.hermesOn = intent.action === 'start'; state.hermesFresh = true; }
    const result = intent.action === 'system' ? `PC iniciada en ${intent.system}` : `${resource} ${intent.action === 'start' ? 'encendido' : 'apagado'}`;
    addEvent(result, 'Orden solicitada por Admin · escenario simulado');
    busy = false; confirmIntent = null; operationTimer = null;
    render(); notify(`${result} · simulación completada`);
  }, 1600);
}
function readRouter() {
  if (readingRouter) return;
  readingRouter = true; render();
  if (!busy) notify('Esperando reporte de FiberHome… · simulación', true);
  routerTimer = setTimeout(() => {
    state.routerFresh = true; readingRouter = false; routerTimer = null;
    addEvent('FiberHome reportó su estado', 'Lectura manual · no confirma acceso a Internet');
    render(); if (!busy) notify('Reporte recibido · simulación completada');
  }, 1100);
}
function deviceDialog(id) {
  const device = devices().find((item) => item.id === id);
  if (!device) return;
  const link = id === 'pc' ? '<button class="button copper" data-action="go-home">Ir a los controles</button>' : id === 'router' ? '<button class="button copper" data-action="read-from-dialog">Leer estado simulado</button>' : '<button class="button" data-action="close">Entendido</button>';
  openDialog(`<h2 id="modal-title">${escapeHTML(device.name)}</h2><p>${escapeHTML(device.detail)}</p><div class="info-facts"><div><span>Estado de muestra</span><b>${escapeHTML(device.status)}</b></div><div><span>Origen</span><b>Datos simulados</b></div></div><div class="dialog-actions">${link}</div>`);
}
function reset() {
  clearTimeout(operationTimer); clearTimeout(routerTimer); clearTimeout(toastTimer);
  busy = false; readingRouter = false; confirmIntent = null;
  state = freshState(); activeFilter = 'all'; $('#device-search').value = '';
  $$('.filter').forEach((b) => { const current = b.dataset.filter === 'all'; b.classList.toggle('active', current); b.setAttribute('aria-pressed', String(current)); });
  $('.nav-dot').hidden = true; closeDialog(); render(); setView('home'); notify('Demo reiniciada. Volvemos al principio.');
}
const actions = {
  close: closeDialog,
  system: systemDialog,
  'pc-power': () => state.pcOn ? confirmAction({ resource: 'pc', action: 'stop' }) : runOperation({ resource: 'pc', action: 'start' }),
  'hermes-power': () => state.hermesOn ? confirmAction({ resource: 'hermes', action: 'stop' }) : runOperation({ resource: 'hermes', action: 'start' }),
  confirm: () => { if (confirmIntent && !busy) runOperation({ ...confirmIntent }); },
  router: readRouter,
  'hermes-read': () => { state.hermesFresh = true; addEvent('Consulta de Hermes', 'EC2 observada · no verifica aplicaciones'); render(); if (!busy) notify('Estado consultado · datos simulados'); },
  mac: () => deviceDialog('mac'),
  cloud: () => { activeFilter = 'cloud'; $('#device-search').value = ''; $$('.filter').forEach((b) => { const current = b.dataset.filter === 'cloud'; b.classList.toggle('active', current); b.setAttribute('aria-pressed', String(current)); }); renderDevices(); setView('devices'); },
  'go-home': () => { closeDialog(); setView('home'); },
  'read-from-dialog': () => { closeDialog(); readRouter(); },
  about: () => openDialog('<h2 id="modal-title">Ahora sí, puedes tocarlo.</h2><p>Carbón / Atelier es una maqueta interactiva. Explora los controles, cambia de sistema y recorre tu infraestructura de muestra.</p><p class="dialog-notice">Todo sucede en este navegador. No hay conexión con tu PC, AWS, router ni servicios reales. Recargar reinicia la demo.</p><div class="dialog-actions"><button class="button copper" data-action="close">Explorar</button></div>'),
  settings: () => openDialog('<h2 id="modal-title">Tu mesa de pruebas.</h2><p>Carbón / Atelier · Versión interactiva 09</p><div class="settings-list"><button class="button copper-outline" data-action="reset">Reiniciar demo</button><button class="button" data-action="about">Acerca de este prototipo</button></div><p class="modal-foot">Los datos viven solo durante esta sesión. Las acciones no controlan equipos reales.</p>'),
  reset
};
document.addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  if (target.dataset.view) return setView(target.dataset.view);
  if (target.dataset.device) return deviceDialog(target.dataset.device);
  if (target.dataset.filter) {
    activeFilter = target.dataset.filter;
    $$('.filter').forEach((b) => { const current = b === target; b.classList.toggle('active', current); b.setAttribute('aria-pressed', String(current)); });
    return renderDevices();
  }
  if (target.dataset.system) {
    if (target.dataset.system === state.system && state.pcOn) { closeDialog(); notify(`Ya estás en ${state.system}.`); }
    else confirmAction({ resource: 'pc', action: 'system', system: target.dataset.system });
    return;
  }
  actions[target.dataset.action]?.();
});
$('#device-search').addEventListener('input', renderDevices);
window.addEventListener('hashchange', () => setView(location.hash.slice(1), false));
render(); setView(location.hash.slice(1) || 'home', false);
