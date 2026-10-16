// The trace's own clock: read in the hooks without a call to the host, so a
// hook stamps what it saw and hands the event on at once.
//
// `$.clock.now()` is an event through the host and resolves later; awaiting it
// in a hook makes the model wait on the trace. Here the environment's own
// monotonic clock (`performance.now()`) is read instead, and set against the
// host's time whenever a reading of it comes in off the model's path (the
// pane's timer, a drawing). Until the first reading comes in, the stamps are
// taken against the environment's wall clock; when the host's time turns out
// to differ (a mocked clock in the tests), the first reading moves the stamps
// already taken by the difference, once, so they read on the host's time too.

/** The host's time minus the monotonic clock, from the latest reading; undefined before the first. */
let offset: number | undefined
/** Told once, at the first reading, how far the stamps taken before it are off. */
let onFirst: ((delta: number) => void) | undefined

const mono = (): number => performance.now()

/** Now, in milliseconds since the epoch, without waiting on anything. */
export function stamp(): number {
  return mono() + (offset ?? Date.now() - mono())
}

/** A reading of the host's time (`$.clock.now()`), taken off the model's path. */
export function anchor(wall: number): void {
  const before = offset
  offset = wall - mono()
  if (before === undefined) {
    const delta = wall - Date.now()
    // The environment's wall clock was the host's after all: nothing to move.
    if (Math.abs(delta) > 250) onFirst?.(delta)
  }
}

/** Who moves the stamps taken before the first reading. */
export function onFirstAnchor(fn: (delta: number) => void): void {
  onFirst = fn
}
