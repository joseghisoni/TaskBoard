# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

Open `index.html` directly in a browser — no build step, no server, no dependencies. The app runs entirely client-side.

## Architecture

Three files, no framework:

- `index.html` — DOM structure and 4 modals (category manager, habit editor, task reschedule, color picker)
- `styles.css` — Dark theme via CSS variables; desktop-first layout using CSS Grid and Flexbox
- `app.js` — All application logic (~1300 lines, 21 clearly-marked sections)

**State and persistence:** A single `state` object is the source of truth, persisted synchronously to localStorage under key `tb_v3`. All mutations follow: update `state` → call `saveState()` → call `render()`.

**Core data model:**

```
Tasks:  { id, name, cat, due (YYYY-MM-DD), time?, done, habitId? }
Habits: { id, name, cat, days (0–6 array), occurrences[] }
  Occurrence: { date, weekStart, taskId, done }
Categories: { id, name, color }
Log:    { id, name, cat, completedAt (ISO 8601), habitId? }
```

**Habits → Tasks:** `ensureWeeklyOccurrences()` generates task entries from habits each week. Completed habit tasks are moved to the `log[]` array.

**Views:** `renderMain()` dispatches to view builders based on `currentView`. Views: Today, Week, Later, Category, Overdue, Habits, Log, Analytics. Each view builder composes HTML strings injected into the DOM.

**Adding a new view:** Create a `buildXxxView()` function that returns an HTML string, register the view name in `renderMain()`, and add a sidebar nav item in `index.html`.

**Extending the data model:** Add the field to the relevant object in `state`, update the form HTML in `buildAddForm()` or the relevant modal, handle it in the mutation function, and re-render.

**Future backend migration:** Replace `saveState()` / `loadState()` with API calls — the rest of the app is already decoupled from the persistence layer.
