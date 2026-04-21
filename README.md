# Taskboard

Personal task manager + habit tracker con análisis mensual.
Vanilla HTML/CSS/JS — sin dependencias, corre directo en el browser como archivo local.

---

## Estructura del proyecto

```
taskboard/
├── index.html    — Shell HTML: layout, sidebar, modals (sin lógica)
├── styles.css    — Todos los estilos, organizados por sección
├── app.js        — Toda la lógica JS, organizada por sección
└── README.md     — Este archivo
```

### Secciones de app.js

| # | Sección | Qué hace |
|---|---------|----------|
| 1 | Constants | Paleta de colores, nombres de días/meses, storage key |
| 2 | State & persistence | Objeto `state`, `saveState()`, `loadState()` |
| 3 | Seed data | Datos de ejemplo para primera apertura |
| 4 | Date utilities | `todayStr()`, `weekStart()`, `dueDateLabel()`, etc. |
| 5 | Occurrence generation | Crea tareas vinculadas a rutinas cada semana |
| 6 | Render helpers | `getCat()`, `hexToRgba()` |
| 7 | Task row HTML | `taskRowHTML()` — genera el HTML de una fila de tarea |
| 8 | View router | `renderMain()` — despacha a la vista correcta |
| 9 | View: Tasks | `buildTaskView()`, `buildStatChips()`, `buildToolbar()` |
| 10 | View: Category | `buildCategoryView()` — tareas de una categoría por sección |
| 11 | View: Overdue | `buildOverdueView()` |
| 12 | View: Habits | `buildHabitsView()` — cards con streak dots |
| 13 | View: Log | `buildLogView()` — historial agrupado por día |
| 14 | View: Analytics | `buildStatsView()`, `changeStatsMonth()` |
| 15 | Add-task form | `buildAddForm()` — HTML del formulario de agregar |
| 16 | Task actions | `toggleTask()`, `deleteTask()`, `addTask()` |
| 17 | Reschedule modal | `openRescheduleModal()`, `confirmReschedule()` |
| 18 | Habit CRUD | `openNewHabitModal()`, `saveHabit()`, `deleteHabit()` |
| 19 | Category CRUD | `openCatModal()`, `addCategory()`, `deleteCat()` |
| 20 | Navigation | `setView()`, `setCategoryFilter()`, `renderNavCounts()` |
| 21 | Boot | `render()`, event listeners, `loadState()` |

---

## Data model

```js
state = {
  tasks: [
    {
      id: Number,
      name: String,
      cat: String,          // category id
      due: String,          // "YYYY-MM-DD"
      time: String,         // "HH:MM" — optional
      done: Boolean,
      habitId: String|null, // linked habit id — optional
    }
  ],
  habits: [
    {
      id: String,
      name: String,
      cat: String,
      days: Number[],       // 0=Sun, 1=Mon … 6=Sat
      dayLabels: {          // optional label per day-of-week
        "1": "Push",
        "3": "Pull",
        "5": "Funcional"
      },
      occurrences: [
        {
          date: String,     // "YYYY-MM-DD"
          weekStart: String,// ISO date of that week's Monday
          taskId: Number,   // linked task id
          done: Boolean,
        }
      ]
    }
  ],
  categories: [
    { id: String, name: String, color: String }
  ],
  log: [
    {
      id: Number,
      name: String,
      cat: String,
      completedAt: String,  // ISO 8601
      habitId: String|null,
    }
  ],
  nextId: Number,
  selColor: String,
}
```

Data persists in `localStorage` under key `tb_v3`.

---

## Cómo agregar una nueva vista

1. Agregar botón en el sidebar de `index.html` con `id="nav-NombreVista"`
2. Crear función `buildNombreVistaView()` en `app.js` → sección 14 aprox.
3. Agregar dispatch en `renderMain()` → sección 8
4. Si la vista necesita estado propio (ej: mes seleccionado), declararlo en sección 2

---

## Cómo agregar un nuevo campo a tareas

1. Agregar el campo en `buildAddForm()` → sección 15
2. Leerlo en `addTask()` → sección 16
3. Mostrarlo en `taskRowHTML()` → sección 7
4. Persistirlo en `toggleTask()` si afecta al log

---

## Migración futura a backend

Todo el estado vive en `state` (sección 2). Para migrar a una base de datos:
- Reemplazar `saveState()` / `loadState()` con llamadas a una API
- El resto del código no cambia
- Los datos del log ya tienen timestamps ISO completos para análisis
