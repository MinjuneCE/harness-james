// Reads a Claude Code approval dialog from a pane screen (herdr agent read --source visible).
// Measured 2026-10-15 (2.1.300): the question line, then numbered options with ❯ on the cursor row:
//   Do you want to proceed?
//   ❯ 1. Yes
//     2. No                      (ask rules show only these two)
//   Esc to cancel · Tab to amend
// The digit key picks an option directly. Esc cancels the whole turn ("Interrupted · What should Claude do instead?").
// Mods (work-trace) may draw a side panel after a `│` column; it is cut off first.

const OPTION = /^\s*(?:❯\s*)?(\d)\.\s+(.+?)\s*$/
const RULE = /^[\s─╌━═-]+$/
// The dialog's top border; dashed ╌ rules inside it (diff previews) are not borders.
const BORDER = /^\s*[─━]{8,}\s*$/

const wide = (c) =>
  (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f300

/** Display column (wide chars = 2) of each `│` → index pairs for a line. */
function barCols(l) {
  const out = []
  let col = 0
  let idx = 0
  for (const ch of l) {
    if (ch === '│') out.push([col, idx])
    col += wide(ch.codePointAt(0)) ? 2 : 1
    idx += ch.length
  }
  return out
}

/** Cut a right-hand side panel: the most common `│` display column, when most non-empty lines share it. */
export function stripSidePanel(lines) {
  const cols = new Map()
  for (const l of lines) for (const [c] of barCols(l)) if (c > 0) cols.set(c, (cols.get(c) ?? 0) + 1)
  let best = -1
  let n = 0
  for (const [c, k] of cols) if (k > n) [best, n] = [c, k]
  if (best <= 0 || n < lines.filter((l) => l.trim()).length * 0.5) return lines
  return lines.map((l) => {
    // ±3 columns: ambiguous-width glyphs (╌, ●, ✕) can shift a row slightly.
    const hit = barCols(l).find(([c]) => c === best) ?? barCols(l).find(([c]) => Math.abs(c - best) <= 3)
    return (hit ? l.slice(0, hit[1]) : l).replace(/\s+$/, '')
  })
}

/** → { question, options:[{n,label,selected}], context:[...] } | null */
export function parseDialog(screen) {
  const lines = stripSidePanel(String(screen).split('\n'))
  let last = -1
  for (let i = lines.length - 1; i >= 0; i--) if (OPTION.test(lines[i])) { last = i; break }
  if (last < 0) return null
  let first = last
  while (first > 0 && (OPTION.test(lines[first - 1]) || (/^\s{4,}\S/.test(lines[first - 1]) && !/\?\s*$/.test(lines[first - 1])))) first--
  const options = []
  for (let i = first; i <= last; i++) {
    const m = lines[i].match(OPTION)
    if (m) options.push({ n: Number(m[1]), label: m[2], selected: /❯/.test(lines[i]) })
    else if (options.length) options[options.length - 1].label += ' ' + lines[i].trim()
  }
  let q = first - 1
  while (q >= 0 && !lines[q].trim()) q--
  const question = q >= 0 ? lines[q].trim() : ''
  // Context: the dialog box only — lines above the question up to its top border (a solid ─ rule).
  // Measured in E2E (10/16): above that border sit the tool line (`⎿  $ cmd`), its title and the last prompt
  // sent to the sub; those stop the walk too, for screens where the border was not captured.
  const context = []
  for (let i = q - 1; i >= 0 && context.length < 12; i--) {
    const t = lines[i].trim()
    if (context.length && BORDER.test(lines[i])) break
    if (RULE.test(lines[i]) || !t) {
      if (context.length && !t && i > 0 && !lines[i - 1].trim()) break
      continue
    }
    if (/^[⏺●✻⎿]/.test(t) || /^(❯|>)(\s|$)/.test(t)) break
    context.unshift(t)
  }
  // Measured: after 3 consecutive auto-mode denials Claude Code asks "Do you want to proceed?" itself
  // (and auto-denies in ~2 min). Yes there overrides the classifier, so it is flagged.
  const kind = context.some((l) => /Auto mode classifier/i.test(l)) ? 'classifier' : 'permission'
  return { question, options, context, kind }
}

/** Option number for "allow once": exactly "Yes" (never "…don't ask again" / "…switch to auto"). */
export function onceOption(d) {
  return d?.options.find((o) => /^Yes(?:,? (?:allow )?(?:once|this time))?\.?$/i.test(o.label))?.n
}
export function noOption(d) {
  return d?.options.find((o) => /^No\b/i.test(o.label))?.n
}

// First-run screens of a profile without a login (measured 2026-10-23, 2.1.309, empty CLAUDE_CONFIG_DIR):
// the theme picker, then "Select login method:", then the OAuth "Paste code here if prompted". herdr reports
// these as idle/ready, so a prompt sent there would land in the picker.
const LOGIN = [/Choose the text style that looks best with your terminal/, /Select login method:/, /Paste code here if prompted/, /Browser didn.t open\?/]

/** The matched login/onboarding line, or null. */
export function loginScreen(screen) {
  for (const l of String(screen ?? '').split('\n')) if (LOGIN.some((re) => re.test(l))) return l.trim()
  return null
}
