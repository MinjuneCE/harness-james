// Where the next sub pane goes. Pure: takes `herdr pane layout` output, returns a split plan.
// Main keeps >= 45% of the tab width. First sub goes right of main; later subs stack down the sub
// column; once a column has ROWS rows (or rows get too short) the largest sub pane is split right.
export const MAIN_MIN_SHARE = 0.45
export const MAIN_SHARE = 0.55
export const MIN_W = 40
export const MIN_H = 10
export const ROWS = 3

const area = (r) => r.width * r.height

/** → { pane, direction, ratio } | { error, next } */
export function planSplit(layout, mainPane, subPanes) {
  const byId = new Map(layout.panes.map((p) => [p.pane_id, p.rect]))
  const m = byId.get(mainPane)
  if (!m) return { error: `main pane ${mainPane} is not in this tab's layout`, next: 'run spawn from the main pane' }
  const subs = subPanes.filter((id) => byId.has(id)).map((id) => ({ id, ...byId.get(id) }))
  const W = layout.area.width

  if (!subs.length) {
    const ratio = Math.max(MAIN_SHARE, (MAIN_MIN_SHARE * W) / m.width)
    if (ratio < 1 && m.width * (1 - ratio) >= MIN_W) return { pane: mainPane, direction: 'right', ratio: round(ratio) }
    if (m.height * 0.4 >= MIN_H) return { pane: mainPane, direction: 'down', ratio: 0.6, note: 'main too narrow to split right; sub column placed below main' }
    return { error: 'no room next to main', next: 'close or move other panes in this tab (main must keep 45% width)' }
  }

  const x0 = Math.min(...subs.map((s) => s.x))
  const oneColumn = subs.every((s) => s.x === x0)
  const tallest = [...subs].sort((a, b) => b.height - a.height || a.y - b.y)[0]
  if (oneColumn && subs.length < ROWS && tallest.height / 2 >= MIN_H) return { pane: tallest.id, direction: 'down', ratio: 0.5 }

  const biggest = [...subs].sort((a, b) => area(b) - area(a) || a.y - b.y || a.x - b.x)[0]
  if (biggest.width / 2 >= MIN_W) return { pane: biggest.id, direction: 'right', ratio: 0.5 }
  if (biggest.height / 2 >= MIN_H) return { pane: biggest.id, direction: 'down', ratio: 0.5 }
  return { error: 'sub panes are too small to split again', next: 'close a finished sub first (pane-lead close <name>)' }
}

const round = (n) => Math.round(n * 1000) / 1000
