/* ============================================================
   TASKBOARD — app.js
   Sections:
     1.  Constants
     2.  State & persistence
     3.  Seed data
     4.  Date utilities
     5.  Habit occurrence generation
     6.  Render helpers (getCat, rgba)
     7.  Task row HTML builder
     8.  View router (renderMain)
     9.  View: Today / This week / Later
    10.  View: Category detail
    11.  View: Overdue
    12.  View: Habits
    13.  View: Log
    14.  View: Analytics (monthly summary)
    15.  Add-task form HTML
    16.  Task actions (toggle, delete, add)
    17.  Reschedule modal
    18.  Habit CRUD
    19.  Category CRUD
    20.  Navigation & sidebar
    21.  Boot
   ============================================================ */


// ── 1. Constants ──────────────────────────────────────────────────────────────

const COLOR_PALETTE = [
  '#c8f060','#60d4f0','#f060a8','#f0b860',
  '#a060f0','#60f0a0','#f06060','#60a8f0',
  '#f0e060','#b0b0b0',
];

const DAY_NAMES_SHORT = ['dom','lun','mar','mie','jue','vie','sab'];
const DAY_NAMES_FULL  = ['Domingo','Lunes','Martes','Miercoles','Jueves','Viernes','Sabado'];
const MONTH_NAMES     = [
  'enero','febrero','marzo','abril','mayo','junio',
  'julio','agosto','septiembre','octubre','noviembre','diciembre',
];
const MONTH_NAMES_CAPITALIZED = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
];

const STORAGE_KEY = 'tb_v3';


// ── 2. State & persistence ────────────────────────────────────────────────────

/**
 * Application state — single source of truth.
 *
 * tasks[]     {id, name, cat, due, time?, done, habitId?}
 * habits[]    {id, name, cat, days[0-6], dayLabels{dow:label}, occurrences[]}
 *   occurrence {date, weekStart, taskId, done}
 * categories[]{id, name, color}
 * log[]       {id, name, cat, completedAt(ISO), habitId?}
 */
let state = {
  tasks:      [],
  habits:     [],
  categories: [
    { id: 'trabajo',  name: 'Trabajo',  color: '#60a8f0' },
    { id: 'personal', name: 'Personal', color: '#a060f0' },
    { id: 'deportes', name: 'Deportes', color: '#c8f060' },
  ],
  log:      [],
  nextId:   100,
  selColor: COLOR_PALETTE[0],
};

// UI state (not persisted)
let currentView   = 'hoy';
let filterCatId   = null;
let sortBy        = 'due';
let statsMonth    = new Date().getMonth();
let statsYear     = new Date().getFullYear();
let calendarMonth = new Date().getMonth();
let calendarYear  = new Date().getFullYear();
let calendarSelectedDay = null;

// Editing state for modals
let editingHabitId     = null;
let reschedulingTaskId = null;
let pendingHabitDays   = [];
let pendingDayLabels   = {};
let pendingHabitFreq   = 'weekly';  // { "dow": "label" }

// ── Firebase sync ─────────────────────────────────────────────
// `db` es la instancia de Firestore. Se asigna en initFirebase()
// si el usuario configuró firebase-config.js correctamente.
let db             = null;
let ownSaveInFlight = false; // evita que nuestro propio snapshot dispare un re-render

function initFirebase() {
  // typeof check: si firebase-config.js no está cargado o tiene valores vacíos,
  // el app sigue funcionando solo con localStorage
  if (typeof firebase === 'undefined' || typeof firebaseConfig === 'undefined') return;
  if (firebaseConfig.apiKey === 'TU_API_KEY') return; // config sin completar

  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    setupRealtimeSync();
  } catch (e) {
    console.warn('[Firebase] init error:', e.message);
  }
}

function setupRealtimeSync() {
  // onSnapshot escucha el documento en tiempo real.
  // Cada vez que cambia (desde otro dispositivo), actualizamos el estado local.
  db.collection('taskboard').doc('state').onSnapshot(snapshot => {
    if (ownSaveInFlight) return; // fue nuestro propio guardado, lo ignoramos
    if (!snapshot.exists) return;
    const remote = snapshot.data();
    if (!remote || !remote.tasks) return;
    state = remote;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    render();
  }, err => {
    console.warn('[Firebase] snapshot error:', err.message);
  });
}

// JSON.parse(JSON.stringify()) elimina valores undefined que Firestore rechaza
function cleanForFirestore(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function saveState() {
  // 1. Guardamos en localStorage (instantáneo, funciona offline)
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}

  // 2. Si Firebase está listo, sincronizamos a la nube en segundo plano
  if (db) {
    ownSaveInFlight = true;
    db.collection('taskboard').doc('state').set(cleanForFirestore(state))
      .catch(e => console.warn('[Firebase] save error:', e.message))
      .finally(() => { setTimeout(() => { ownSaveInFlight = false; }, 300); });
  }
}

async function loadState() {
  // Paso 1: cargamos localStorage para mostrar algo de inmediato
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) state = Object.assign({}, state, JSON.parse(saved));
  } catch (e) {}

  if (db) {
    try {
      const snapshot = await db.collection('taskboard').doc('state').get();

      if (snapshot.exists && snapshot.data()?.tasks?.length) {
        // Firestore tiene datos → es la fuente de verdad
        state = snapshot.data();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } else if (state.tasks?.length) {
        // Firestore está vacío pero localStorage tiene datos:
        // primera vez que abrimos con Firebase configurado → subimos todo
        console.log('[Firebase] Subiendo datos locales a Firestore...');
        await db.collection('taskboard').doc('state').set(cleanForFirestore(state));
        console.log('[Firebase] Sincronización inicial completada.');
      }
    } catch (e) {
      console.warn('[Firebase] load error, usando localStorage:', e.message);
    }
  }

  if (!state.tasks?.length && !state.habits?.length) seedDemoData();
  ensureWeeklyOccurrences();
}


// ── 3. Seed data ──────────────────────────────────────────────────────────────

function seedDemoData() {
  state.habits = [
    { id: 'hb1', name: 'Gym',       dayLabels: {}, cat: 'deportes', days: [1,3,5], occurrences: [] },
    { id: 'hb2', name: 'Agua 2L',   dayLabels: {}, cat: 'personal', days: [0,1,2,3,4,5,6], occurrences: [] },
    { id: 'hb3', name: 'Meditacion',dayLabels: {}, cat: 'personal', days: [1,2,3,4,5], occurrences: [] },
  ];
  state.tasks = [
    { id: 1, name: 'Revisar emails',        cat: 'trabajo',  due: todayStr(),    done: false },
    { id: 2, name: 'Preparar reunion',       cat: 'trabajo',  due: todayStr(),    done: false },
    { id: 3, name: 'Actualizar documentacion', cat: 'trabajo', due: offsetDate(3), done: false },
    { id: 4, name: 'Llamar al medico',       cat: 'personal', due: offsetDate(1), done: false },
  ];
  state.nextId = 200;
}


// ── 4. Date utilities ─────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function offsetDate(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

/** ISO date of the Monday that starts the current week */
function weekStart() {
  const d = new Date(), day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

/** ISO date of the Sunday that ends the current week */
function weekEnd() {
  const d = new Date(weekStart() + 'T12:00:00');
  d.setDate(d.getDate() + 6);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

/** ISO date for the given day-of-week (0=Sun,1=Mon…) within the current week */
function weekdayDate(dow) {
  const ws  = new Date(weekStart() + 'T12:00:00');
  const off = dow === 0 ? 6 : dow - 1;
  ws.setDate(ws.getDate() + off);
  return `${ws.getFullYear()}-${pad(ws.getMonth()+1)}-${pad(ws.getDate())}`;
}

/** "15 abr" style short date */
function formatDateShort(isoStr) {
  if (!isoStr) return '';
  const [, m, d] = isoStr.split('-');
  return `${parseInt(d)} ${MONTH_NAMES[parseInt(m)-1].slice(0,3)}`;
}

/** Human label for a due date: "hoy", "manana", "vencida", or short date */
function dueDateLabel(due) {
  if (!due) return '';
  const today = todayStr();
  if (due < today)          return 'vencida';
  if (due === today)        return 'hoy';
  if (due === offsetDate(1)) return 'manana';
  return formatDateShort(due);
}

/** CSS class for coloring the due date label */
function dueDateClass(due) {
  if (!due) return '';
  const today = todayStr();
  if (due < today)          return 'overdue';
  if (due === today)        return 'today';
  if (due === offsetDate(1)) return 'soon';
  return '';
}

/** Which view section a task belongs to based on its due date */
function taskSection(task) {
  if (task.cancelled) return 'cancelled';
  if (!task.due) return 'luego';
  const today = todayStr(), yesterday = offsetDate(-1), endWeek = weekEnd();
  if (task.due === today || task.due === yesterday) return 'hoy';
  if (task.due < yesterday) return 'vencida';
  if (task.due <= endWeek)  return 'semana';
  return 'luego';
}


// ── 5. Habit occurrence generation ───────────────────────────────────────────

/**
 * For each habit, ensure linked tasks exist for all scheduled dates.
 * Weekly: current week only. Biweekly/monthly: rolling 60-day window.
 */
function ensureWeeklyOccurrences() {
  const today   = todayStr();
  const ws      = weekStart(), we = weekEnd();
  const horizon = offsetDate(60);

  state.habits.forEach(habit => {
    if (!habit.occurrences) habit.occurrences = [];
    if (!habit.dayLabels)   habit.dayLabels   = {};
    const freq = habit.freq || 'weekly';

    if (freq === 'weekly') {
      habit.days.forEach(dow => {
        const dateStr = weekdayDate(dow);
        if (dateStr < ws || dateStr > we) return;
        if (habit.occurrences.find(o => o.date === dateStr && o.weekStart === ws)) return;
        const taskId   = state.nextId++;
        const dayLabel = habit.dayLabels[String(dow)];
        const taskName = dayLabel ? habit.name + ' — ' + dayLabel : habit.name;
        state.tasks.push({ id: taskId, name: taskName, cat: habit.cat, due: dateStr, done: false, habitId: habit.id });
        habit.occurrences.push({ date: dateStr, weekStart: ws, taskId, done: false });
      });

    } else if (freq === 'biweekly') {
      if (!habit.startDate) return;
      const winStart = new Date(today + 'T12:00:00');
      winStart.setDate(winStart.getDate() - 15);
      const winEnd = new Date(horizon + 'T12:00:00');
      let cur = new Date(habit.startDate + 'T12:00:00');
      while (cur < winStart) cur.setDate(cur.getDate() + 15);
      cur.setDate(cur.getDate() - 15);
      if (cur < new Date(habit.startDate + 'T12:00:00')) cur = new Date(habit.startDate + 'T12:00:00');
      while (cur <= winEnd) {
        const ds = cur.getFullYear() + '-' + pad(cur.getMonth()+1) + '-' + pad(cur.getDate());
        if (!habit.occurrences.find(o => o.date === ds)) {
          const taskId = state.nextId++;
          state.tasks.push({ id: taskId, name: habit.name, cat: habit.cat, due: ds, done: false, habitId: habit.id });
          habit.occurrences.push({ date: ds, weekStart: null, taskId, done: false });
        }
        cur.setDate(cur.getDate() + 15);
      }

    } else if (freq === 'monthly') {
      if (!habit.monthDay) return;
      const base = new Date(today + 'T12:00:00');
      for (let m = -1; m <= 3; m++) {
        const d = new Date(base.getFullYear(), base.getMonth() + m, habit.monthDay);
        if (d.getDate() !== habit.monthDay) continue;
        const ds = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
        if (!habit.occurrences.find(o => o.date === ds)) {
          const taskId = state.nextId++;
          state.tasks.push({ id: taskId, name: habit.name, cat: habit.cat, due: ds, done: false, habitId: habit.id });
          habit.occurrences.push({ date: ds, weekStart: null, taskId, done: false });
        }
      }
    }
  });

  saveState();
}


// ── 6. Render helpers ─────────────────────────────────────────────────────────

function getCat(id) {
  return state.categories.find(c => c.id === id) || { name: id, color: '#888' };
}

function hexToRgba(hex, alpha) {
  if (!hex || hex.length < 7) return `rgba(136,136,136,${alpha})`;
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}


// ── 7. Task row HTML builder ──────────────────────────────────────────────────

function taskRowHTML(task) {
  const cat   = getCat(task.cat);
  const catBg = hexToRgba(cat.color, 0.09);

  // For completed tasks, override the overdue label/class
  let dc = dueDateClass(task.due);
  let dl = dueDateLabel(task.due);
  if (task.done && dc === 'overdue') {
    const completedLate = task.completedAt && task.due && task.completedAt > task.due;
    dc = completedLate ? 'soon' : '';
    dl = completedLate ? 'con retraso' : formatDateShort(task.due);
  }
  const habit  = task.habitId ? state.habits.find(h => h.id === task.habitId) : null;

  if (task.cancelled) {
    return `
      <div class="task-row cancelled" onclick="event.stopPropagation()">
        <div class="checkbox cancelled-x">&#x2205;</div>
        <span class="task-name">${task.name}</span>
        ${task.time ? `<span class="task-time">${task.time}</span>` : ''}
        <span class="cat-badge" style="background:${catBg};color:${cat.color}">${getCat(task.cat).name}</span>
        <span class="due-date ${dc}">${dl}</span>
        <button class="reschedule-btn" onclick="restoreTask(${task.id}, event)">restaurar</button>
        <button class="delete-btn" onclick="deleteTask(${task.id}, event)">&#x2715;</button>
      </div>`;
  }

  const habitBadge = habit
    ? `<span class="habit-badge ${task.done ? 'completed' : ''}">&#x21BB; ${habit.name}</span>`
    : '';
  const rescheduleBtnHTML = !task.done
    ? `<button class="reschedule-btn" onclick="openEditTaskModal(${task.id}, event)">editar</button>
       <button class="cancel-btn" onclick="cancelTask(${task.id}, event)">cancelar</button>`
    : '';
  const timeBadge = task.time
    ? `<span class="task-time">${task.time}</span>`
    : '';

  const rowClasses = [
    'task-row',
    task.done ? 'done' : '',
    dc === 'overdue' && !task.done ? 'overdue' : '',
    task.habitId && !task.done && dc !== 'overdue' ? 'habit-linked' : '',
  ].filter(Boolean).join(' ');

  return `
    <div class="${rowClasses}" onclick="toggleTask(${task.id})">
      <div class="checkbox">
        <svg class="check-icon" width="9" height="7" viewBox="0 0 9 7" fill="none">
          <path d="M1 3.5L3.5 6L8 1" stroke="#0e0e0f" stroke-width="1.5"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <span class="task-name">${task.name}</span>
      ${habitBadge}
      ${timeBadge}
      <span class="cat-badge" style="background:${catBg};color:${cat.color}">${cat.name}</span>
      <span class="due-date ${dc}">${dl}</span>
      ${rescheduleBtnHTML}
      <button class="delete-btn" onclick="deleteTask(${task.id}, event)">&#x2715;</button>
    </div>`;
}


// ── 8. View router ────────────────────────────────────────────────────────────

function renderMain() {
  const container = document.getElementById('main');

  if (currentView === 'stats')      { container.innerHTML = buildStatsView();      return; }
  if (currentView === 'habitos')    { container.innerHTML = buildHabitsView();     return; }
  if (currentView === 'log')        { container.innerHTML = buildLogView();        return; }
  if (currentView === 'vencidas')   { container.innerHTML = buildOverdueView();    return; }
  if (currentView === 'calendario') { container.innerHTML = buildCalendarView();   return; }
  if (filterCatId)                { container.innerHTML = buildCategoryView(filterCatId); return; }

  container.innerHTML = buildTaskView();
}


// ── 9. View: Today / This week / Later ───────────────────────────────────────

function buildTaskView() {
  const VIEW_LABELS = { hoy: 'Hoy', semana: 'Esta semana', luego: 'Luego' };
  const now = new Date();
  const subtitle =
    currentView === 'hoy'    ? `${DAY_NAMES_FULL[now.getDay()]}, ${now.getDate()} de ${MONTH_NAMES[now.getMonth()]}` :
    currentView === 'semana' ? `lun ${formatDateShort(weekStart())} \u2014 dom ${formatDateShort(weekEnd())}` :
    'proximas semanas';

  let tasks = state.tasks.filter(t => taskSection(t) === currentView);
  tasks = sortTasks(tasks);

  const pending = tasks.filter(t => !t.done);
  const done    = currentView === 'hoy'
    ? sortTasks(state.tasks.filter(t => t.done && t.completedAt === todayStr()))
    : currentView === 'semana'
    ? sortTasks(state.tasks.filter(t => {
        if (!t.done) return false;
        const d = t.completedAt || t.due;
        return d && d >= weekStart() && d <= weekEnd();
      }))
    : tasks.filter(t => t.done);

  return `
    <div class="page-header">
      <div>
        <div class="page-title">${VIEW_LABELS[currentView]}</div>
        <div class="page-subtitle">${subtitle}</div>
      </div>
    </div>
    ${buildStatChips()}
    ${buildToolbar()}
    <div class="task-list">
      ${currentView === 'semana' ? buildWeekPendingGroups(pending) : (pending.length ? pending.map(taskRowHTML).join('') : '<div class="empty-state">Sin tareas pendientes &#x2713;</div>')}
      ${done.length ? `<div class="section-divider">Completadas</div>${done.map(taskRowHTML).join('')}` : ''}
    </div>
    ${buildAddForm()}`;
}

function buildWeekPendingGroups(pending) {
  if (!pending.length) return '<div class="empty-state">Sin tareas pendientes &#x2713;</div>';

  const today    = todayStr();
  const tomorrow = offsetDate(1);

  // Group by due date preserving sort order
  const groups = {};
  pending.forEach(t => {
    const key = t.due || '';
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  return Object.keys(groups).sort().map(dateStr => {
    const d   = new Date(dateStr + 'T12:00:00');
    const dow = DAY_NAMES_FULL[d.getDay()];
    const num = d.getDate();
    const prefix = dateStr === today    ? 'Hoy · '    :
                   dateStr === tomorrow ? 'Mañana · ' : '';
    const header = `${prefix}${dow} ${num}`;
    return `
      <div class="section-divider">${header}</div>
      ${groups[dateStr].map(taskRowHTML).join('')}`;
  }).join('');
}

function buildStatChips() {
  const today        = todayStr();
  const overdueCount = state.tasks.filter(t => !t.done && !t.cancelled && t.due && t.due < today).length;

  if (currentView === 'semana') {
    const ws = weekStart(), we = weekEnd();
    const allWeek      = state.tasks.filter(t => t.due && t.due >= ws && t.due <= we);
    const doneWeek     = allWeek.filter(t => t.done).length;
    const habitsWeek   = state.habits.filter(h =>
      h.occurrences.some(o => o.weekStart === ws)
    );
    const habDoneWeek  = habitsWeek.filter(h =>
      h.occurrences.some(o => o.weekStart === ws && o.done)
    ).length;

    return `
      <div class="stat-row">
        <div class="stat-chip">
          <div class="value">${doneWeek}/${allWeek.length}</div>
          <div class="label">tareas esta semana</div>
        </div>
        <div class="stat-chip">
          <div class="value">${habDoneWeek}/${habitsWeek.length}</div>
          <div class="label">rutinas esta semana</div>
        </div>
        ${overdueCount ? `
          <div class="stat-chip" style="border-color:rgba(226,75,74,.3)">
            <div class="value" style="color:var(--red)">${overdueCount}</div>
            <div class="label">vencidas</div>
          </div>` : ''}
      </div>`;
  }

  const allToday     = state.tasks.filter(t => t.due === today);
  const doneToday    = allToday.filter(t => t.done).length;
  const todayDow     = new Date().getDay();
  const habitsToday  = state.habits.filter(h => h.days.includes(todayDow));
  const habDoneToday = habitsToday.filter(h => h.occurrences.find(o => o.date === today && o.done)).length;

  return `
    <div class="stat-row">
      <div class="stat-chip">
        <div class="value">${doneToday}/${allToday.length}</div>
        <div class="label">tareas hoy</div>
      </div>
      <div class="stat-chip">
        <div class="value">${habDoneToday}/${habitsToday.length}</div>
        <div class="label">rutinas hoy</div>
      </div>
      ${overdueCount ? `
        <div class="stat-chip" style="border-color:rgba(226,75,74,.3)">
          <div class="value" style="color:var(--red)">${overdueCount}</div>
          <div class="label">vencidas</div>
        </div>` : ''}
    </div>`;
}

function buildToolbar() {
  const catPills = `
    <button class="filter-btn active">Todo</button>
    ${state.categories.map(c => `
      <button class="filter-btn" onclick="setCategoryFilter('${c.id}')">
        <span style="width:7px;height:7px;border-radius:50%;background:${c.color};display:inline-block"></span>
        ${c.name}
      </button>`).join('')}`;

  return `
    <div class="toolbar">
      <div style="display:flex;gap:6px;flex-wrap:wrap">${catPills}</div>
      <div class="spacer"></div>
      <select class="sort-select" onchange="setSortBy(this.value)">
        <option value="due"  ${sortBy==='due'  ?'selected':''}>fecha</option>
        <option value="cat"  ${sortBy==='cat'  ?'selected':''}>categoria</option>
        <option value="name" ${sortBy==='name' ?'selected':''}>nombre</option>
      </select>
    </div>`;
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    if (sortBy === 'cat')  return a.cat.localeCompare(b.cat);
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    // Default: by due date, then by time within same day
    if (a.due !== b.due) return (a.due || '9') > (b.due || '9') ? 1 : -1;
    return (a.time || '99:99') > (b.time || '99:99') ? 1 : -1;
  });
}


// ── 10. View: Category detail ─────────────────────────────────────────────────

function buildCategoryView(catId) {
  const cat   = getCat(catId);
  const today = todayStr(), endWeek = weekEnd();

  let allTasks = state.tasks.filter(t => t.cat === catId);
  allTasks = sortTasks(allTasks);

  const overdue = allTasks.filter(t => !t.done && t.due && t.due < today);
  const todayT  = allTasks.filter(t => !t.done && t.due === today);
  const weekT   = allTasks.filter(t => !t.done && t.due && t.due > today && t.due <= endWeek);
  const laterT  = allTasks.filter(t => !t.done && (!t.due || t.due > endWeek));
  const doneT   = allTasks.filter(t => t.done);
  const totalPending = allTasks.filter(t => !t.done).length;

  const section = (label, tasks) => tasks.length
    ? `<div class="cat-section-header">${label}</div>
       <div class="task-list">${tasks.map(taskRowHTML).join('')}</div>`
    : '';

  return `
    <div class="page-header">
      <div>
        <div class="page-title" style="display:flex;align-items:center;gap:10px">
          <span style="width:12px;height:12px;border-radius:50%;background:${cat.color};display:inline-block;flex-shrink:0"></span>
          ${cat.name}
        </div>
        <div class="page-subtitle">${totalPending} pendiente${totalPending !== 1 ? 's' : ''}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <select class="sort-select" onchange="setSortBy(this.value)">
          <option value="due"  ${sortBy==='due'  ?'selected':''}>fecha</option>
          <option value="name" ${sortBy==='name' ?'selected':''}>nombre</option>
        </select>
        <button class="modal-btn" onclick="setCategoryFilter(null)"
                style="font-size:12px;padding:5px 12px">&#x2190; Volver</button>
      </div>
    </div>
    ${section('Vencidas', overdue)}
    ${section('Hoy', todayT)}
    ${section('Esta semana', weekT)}
    ${section('Luego', laterT)}
    ${!overdue.length && !todayT.length && !weekT.length && !laterT.length
      ? '<div class="empty-state" style="margin-top:40px">Todo al dia en esta categoria &#x2713;</div>'
      : ''}
    ${doneT.length ? section('Completadas', doneT) : ''}
    ${buildAddForm()}`;
}


// ── 11. View: Overdue ─────────────────────────────────────────────────────────

function buildOverdueView() {
  const today = todayStr();
  const overdue    = state.tasks
    .filter(t => !t.done && !t.cancelled && t.due && t.due < today)
    .sort((a, b) => a.due > b.due ? 1 : -1);
  const cancelled  = state.tasks
    .filter(t => t.cancelled)
    .sort((a, b) => (a.due || '') > (b.due || '') ? 1 : -1);

  return `
    <div class="page-header">
      <div>
        <div class="page-title">Vencidas</div>
        <div class="page-subtitle">no completadas a tiempo</div>
      </div>
    </div>
    <div class="task-list">
      ${overdue.length
        ? overdue.map(taskRowHTML).join('')
        : '<div class="empty-state">No hay tareas vencidas &#x2713;</div>'}
      ${cancelled.length
        ? `<div class="section-divider">Canceladas</div>${cancelled.map(taskRowHTML).join('')}`
        : ''}
    </div>
    ${buildAddForm()}`;
}


// ── 12. View: Habits ──────────────────────────────────────────────────────────

function buildHabitsView() {
  const today = todayStr(), ws = weekStart();

  const cards = state.habits.map(habit => {
    const todayOcc   = habit.occurrences.find(o => o.date === today);
    const isDoneToday = !!(todayOcc && todayOcc.done);

    // 7 streak dots representing Mon→Sun of current week
    const wsDate = new Date(weekStart() + 'T12:00:00');
    const streakDots = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(wsDate);
      d.setDate(d.getDate() + i);
      const ds  = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      const dow = d.getDay();
      const isScheduled = habit.days.includes(dow);
      const occ        = habit.occurrences.find(o => o.date === ds);
      const isDone     = !!(occ && occ.done);
      const isFuture   = ds > today;
      const isToday    = ds === today;
      const linkedTask = occ ? state.tasks.find(t => t.id === occ.taskId) : null;
      const isDoneLate = isDone && linkedTask?.completedAt && linkedTask.completedAt > ds;

      let dotClass = 'streak-dot ';
      if (isDoneLate)                                dotClass += 'sd-late';
      else if (isDone)                               dotClass += 'sd-done';
      else if (isScheduled && !isFuture && !isToday) dotClass += 'sd-miss';
      else if (isFuture)                             dotClass += 'sd-future';
      else                                           dotClass += 'sd-off';

      const tooltipSuffix = isDoneLate
        ? ` recuperado el ${DAY_NAMES_SHORT[new Date(linkedTask.completedAt+'T12:00:00').getDay()]} ${formatDateShort(linkedTask.completedAt)}`
        : isDone ? ' ok' : '';
      const tooltip = `${DAY_NAMES_SHORT[dow]} ${formatDateShort(ds)}${isScheduled ? ' (prog)' : ''}${tooltipSuffix}`;
      return `<div class="${dotClass}" title="${tooltip}"></div>`;
    }).join('');

    const dayPills = DAY_NAMES_SHORT.map((name, i) =>
      `<span class="day-pill ${habit.days.includes(i) ? 'scheduled' : ''}">${name}</span>`
    ).join('');


    const freq = habit.freq || 'weekly';

    if (freq !== 'weekly') {
      // ── Non-weekly card (biweekly / monthly) ────────────────
      const sortedOccs  = [...habit.occurrences].sort((a, b) => a.date > b.date ? 1 : -1);
      const pastOccs    = sortedOccs.filter(o => o.date < today).slice(-4);
      const futureOccs  = sortedOccs.filter(o => o.date >= today).slice(0, 3);
      const nextOcc     = futureOccs[0];
      const isDoneNext  = !!(nextOcc && nextOcc.done);

      const historyDots = pastOccs.map(o => {
        const linkedTask  = state.tasks.find(t => t.id === o.taskId);
        const isDoneLate  = o.done && linkedTask && linkedTask.completedAt && linkedTask.completedAt > o.date;
        const cls = 'streak-dot ' + (isDoneLate ? 'sd-late' : o.done ? 'sd-done' : 'sd-miss');
        const tip = formatDateShort(o.date) + (o.done ? ' ok' : ' miss');
        return `<div class="${cls}" title="${tip}"></div>`;
      }).join('');

      const freqLabel = freq === 'monthly'
        ? `mensual · día ${habit.monthDay}`
        : `cada 15 días · desde ${formatDateShort(habit.startDate)}`;

      const nextLabel = !nextOcc ? '—'
        : nextOcc.date === today ? 'Hoy'
        : nextOcc.date === offsetDate(1) ? 'Mañana'
        : DAY_NAMES_FULL[new Date(nextOcc.date + 'T12:00:00').getDay()] + ' ' + formatDateShort(nextOcc.date);

      const makeOccItem = (occsToShow) => occsToShow.map(o => {
      const dc        = dueDateClass(o.date);
      const dotColor  = o.done ? 'var(--accent)' : dc === 'overdue' ? 'var(--red)' : dc === 'today' ? 'var(--amber)' : 'var(--surface3)';
      const linkedTask = state.tasks.find(t => t.id === o.taskId);
      const label     = linkedTask ? linkedTask.name : habit.name;
      const dateLabel = o.date === today ? 'Hoy' : o.date === offsetDate(1) ? 'Man' : DAY_NAMES_FULL[new Date(o.date + 'T12:00:00').getDay()].slice(0,3) + ' ' + formatDateShort(o.date);
      const dayColor  = o.done ? 'var(--text3)' : dc === 'today' ? 'var(--accent)' : dc === 'overdue' ? 'var(--red)' : 'var(--text3)';
      return `
        <div class="occurrence-item">
          <div class="occurrence-dot" style="background:${dotColor}"></div>
          <span style="flex:1">${label}</span>
          <span style="color:${dayColor}">${dateLabel}</span>
          ${o.done ? '<span style="color:var(--accent)">&#x2713;</span>' : ''}
        </div>`;
    }).join('');
      const occurrenceItems = makeOccItem(futureOccs);

      return `
        <div class="habit-card ${isDoneNext && nextOcc.date === today ? 'done-today' : ''}">
          <div class="habit-card-top">
            <span class="habit-card-name">${habit.name}</span>
            <button onclick="openEditHabitModal('${habit.id}')"
                  style="background:none;border:none;color:var(--text3);cursor:pointer;
                         font-size:13px;padding:2px 6px;border-radius:4px;transition:color .15s"
                  onmouseover="this.style.color='var(--text)'"
                  onmouseout="this.style.color='var(--text3)'">&#x270E;</button>
          </div>
          <div style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-bottom:8px">${freqLabel}</div>
          <div class="streak-row">${historyDots}</div>
          <div class="habit-card-meta">próxima: ${nextLabel}</div>
          ${occurrenceItems ? `<div class="occurrence-list">${occurrenceItems}</div>` : ''}
        </div>`;
    }

    // ── Weekly card (existing display) ───────────────────────
    const thisWeekOccs = habit.occurrences
      .filter(o => o.weekStart === ws)
      .sort((a, b) => a.date > b.date ? 1 : -1);

    const makeOccItemWeekly = (occsToShow) => occsToShow.map(o => {
      const dc        = dueDateClass(o.date);
      const dotColor  = o.done ? 'var(--accent)' : dc === 'overdue' ? 'var(--red)' : dc === 'today' ? 'var(--amber)' : 'var(--surface3)';
      const linkedTask = state.tasks.find(t => t.id === o.taskId);
      const label     = linkedTask ? linkedTask.name : habit.name;
      const dateLabel = o.date === today ? 'Hoy' : o.date === offsetDate(1) ? 'Man' : DAY_NAMES_FULL[new Date(o.date + 'T12:00:00').getDay()].slice(0,3) + ' ' + formatDateShort(o.date);
      const dayColor  = o.done ? 'var(--text3)' : dc === 'today' ? 'var(--accent)' : dc === 'overdue' ? 'var(--red)' : 'var(--text3)';
      return `
        <div class="occurrence-item">
          <div class="occurrence-dot" style="background:${dotColor}"></div>
          <span style="flex:1">${label}</span>
          <span style="color:${dayColor}">${dateLabel}</span>
          ${o.done ? '<span style="color:var(--accent)">&#x2713;</span>' : ''}
        </div>`;
    }).join('');
    const occurrenceItems = makeOccItemWeekly(thisWeekOccs);
    const doneThisWeek = thisWeekOccs.filter(o => o.done).length;

    return `
      <div class="habit-card ${isDoneToday ? 'done-today' : ''}">
        <div class="habit-card-top">
          <span class="habit-card-name">${habit.name}</span>
          <button onclick="openEditHabitModal('${habit.id}')"
                  style="background:none;border:none;color:var(--text3);cursor:pointer;
                         font-size:13px;padding:2px 6px;border-radius:4px;transition:color .15s"
                  onmouseover="this.style.color='var(--text)'"
                  onmouseout="this.style.color='var(--text3)'">&#x270E;</button>
        </div>
        <div class="habit-day-pills">${dayPills}</div>
        <div class="streak-row">${streakDots}</div>
        <div class="habit-card-meta">${doneThisWeek}/${thisWeekOccs.length} esta semana</div>
        ${occurrenceItems ? `<div class="occurrence-list">${occurrenceItems}</div>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="page-header">
      <div>
        <div class="page-title">Rutinas</div>
        <div class="page-subtitle">habitos semanales recurrentes</div>
      </div>
      <button class="add-btn" onclick="openNewHabitModal()">+ nueva rutina</button>
    </div>
    <div class="habits-grid">
      ${cards || '<div class="empty-state">No hay rutinas. Agrega una con el boton.</div>'}
    </div>`;
}


// ── 13. View: Log ─────────────────────────────────────────────────────────────

function buildLogView() {
  if (!state.log.length) return `
    <div class="page-header">
      <div><div class="page-title">Log</div><div class="page-subtitle">historial de completadas</div></div>
    </div>
    <div class="empty-state" style="margin-top:60px">Todavia no hay registros.</div>`;

  // Group entries by date, most recent first
  const grouped = {};
  [...state.log].reverse().forEach(entry => {
    const d = entry.completedAt.split('T')[0];
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(entry);
  });

  const html = Object.entries(grouped).map(([dateStr, entries]) => {
    const dt    = new Date(dateStr + 'T12:00:00');
    const label = dateStr === todayStr()
      ? 'Hoy'
      : `${DAY_NAMES_FULL[dt.getDay()]} ${dt.getDate()} de ${MONTH_NAMES[dt.getMonth()]}`;

    const items = entries.map(entry => {
      const cat  = getCat(entry.cat);
      const time = new Date(entry.completedAt).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });

      return `
        <div class="log-item">
          <div class="log-check">
            <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
              <path d="M1 3L3 5L7 1" stroke="#0e0e0f" stroke-width="1.5"
                    stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${entry.name}</span>
          <span class="cat-badge" style="background:${hexToRgba(cat.color, .09)};color:${cat.color}">${cat.name}</span>
          ${entry.habitId ? '<span style="font-size:10px;color:var(--text3);white-space:nowrap">&#x21BB; rutina</span>' : ''}
          <span class="log-time">${time}</span>
        </div>`;
    }).join('');

    return `<div class="log-group"><div class="log-date-header">${label}</div>${items}</div>`;
  }).join('');

  return `
    <div class="page-header">
      <div>
        <div class="page-title">Log</div>
        <div class="page-subtitle">${state.log.length} completadas en total</div>
      </div>
      <button class="modal-btn danger" onclick="clearLog()"
              style="font-size:12px;padding:6px 12px">Limpiar log</button>
    </div>
    ${html}`;
}


// ── 14. View: Analytics ───────────────────────────────────────────────────────

function changeStatsMonth(delta) {
  statsMonth += delta;
  if (statsMonth > 11) { statsMonth = 0;  statsYear++; }
  if (statsMonth < 0)  { statsMonth = 11; statsYear--; }
  render();
}

function buildStatsView() {
  const mn = statsMonth, yr = statsYear;
  const now = new Date();
  const isCurrentMonth = mn === now.getMonth() && yr === now.getFullYear();
  const daysInMonth    = new Date(yr, mn + 1, 0).getDate();
  const monthPrefix    = `${yr}-${String(mn+1).padStart(2,'0')}`;

  // Log entries for this month
  const monthLog  = state.log.filter(e => e.completedAt.startsWith(monthPrefix));
  const habitLog  = monthLog.filter(e =>  e.habitId);
  const taskLog   = monthLog.filter(e => !e.habitId);

  // Non-habit tasks due this month
  const doneTasksMonth  = state.tasks.filter(t => !t.habitId && t.done && t.due && t.due.startsWith(monthPrefix)).length;
  const totalTasksMonth = state.tasks.filter(t => !t.habitId && t.due && t.due.startsWith(monthPrefix)).length;

  // Per-habit compliance stats
  const habitStats = state.habits.map(habit => {
    const cat        = getCat(habit.cat);
    const occsMonth  = habit.occurrences.filter(o => o.date.startsWith(monthPrefix));
    const scheduled  = occsMonth.length;
    const completed  = occsMonth.filter(o => o.done).length;
    const pct        = scheduled > 0 ? Math.round(completed / scheduled * 100) : 0;

    const last8 = occsMonth.slice(-8);
    const miniDots = last8.map(o =>
      `<div class="mini-streak-dot" style="background:${o.done ? cat.color : 'var(--surface3)'}"></div>`
    ).join('');

    return { habit, cat, scheduled, completed, pct, miniDots };
  });

  // Daily completion counts
  const byDay = {};
  monthLog.forEach(e => {
    const d = parseInt(e.completedAt.split('T')[0].split('-')[2]);
    byDay[d] = (byDay[d] || 0) + 1;
  });
  const maxDayCount = Math.max(1, ...Object.values(byDay));

  // Bar chart grouped by week
  const firstDow   = new Date(yr, mn, 1).getDay();
  const startOffset = firstDow === 0 ? 6 : firstDow - 1;
  const weeks      = Math.ceil((startOffset + daysInMonth) / 7);
  const weekBars   = Array.from({ length: weeks }, (_, w) => {
    let total = 0;
    for (let d = 0; d < 7; d++) {
      const dayNum = w * 7 + d - startOffset + 1;
      if (dayNum >= 1 && dayNum <= daysInMonth) total += byDay[dayNum] || 0;
    }
    return { label: `S${w+1}`, val: total };
  });
  const maxBarVal = Math.max(1, ...weekBars.map(b => b.val));

  const barChartHTML = weekBars.map(bar => {
    const h   = Math.round((bar.val / maxBarVal) * 100);
    const col = bar.val > 0 ? 'var(--accent)' : 'var(--surface3)';
    return `
      <div class="bar-col">
        <div style="flex:1;display:flex;align-items:flex-end;width:100%">
          <div class="bar-col-inner" style="background:${col};height:${h}%"></div>
        </div>
        <div class="bar-label">${bar.label}</div>
      </div>`;
  }).join('');

  // Heatmap grid
  const hmDayLabels = ['L','M','X','J','V','S','D'];
  const hmCells = [
    ...hmDayLabels.map(d => `<div class="heatmap-day-label">${d}</div>`),
    ...Array.from({ length: startOffset }, () => '<div></div>'),
    ...Array.from({ length: daysInMonth }, (_, i) => {
      const day     = i + 1;
      const dateStr = `${yr}-${String(mn+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const cnt     = byDay[day] || 0;
      const future  = dateStr > todayStr();
      let bg;
      if      (future)  bg = 'var(--surface2)';
      else if (cnt === 0) bg = 'var(--surface3)';
      else              bg = `rgba(200,240,96,${Math.min(0.3 + cnt * 0.2, 1).toFixed(2)})`;
      const title = future ? `${day} — futuro` : `${day} — ${cnt} completada${cnt !== 1 ? 's' : ''}`;
      return `<div class="heatmap-cell" style="background:${bg}" title="${title}"></div>`;
    }),
  ];

  // Category breakdown bars
  const catBreakdown = state.categories
    .map(c => ({ c, cnt: monthLog.filter(e => e.cat === c.id).length }))
    .filter(x => x.cnt > 0)
    .sort((a, b) => b.cnt - a.cnt);
  const maxCatCount = Math.max(1, ...catBreakdown.map(x => x.cnt));

  const catBarsHTML = catBreakdown.length
    ? catBreakdown.map(x => `
        <div style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
            <span style="display:flex;align-items:center;gap:6px">
              <span style="width:7px;height:7px;border-radius:50%;background:${x.c.color};display:inline-block"></span>
              <span style="color:var(--text2)">${x.c.name}</span>
            </span>
            <span style="font-family:var(--mono);color:var(--text3)">${x.cnt}</span>
          </div>
          <div class="progress-bar-track">
            <div class="progress-bar-fill" style="width:${Math.round(x.cnt/maxCatCount*100)}%;background:${x.c.color}"></div>
          </div>
        </div>`).join('')
    : '<div style="color:var(--text3);font-size:12px">Sin datos este mes</div>';

  // Habit table rows
  const tableRowsHTML = habitStats.length
    ? habitStats.map(r => `
        <tr>
          <td><span style="display:flex;align-items:center;gap:7px">
            <span style="width:7px;height:7px;border-radius:50%;background:${r.cat.color};
                         display:inline-block;flex-shrink:0"></span>
            <span style="color:var(--text)">${r.habit.name}</span>
          </span></td>
          <td>${r.completed}/${r.scheduled}</td>
          <td>
            <div style="display:flex;align-items:center;gap:6px;justify-content:flex-end">
              <div style="width:50px;height:3px;background:var(--surface3);border-radius:2px;overflow:hidden">
                <div style="height:100%;width:${r.pct}%;background:${r.cat.color};border-radius:2px"></div>
              </div>
              <span>${r.pct}%</span>
            </div>
          </td>
          <td><div class="mini-streak-bar">${r.miniDots}</div></td>
        </tr>`).join('')
    : `<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:20px 0">
         Sin rutinas configuradas</td></tr>`;

  const totalCompleted = monthLog.length;
  const bestDay    = Object.entries(byDay).sort((a,b) => b[1]-a[1])[0];
  const activeDays = Object.keys(byDay).length;
  const taskPct    = totalTasksMonth > 0 ? Math.round(doneTasksMonth/totalTasksMonth*100) : 0;
  const elapsed    = isCurrentMonth ? now.getDate() : daysInMonth;

  return `
    <div class="page-header">
      <div>
        <div class="page-title">Resumen</div>
        <div class="page-subtitle">analisis de actividad mensual</div>
      </div>
      <div class="month-nav">
        <button class="month-nav-btn" onclick="changeStatsMonth(-1)">&#x2190;</button>
        <span class="month-label-display">${MONTH_NAMES_CAPITALIZED[mn]} ${yr}</span>
        <button class="month-nav-btn" onclick="changeStatsMonth(1)"
                ${isCurrentMonth ? 'disabled' : ''}>&#x2192;</button>
      </div>
    </div>

    <div class="analytics-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:20px">
      <div class="analytics-card">
        <div class="analytics-card-title">Completadas</div>
        <div class="analytics-big-number">${totalCompleted}</div>
        <div class="analytics-sub">${habitLog.length} rutinas &middot; ${taskLog.length} tareas</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-title">Dias activos</div>
        <div class="analytics-big-number">${activeDays}</div>
        <div class="analytics-sub">de ${elapsed} dias transcurridos</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-title">Mejor dia</div>
        <div class="analytics-big-number">${bestDay ? bestDay[1] : 0}</div>
        <div class="analytics-sub">${bestDay ? `dia ${bestDay[0]} del mes` : 'sin actividad'}</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-title">Tareas no rutina</div>
        <div class="analytics-big-number">${doneTasksMonth}/${totalTasksMonth}</div>
        <div class="analytics-sub">${taskPct}% completadas
          <div class="progress-bar-track" style="margin-top:6px">
            <div class="progress-bar-fill" style="width:${taskPct}%"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="analytics-grid" style="grid-template-columns:1fr 1fr;margin-bottom:20px">
      <div class="analytics-card">
        <div class="analytics-card-title">Actividad por semana</div>
        <div class="bar-chart">${barChartHTML}</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-title">Heatmap del mes</div>
        <div class="heatmap" style="grid-template-columns:repeat(7,1fr)">${hmCells.join('')}</div>
      </div>
    </div>

    <div class="analytics-grid" style="grid-template-columns:1fr 1.6fr">
      <div class="analytics-card">
        <div class="analytics-card-title">Por categoria</div>
        ${catBarsHTML}
      </div>
      <div class="analytics-card">
        <div class="analytics-card-title">Rutinas &mdash; cumplimiento mensual</div>
        <table class="habits-table">
          <thead><tr>
            <th>Rutina</th><th>Sesiones</th><th>Cumplimiento</th><th>Historial</th>
          </tr></thead>
          <tbody>${tableRowsHTML}</tbody>
        </table>
      </div>
    </div>`;
}


// ── 15. Add-task form HTML ────────────────────────────────────────────────────

function buildAddForm() {
  const defaultDate =
    filterCatId            ? '' :
    currentView === 'hoy'  ? todayStr() :
    currentView === 'semana' ? offsetDate(2) : '';

  return `
    <div class="add-form" id="add-form">
      <div class="add-row">
        <input class="add-input" id="new-task-input"
               placeholder="Nueva tarea..."
               onkeydown="if(event.key==='Enter') addTask()"
               onfocus="document.getElementById('add-form').classList.add('focused')"
               onblur="document.getElementById('add-form').classList.remove('focused')">
      </div>
      <div class="add-row">
        <select class="add-select" id="new-task-cat" style="transition:border .3s">
          <option value="" disabled selected>Categoria...</option>
          ${state.categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
        </select>
        <input type="date" class="add-date" id="new-task-due" value="${defaultDate}">
        <label class="add-time-wrap">
          <span class="add-time-icon">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2"/>
              <path d="M6 3.5V6l1.5 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
          </span>
          <input type="time" class="add-time" id="new-task-time">
        </label>
        <div style="flex:1"></div>
        <button class="add-btn" onclick="addTask()">+ Agregar</button>
      </div>
    </div>`;
}


// ── 16. Task actions ──────────────────────────────────────────────────────────

function toggleTask(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  task.done = !task.done;

  if (task.done) {
    task.completedAt = todayStr();
    // Add to log
    state.log.push({
      id: state.nextId++,
      name: task.name,
      cat: task.cat,
      completedAt: new Date().toISOString(),
      habitId: task.habitId || null,
    });
    // Mark habit occurrence as done
    if (task.habitId) {
      const habit = state.habits.find(h => h.id === task.habitId);
      if (habit) {
        const occ = habit.occurrences.find(o => o.taskId === taskId);
        if (occ) occ.done = true;
      }
    }
  } else {
    task.completedAt = null;
    // Undo: remove most recent log entry for this task
    for (let i = state.log.length - 1; i >= 0; i--) {
      if (state.log[i].name === task.name) { state.log.splice(i, 1); break; }
    }
    if (task.habitId) {
      const habit = state.habits.find(h => h.id === task.habitId);
      if (habit) {
        const occ = habit.occurrences.find(o => o.taskId === taskId);
        if (occ) occ.done = false;
      }
    }
  }

  saveState();
  render();
}

function cancelTask(taskId, event) {
  event.stopPropagation();
  const task = state.tasks.find(t => t.id === taskId);
  if (task) { task.cancelled = true; saveState(); render(); }
}

function restoreTask(taskId, event) {
  event.stopPropagation();
  const task = state.tasks.find(t => t.id === taskId);
  if (task) { task.cancelled = false; saveState(); render(); }
}

function deleteTask(taskId, event) {
  event.stopPropagation();
  const task = state.tasks.find(t => t.id === taskId);
  if (task && task.habitId) {
    const habit = state.habits.find(h => h.id === task.habitId);
    if (habit) habit.occurrences = habit.occurrences.filter(o => o.taskId !== taskId);
  }
  state.tasks = state.tasks.filter(t => t.id !== taskId);
  saveState();
  render();
}

function addTask() {
  const nameInput = document.getElementById('new-task-input');
  const name = (nameInput?.value || '').trim();
  if (!name) return;

  const catEl = document.getElementById('new-task-cat');
  const cat   = catEl?.value;

  // Require category selection
  if (!cat) {
    catEl.style.borderColor   = 'var(--red)';
    catEl.style.boxShadow = '0 0 0 1px var(--red)';
    catEl.focus();
    setTimeout(() => { catEl.style.borderColor = ''; catEl.style.boxShadow = ''; }, 1800);
    return;
  }

  const due  = document.getElementById('new-task-due')?.value  || todayStr();
  const time = document.getElementById('new-task-time')?.value || '';

  state.tasks.push({ id: state.nextId++, name, cat, due, time, done: false });
  nameInput.value = '';
  const timeEl = document.getElementById('new-task-time');
  if (timeEl) timeEl.value = '';

  saveState();
  render();
}


// ── 17. Edit task modal ───────────────────────────────────────────────────────

function openEditTaskModal(taskId, event) {
  event.stopPropagation();
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  reschedulingTaskId = taskId;

  document.getElementById('edit-task-name').value = task.name;
  document.getElementById('edit-task-due').value  = task.due  || todayStr();
  document.getElementById('edit-task-time').value = task.time || '';

  const catSelect = document.getElementById('edit-task-cat');
  catSelect.innerHTML = state.categories
    .map(c => `<option value="${c.id}"${c.id === task.cat ? ' selected' : ''}>${c.name}</option>`)
    .join('');

  const note = document.getElementById('edit-task-habit-note');
  note.style.display = task.habitId ? '' : 'none';

  document.getElementById('edit-task-modal').classList.add('open');
}

function confirmEditTask() {
  const task = state.tasks.find(t => t.id === reschedulingTaskId);
  if (task) {
    const newName = document.getElementById('edit-task-name').value.trim();
    if (newName) task.name = newName;
    task.cat  = document.getElementById('edit-task-cat').value;
    task.due  = document.getElementById('edit-task-due').value;
    task.time = document.getElementById('edit-task-time').value || '';
    if (task.habitId) {
      const habit = state.habits.find(h => h.id === task.habitId);
      if (habit) {
        const occ = habit.occurrences.find(o => o.taskId === task.id);
        if (occ) occ.date = task.due;
      }
    }
  }
  closeModal('edit-task-modal');
  saveState();
  render();
}


// ── 18. Habit CRUD ────────────────────────────────────────────────────────────

function openNewHabitModal() {
  editingHabitId   = null;
  pendingHabitDays = [];
  pendingDayLabels = {};
  pendingHabitFreq = 'weekly';

  document.getElementById('habit-modal-title').textContent    = 'Nueva rutina';
  document.getElementById('habit-name-input').value           = '';
  document.getElementById('habit-delete-btn').style.display   = 'none';
  document.getElementById('habit-freq-select').value          = 'weekly';
  document.getElementById('habit-start-date').value           = todayStr();

  populateHabitCatSelect(null);
  refreshHabitFreqUI();
  refreshDayToggleButtons();
  document.getElementById('habit-modal').classList.add('open');
}

function openEditHabitModal(habitId) {
  const habit = state.habits.find(h => h.id === habitId);
  if (!habit) return;

  editingHabitId   = habitId;
  pendingHabitDays = [...(habit.days || [])];
  pendingDayLabels = Object.assign({}, habit.dayLabels || {});
  pendingHabitFreq = habit.freq || 'weekly';

  document.getElementById('habit-modal-title').textContent   = 'Editar rutina';
  document.getElementById('habit-name-input').value          = habit.name;
  document.getElementById('habit-delete-btn').style.display  = '';
  document.getElementById('habit-freq-select').value         = pendingHabitFreq;
  document.getElementById('habit-month-day').value           = habit.monthDay || '';
  document.getElementById('habit-start-date').value          = habit.startDate || '';

  populateHabitCatSelect(habit.cat);
  refreshHabitFreqUI();
  refreshDayToggleButtons();
  renderDayLabelInputs();
  document.getElementById('habit-modal').classList.add('open');
}

function populateHabitCatSelect(selectedId) {
  document.getElementById('habit-cat-select').innerHTML = state.categories
    .map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${c.name}</option>`)
    .join('');
}

function refreshHabitFreqUI() {
  const freq = document.getElementById('habit-freq-select').value;
  pendingHabitFreq = freq;
  document.getElementById('habit-weekly-fields').style.display  = freq === 'weekly'   ? '' : 'none';
  document.getElementById('habit-monthly-field').style.display  = freq === 'monthly'  ? '' : 'none';
  document.getElementById('habit-biweekly-field').style.display = freq === 'biweekly' ? '' : 'none';
  if (freq !== 'weekly') {
    document.getElementById('day-labels-section').style.display = 'none';
  }
}

function refreshHabitFreqUI() {
  const freq = document.getElementById('habit-freq-select').value;
  pendingHabitFreq = freq;
  document.getElementById('habit-weekly-fields').style.display  = freq === 'weekly'   ? '' : 'none';
  document.getElementById('habit-monthly-field').style.display  = freq === 'monthly'  ? '' : 'none';
  document.getElementById('habit-biweekly-field').style.display = freq === 'biweekly' ? '' : 'none';
  if (freq !== 'weekly') {
    document.getElementById('day-labels-section').style.display = 'none';
  }
}

function refreshDayToggleButtons() {
  document.querySelectorAll('#habit-day-toggles .day-toggle-btn').forEach(btn => {
    const dow = parseInt(btn.dataset.d);
    btn.className = 'day-toggle-btn' + (pendingHabitDays.includes(dow) ? ' active' : '');
    btn.onclick = () => {
      if (pendingHabitDays.includes(dow)) pendingHabitDays = pendingHabitDays.filter(d => d !== dow);
      else pendingHabitDays.push(dow);
      refreshDayToggleButtons();
      renderDayLabelInputs();
    };
  });
}

function renderDayLabelInputs() {
  const section   = document.getElementById('day-labels-section');
  const container = document.getElementById('day-labels-container');

  if (!pendingHabitDays.length) {
    section.style.display   = 'none';
    container.innerHTML     = '';
    return;
  }

  section.style.display = '';
  const sortedDays = [...pendingHabitDays].sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b));

  container.innerHTML = sortedDays.map(dow => {
    const dayName = DAY_NAMES_SHORT[dow];
    const value   = (pendingDayLabels[String(dow)] || '').replace(/"/g, '&quot;');
    return `
      <div class="day-label-row">
        <span class="day-label-pill">${dayName}</span>
        <input class="day-label-input"
               placeholder="ej: Push, Pull, Funcional"
               value="${value}"
               oninput="pendingDayLabels['${dow}']=this.value.trim()">
      </div>`;
  }).join('');
}

function saveHabit() {
  const name = document.getElementById('habit-name-input').value.trim();
  if (!name) { alert('Ingresa un nombre.'); return; }

  const freq      = document.getElementById('habit-freq-select').value;
  const monthDay  = freq === 'monthly'  ? parseInt(document.getElementById('habit-month-day').value) || null : null;
  const startDate = freq === 'biweekly' ? document.getElementById('habit-start-date').value || null           : null;

  if (freq === 'weekly'   && !pendingHabitDays.length) { alert('Selecciona al menos un dia.'); return; }
  if (freq === 'monthly'  && !monthDay)                { alert('Ingresa el dia del mes.'); return; }
  if (freq === 'biweekly' && !startDate)               { alert('Ingresa la fecha de inicio.'); return; }

  const cat = document.getElementById('habit-cat-select').value;

  // Collect any label edits directly from inputs (in case oninput didn't fire)
  document.querySelectorAll('#day-labels-container .day-label-input').forEach(inp => {
    const pillText = inp.closest('.day-label-row').querySelector('.day-label-pill').textContent.trim();
    const dow      = DAY_NAMES_SHORT.indexOf(pillText);
    if (dow >= 0) pendingDayLabels[String(dow)] = inp.value.trim();
  });

  if (editingHabitId) {
    const habit = state.habits.find(h => h.id === editingHabitId);
    habit.name      = name;
    habit.cat       = cat;
    habit.freq      = freq;
    habit.monthDay  = monthDay;
    habit.startDate = startDate;
    habit.dayLabels = freq === 'weekly' ? pendingDayLabels : {};

    // Sync category and name to all linked tasks
    habit.occurrences.forEach(occ => {
      const t = state.tasks.find(t => t.id === occ.taskId);
      if (!t) return;
      t.cat = cat;
      if (freq === 'weekly') {
        const dow = new Date(t.due + 'T12:00:00').getDay();
        const label = pendingDayLabels[String(dow)];
        t.name = label ? name + ' — ' + label : name;
      } else {
        t.name = name;
      }
    });

    const today = todayStr();
    if (freq === 'weekly') {
      const removedDays = (habit.days || []).filter(d => !pendingHabitDays.includes(d));
      removedDays.forEach(removedDow => {
        habit.occurrences = habit.occurrences.filter(occ => {
          if (occ.date >= today && !occ.done && new Date(occ.date + 'T12:00:00').getDay() === removedDow) {
            state.tasks = state.tasks.filter(t => t.id !== occ.taskId);
            return false;
          }
          return true;
        });
      });
      habit.days = pendingHabitDays;
    } else {
      // Remove future undone occurrences so ensureWeeklyOccurrences regenerates correctly
      habit.occurrences = habit.occurrences.filter(occ => {
        if (occ.date >= today && !occ.done) {
          state.tasks = state.tasks.filter(t => t.id !== occ.taskId);
          return false;
        }
        return true;
      });
      habit.days = [];
    }
  } else {
    state.habits.push({
      id: 'hb' + state.nextId++,
      name, cat, freq,
      dayLabels: freq === 'weekly' ? pendingDayLabels : {},
      days: freq === 'weekly' ? pendingHabitDays : [],
      monthDay, startDate,
      occurrences: [],
    });
  }

  closeModal('habit-modal');
  ensureWeeklyOccurrences();
  saveState();
  render();
}

function deleteHabit() {
  if (!confirm('Eliminar esta rutina y sus tareas futuras?')) return;
  const habit = state.habits.find(h => h.id === editingHabitId);
  if (habit) {
    const today = todayStr();
    habit.occurrences
      .filter(o => o.date >= today)
      .forEach(o => { state.tasks = state.tasks.filter(t => t.id !== o.taskId); });
    state.habits = state.habits.filter(h => h.id !== editingHabitId);
  }
  closeModal('habit-modal');
  saveState();
  render();
}


// ── 19. Category CRUD ─────────────────────────────────────────────────────────

function openCatModal() {
  renderCatModalList();
  renderColorSwatches();
  document.getElementById('cat-modal').classList.add('open');
}

function renderCatModalList() {
  document.getElementById('cat-modal-list').innerHTML = state.categories.map(c => `
    <div class="cat-list-item" id="catli-${c.id}">
      <div style="width:20px;height:20px;border-radius:50%;background:${c.color};cursor:pointer;
                  flex-shrink:0;border:2px solid transparent;transition:border .15s"
           onmouseover="this.style.borderColor='var(--text2)'"
           onmouseout="this.style.borderColor='transparent'"
           onclick="openCatColorPicker('${c.id}')"
           title="Cambiar color"></div>
      <input class="cat-name-input"
             value="${c.name.replace(/"/g, '&quot;')}"
             onchange="renameCat('${c.id}', this.value)"
             title="Editar nombre">
      <button class="modal-btn danger" style="padding:3px 8px;font-size:11px;flex-shrink:0"
              onclick="deleteCat('${c.id}')">&#x2715;</button>
    </div>`).join('');
}

function openCatColorPicker(catId) {
  document.getElementById('cat-color-picker-inline')?.remove();
  const li  = document.getElementById('catli-' + catId);
  const row = document.createElement('div');
  row.id    = 'cat-color-picker-inline';
  row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding:6px 0 2px 28px';
  row.innerHTML = COLOR_PALETTE.map(c => {
    const selected = state.categories.find(x => x.id === catId)?.color === c ? ' selected' : '';
    return `<div class="color-swatch${selected}" style="background:${c}"
                 onclick="applyCatColor('${catId}','${c}')"></div>`;
  }).join('');
  li.insertAdjacentElement('afterend', row);
}

function applyCatColor(catId, color) {
  const cat = state.categories.find(c => c.id === catId);
  if (cat) { cat.color = color; saveState(); renderCatModalList(); render(); }
  document.getElementById('cat-color-picker-inline')?.remove();
}

function renameCat(catId, newName) {
  const cat = state.categories.find(c => c.id === catId);
  if (cat && newName.trim()) { cat.name = newName.trim(); saveState(); render(); }
}

function renderColorSwatches() {
  document.getElementById('new-cat-color-picker').innerHTML = COLOR_PALETTE.map(c =>
    `<div class="color-swatch${state.selColor === c ? ' selected' : ''}"
          style="background:${c}"
          onclick="selectNewCatColor('${c}')"></div>`
  ).join('');
}

function selectNewCatColor(color) { state.selColor = color; renderColorSwatches(); }

function addCategory() {
  const name = document.getElementById('new-cat-name').value.trim();
  if (!name) return;
  const id = name.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'') + '_' + Date.now();
  state.categories.push({ id, name, color: state.selColor });
  document.getElementById('new-cat-name').value = '';
  saveState(); renderCatModalList(); render();
}

function deleteCat(catId) {
  if (state.tasks.some(t => t.cat === catId) && !confirm('Hay tareas con esta categoria. Eliminar igual?')) return;
  state.categories = state.categories.filter(c => c.id !== catId);
  state.tasks = state.tasks.map(t =>
    t.cat === catId ? Object.assign({}, t, { cat: state.categories[0]?.id || '' }) : t
  );
  saveState(); renderCatModalList(); render();
}


// ── 20. Calendar view ─────────────────────────────────────────────────────────

function changeCalendarMonth(delta) {
  calendarMonth += delta;
  if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
  if (calendarMonth < 0)  { calendarMonth = 11; calendarYear--; }
  calendarSelectedDay = null;
  render();
}

function calendarGoToToday() {
  calendarMonth = new Date().getMonth();
  calendarYear  = new Date().getFullYear();
  calendarSelectedDay = todayStr();
  render();
}

function calendarSelectDay(dateStr) {
  calendarSelectedDay = calendarSelectedDay === dateStr ? null : dateStr;
  render();
}

function buildCalendarView() {
  const today = todayStr();
  const yr = calendarYear, mn = calendarMonth;

  const firstDay   = new Date(yr, mn, 1);
  const startDow   = firstDay.getDay();
  const backDays   = startDow === 0 ? 6 : startDow - 1;
  const gridStart  = new Date(firstDay);
  gridStart.setDate(gridStart.getDate() - backDays);

  const dayCells = [];
  const cursor = new Date(gridStart);
  for (let i = 0; i < 42; i++) {
    dayCells.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  const headerCells = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom']
    .map(d => `<div class="cal-header-cell">${d}</div>`).join('');

  const cells = dayCells.map(d => {
    const ds      = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const isToday    = ds === today;
    const isOther    = d.getMonth() !== mn;
    const isSelected = ds === calendarSelectedDay;

    const tasks   = state.tasks.filter(t => t.due === ds);
    const shown   = tasks.slice(0, 3);
    const extra   = tasks.length - shown.length;

    const pills = shown.map(t => {
      const cat = getCat(t.cat);
      return `<div class="cal-task-pill${t.done ? ' done' : ''}"
        style="background:${hexToRgba(cat.color, .18)};color:${cat.color}">
        <span class="cal-pill-name">${t.name}</span>${t.time ? `<span class="cal-pill-time">${t.time}</span>` : ''}
      </div>`;
    }).join('');

    const extraBadge = extra > 0
      ? `<div class="cal-extra">+${extra} más</div>`
      : '';

    const cls = ['cal-day',
      isToday    ? 'today'       : '',
      isOther    ? 'other-month' : '',
      isSelected ? 'selected'    : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${cls}" onclick="calendarSelectDay('${ds}')">
        <div class="cal-day-num">${d.getDate()}</div>
        <div class="cal-tasks">${pills}${extraBadge}</div>
      </div>`;
  }).join('');

  let dayPanel = '';
  if (calendarSelectedDay) {
    const selDate  = new Date(calendarSelectedDay + 'T12:00:00');
    const selLabel = `${DAY_NAMES_FULL[selDate.getDay()]} ${selDate.getDate()} de ${MONTH_NAMES[selDate.getMonth()]}`;
    const selTasks = sortTasks(state.tasks.filter(t => t.due === calendarSelectedDay));
    const pending  = selTasks.filter(t => !t.done);
    const done     = selTasks.filter(t =>  t.done);

    dayPanel = `
      <div class="cal-day-panel">
        <div class="cal-day-panel-title">${selLabel}</div>
        <div class="task-list">
          ${pending.length
            ? pending.map(taskRowHTML).join('')
            : '<div class="empty-state" style="padding:16px 0;font-size:13px">Sin tareas pendientes</div>'}
          ${done.length
            ? `<div class="section-divider">Completadas</div>${done.map(taskRowHTML).join('')}`
            : ''}
        </div>
      </div>`;
  }

  return `
    <div class="page-header">
      <div>
        <div class="page-title">Calendario</div>
        <div class="page-subtitle" style="font-family:var(--mono)">${MONTH_NAMES[mn]} ${yr}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="modal-btn" onclick="changeCalendarMonth(-1)" style="padding:5px 10px">&#x2190;</button>
        <button class="modal-btn" onclick="calendarGoToToday()" style="padding:5px 12px;font-size:12px">hoy</button>
        <button class="modal-btn" onclick="changeCalendarMonth(1)"  style="padding:5px 10px">&#x2192;</button>
      </div>
    </div>
    <div class="cal-grid-header">${headerCells}</div>
    <div class="cal-grid">${cells}</div>
    ${dayPanel}`;
}


// ── 21. Navigation & sidebar ──────────────────────────────────────────────────

function setView(viewName) {
  currentView = viewName;
  filterCatId = null;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('nav-' + viewName)?.classList.add('active');
  closeSidebar();
  render();
}

function setCategoryFilter(catId) {
  filterCatId = catId;
  if (!catId) { render(); return; }
  // Stay on current task view (not habits/log)
  if (['habitos', 'log', 'stats', 'calendario'].includes(currentView)) currentView = 'hoy';
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('nav-' + currentView)?.classList.add('active');
  render();
}

function setSortBy(value) { sortBy = value; render(); }

function clearLog() {
  if (confirm('Limpiar todo el log?')) { state.log = []; saveState(); render(); }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('open');
  document.getElementById('cat-color-picker-inline')?.remove();
}

function renderCatNavItems() {
  document.getElementById('cat-nav-list').innerHTML = state.categories.map(c => {
    const pendingCount = state.tasks.filter(t => !t.done && t.cat === c.id).length;
    return `
      <button class="nav-item${filterCatId === c.id ? ' active' : ''}"
              onclick="setCategoryFilter('${c.id}')">
        <span class="nav-dot" style="background:${c.color}"></span>
        ${c.name}
        <span class="count">${pendingCount}</span>
      </button>`;
  }).join('');
}

function renderNavCounts() {
  const today   = todayStr(), endWeek = weekEnd();
  document.getElementById('cnt-hoy').textContent =
    state.tasks.filter(t => !t.done && t.due && t.due <= today).length;
  document.getElementById('cnt-semana').textContent =
    state.tasks.filter(t => !t.done && t.due && t.due > today && t.due <= endWeek).length;
  document.getElementById('cnt-luego').textContent =
    state.tasks.filter(t => !t.done && (!t.due || t.due > endWeek)).length;

  const overdueCount = state.tasks.filter(t => !t.done && !t.cancelled && t.due && t.due < today).length;
  const ovEl = document.getElementById('cnt-vencidas');
  ovEl.textContent  = overdueCount || '';
  ovEl.className    = 'count' + (overdueCount ? ' red' : '');
}


// ── 21. Boot ──────────────────────────────────────────────────────────────────

function render() {
  renderNavCounts();
  renderCatNavItems();
  renderMain();
}

// Close any modal by clicking its backdrop
document.querySelectorAll('.modal-backdrop').forEach(el =>
  el.addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('open');
  })
);

function openSidebar()  { document.getElementById('sidebar').classList.add('open');  document.getElementById('sidebar-overlay').classList.add('open'); }
function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('sidebar-overlay').classList.remove('open'); }

// Arranque: primero Firebase (detecta config), luego carga datos, luego pinta
initFirebase();
loadState().then(() => render());
