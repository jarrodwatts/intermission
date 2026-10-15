// Catches keys and clicks over the game picture and posts what is held, which
// the hooks module writes to the engine's input file. Each click also asks the
// engine to lock the cursor, which it then reads for mouse-look itself.
//
// The terminal reports presses, never releases. A key counts as held until
// its auto-repeat stops: long after a single press, because the first repeat
// comes late, and briefly once repeats are flowing. Mouse buttons do report
// releases.

const HOLD_AFTER_PRESS_MS = 550
const HOLD_WHILE_REPEATING_MS = 120

// Mouse look from pointer motion, for terminals, where the cursor can't be
// locked: each cell the pointer travels turns the player this far, and
// resting in the outer fifth of the picture keeps turning that way. A click
// starts it and Esc stops it.
const TURN_PER_CELL = 24
const TURN_PER_TICK_AT_EDGE = 10
const EDGE = 0.2

const MOUSE_FIRE = 0x20000000
const KEY_FORWARD = 'w'.charCodeAt(0)

const SPECIAL_KEYS = {
  up: 0x40000052,
  down: 0x40000051,
  left: 0x40000050,
  right: 0x4000004f,
  return: 0x0d,
  tab: 0x09,
}

function keyCode(key) {
  if (SPECIAL_KEYS[key]) return SPECIAL_KEYS[key]
  return key.length === 1 ? key.toLowerCase().charCodeAt(0) : null
}

export default function GameInput(props, surface) {
  if (surface.state === undefined) {
    const input = {
      presses: new Map(), // key code -> { at, isRepeating }
      buttons: new Set(),
      clicks: 0,
      turn: 0,
      lastX: null,
      x: null,
      isLooking: false,
      posted: '',
    }

    surface.onKey((e) => {
      if (e.key === 'escape') input.isLooking = false
      const code = keyCode(e.key)
      if (code === null) return
      const now = Date.now()
      const last = input.presses.get(code)
      input.presses.set(code, { at: now, isRepeating: !!last && now - last.at < HOLD_AFTER_PRESS_MS })
    })

    surface.onPointer((e) => {
      if (typeof e.x === 'number') {
        if (input.isLooking && input.lastX !== null && (e.type === 'move' || e.type === 'drag')) {
          input.turn += (e.x - input.lastX) * TURN_PER_CELL
        }
        input.lastX = e.x
        input.x = e.x
      }
      const code = e.button === 'left' ? MOUSE_FIRE : e.button === 'right' ? KEY_FORWARD : null
      if (code === null) return
      if (e.type === 'down') {
        input.buttons.add(code)
        input.clicks += 1
        input.isLooking = true
      }
      if (e.type === 'up') input.buttons.delete(code)
    })

    surface.every(30, () => {
      const now = Date.now()
      const keys = new Set(input.buttons)
      for (const [code, press] of input.presses) {
        const holdMs = press.isRepeating ? HOLD_WHILE_REPEATING_MS : HOLD_AFTER_PRESS_MS
        if (now - press.at < holdMs) keys.add(code)
        else input.presses.delete(code)
      }
      const width = props?.width || 100
      if (input.isLooking && input.x !== null) {
        if (input.x < width * EDGE) input.turn -= TURN_PER_TICK_AT_EDGE
        else if (input.x >= width * (1 - EDGE)) input.turn += TURN_PER_TICK_AT_EDGE
      }
      const line = [input.clicks, ...[...keys].sort(), 'm' + Math.round(input.turn)].join(' ')
      if (line === input.posted) return
      input.posted = line
      surface.post({ line })
    })

    surface.setState(input)
  }

  const { Box } = surface.elements
  return Box({ width: '100%', height: '100%' })
}
