// intermission: drops you into Doom while Claude works and hands you back when
// it's done, or as soon as it needs you.

const PANE = 'intermission'
const WIDTH = 640
const HEIGHT = 360
const DROP_IN_DELAY_MS = 2000
const COUNTDOWN_SECONDS = 3
const SERVER = '157.245.140.115:10666'
// Between drop-ins the engine waits on the server as a spectator; after this
// long it disconnects, so idle sessions don't hold the server's slots
const AWAY_DISCONNECT_MS = 5 * 60 * 1000
// Long enough for a slow connection; some networks never let it through at all
const CONNECT_TIMEOUT_MS = 10 * 1000

const RELEASES = 'https://github.com/jarrodwatts/intermission/releases/download'

const NAME_STARTS = ['Idle', 'Bored', 'Queued', 'Pending', 'Async', 'Blocked', 'Lazy']
const NAME_ENDS = ['Dev', 'Coder', 'Hacker', 'Intern', 'Marine', 'Imp']

// Whether the person turned intermission on, and their name in the game, both
// kept between sessions in $.store
let isOn = false
let name = null

// Set at session start. Windows has no uname, no rm and no POSIX shared
// memory, so it runs the built-in tools by path and gets frames as files.
let isWindows = false
let tempDir = '/tmp'
let system32 = null

// Where play stands:
//   idle      not playing, whether or not Claude is working
//   waiting   Claude is working; dropping in once the delay passes
//   offered   the terminal was too narrow for the pane to open by itself, so
//             the band above the prompt offers a key that opens it
//   playing   the pane is open and the engine runs
//   countdown Claude is done; closing when the count reaches zero
let phase = 'idle'
let isTurnRunning = false
// Closed by hand during this turn, so stay out until the next one
let isDismissed = false
let isWelcomeOpen = false
let timer = null
let countdown = 0

// The running engine's output stream, the newest frame it wrote, the file it
// reads input from, the input region's last line, and the disconnect timer
let engine = null
let frame = null
let inputPath = null
let clientLine = '0'
let awayTimer = null
// Set once the server proved unreachable, so the rest of the session plays a
// local game against monsters instead
let isOffline = false
// The engine download in flight, and what the welcome pane says about it
let download = null
let downloadStatus = null
// Kills and deaths in the current or last round, as the engine reports them
let score = null

function cancelTimer() {
  timer?.cancel()
  timer = null
}

function armDropIn($) {
  if (!isOn || !isTurnRunning || isDismissed || phase !== 'idle') return
  phase = 'waiting'
  timer = $.clock.after(DROP_IN_DELAY_MS, () => dropIn($))
}

async function dropIn($) {
  if (phase !== 'waiting') return
  timer = null
  const surfaces = await $.session.surfaces()
  if (!surfaces.includes('terminal') || !(await $.fs.exists(enginePath($.plugin.root))) || (await lacksRuntime($))) {
    phase = 'idle'
    return
  }
  const opened = await $.ui.open({ id: PANE, title: 'intermission', focus: true })
  if (!opened.isPlaced) {
    // A waiting pane would pop up later, long after the moment has passed.
    // One the person opens appears at any width, so offer them a key instead.
    $.ui.log('the pane waits for a wider terminal: ' + opened.reason, { to: 'debug' })
    await $.ui.close({ id: PANE })
    phase = 'offered'
    $.ui.invalidate('ui.render')
    return
  }
  await startPlaying($)
}

async function acceptOffer($) {
  if (phase !== 'offered') return
  const { isPlaced } = await $.ui.open({ id: PANE, title: 'intermission', focus: true })
  if (isPlaced) await startPlaying($)
}

async function startPlaying($) {
  phase = 'playing'
  $.ui.invalidate('ui.render')
  awayTimer?.cancel()
  awayTimer = null
  if (engine) await writeInput($)
  else void runEngine($)
}

// Claude is done or needs the person before they took up an offer to play
function withdrawOffer($) {
  cancelTimer()
  phase = 'idle'
  $.ui.invalidate('ui.render')
}

// why, when given, heads the toast that sums up the round
async function pullOut($, why) {
  cancelTimer()
  phase = 'idle'
  if (why && score) $.ui.toast(why + ' · ' + scoreText(score))
  await $.ui.close({ id: PANE })
}

function scoreText({ kills, deaths }) {
  return kills + (kills === 1 ? ' kill, ' : ' kills, ') + deaths + (deaths === 1 ? ' death' : ' deaths')
}

function startCountdown($) {
  phase = 'countdown'
  countdown = COUNTDOWN_SECONDS
  $.ui.invalidate('ui.render')
  timer = $.clock.every(1000, () => {
    countdown -= 1
    if (countdown > 0) $.ui.invalidate('ui.render')
    else void pullOut($, "Claude's done")
  })
}

// The engine plays or spectates by the first number, and takes keys only in play
async function writeInput($) {
  if (!inputPath) return
  const isPlaying = phase === 'playing' || phase === 'countdown'
  await $.fs.write(inputPath, isPlaying ? '1 ' + clientLine + '\n' : '0 0\n')
}

// The pane closed, whoever closed it: spectate until the next drop-in
async function goAway($) {
  cancelTimer()
  phase = 'idle'
  isWelcomeOpen = false
  frame = null
  // The next input region counts its clicks from zero again
  clientLine = '0'
  if (!engine) return
  await writeInput($)
  awayTimer?.cancel()
  awayTimer = $.clock.after(AWAY_DISCONNECT_MS, () => void stopEngine($))
}

async function stopEngine($) {
  awayTimer?.cancel()
  awayTimer = null
  // Leaving the stream's loop is what stops the engine
  if (engine) await engine.return()
}

function randomName() {
  const pick = (words) => words[Math.floor(Math.random() * words.length)]
  return pick(NAME_STARTS) + pick(NAME_ENDS) + (10 + Math.floor(Math.random() * 90))
}

// Claude is about to ask the person something, so they must see the prompt
async function needsYou($) {
  if (phase === 'waiting' || phase === 'offered') {
    withdrawOffer($)
  } else if (phase !== 'idle') {
    await pullOut($, 'Claude needs you')
  }
}

function enginePath(root) {
  return isWindows ? root + '\\dist\\odamex.exe' : root + '/dist/odamex.app/Contents/MacOS/odamex'
}

// A file in the temporary directory, for the engine's settings and input
function tempPath(file) {
  return tempDir + (isWindows ? '\\' : '/') + file
}

// The release asset's platform, as release.yml names it
async function enginePlatform($) {
  // Windows 11 on Arm runs the x64 build under emulation
  if (isWindows) return 'windows-x64'
  const [system, arch] = (await $.process.run(['uname', '-sm'])).stdout.trim().split(' ')
  if (system !== 'Darwin') throw new Error('it runs on macOS and Windows for now')
  return 'macos-' + arch
}

// With no shell to run them through, Windows gets its built-in tools by path,
// so a curl or tar from Git or another package manager never stands in
function tool(name) {
  return isWindows ? system32 + name + '.exe' : name
}

async function removeFile($, path) {
  await $.process.run(isWindows ? [tool('cmd'), '/d', '/c', 'del', '/f', '/q', path] : ['rm', '-f', path])
}

// odamex.exe needs the Visual C++ runtime, which Windows doesn't come with;
// started without it, Windows stops it with an error dialog
const RUNTIME_NEEDED =
  'The game needs the Microsoft Visual C++ Redistributable: winget install Microsoft.VCRedist.2015+.x64'

async function lacksRuntime($) {
  if (!isWindows) return false
  return !(await $.fs.exists(system32 + 'vcruntime140_1.dll')) || !(await $.fs.exists(system32 + 'msvcp140_1.dll'))
}

// Each plugin version downloads the engine built for it, once
function ensureEngine($) {
  download ??= downloadEngine($).finally(() => {
    download = null
  })
  return download
}

async function downloadEngine($) {
  const root = $.plugin.root
  const showStatus = (text) => {
    downloadStatus = text
    $.ui.invalidate('ui.render')
  }
  if (await $.fs.exists(enginePath(root))) {
    if (await lacksRuntime($)) showStatus(RUNTIME_NEEDED)
    return
  }
  try {
    const platform = await enginePlatform($)
    const { version } = JSON.parse(await $.fs.read(root + '/.claude-plugin/plugin.json'))
    const dist = root + (isWindows ? '\\dist' : '/dist')
    const archive = dist + (isWindows ? '\\engine.tar.gz' : '/engine.tar.gz')
    showStatus('Downloading the game, about 40 MB…')
    // --create-dirs makes dist, with no mkdir to call on Windows
    const fetched = await $.process.run(
      [
        tool('curl'),
        '-fsSL',
        '--retry',
        '2',
        '--create-dirs',
        '-o',
        archive,
        RELEASES + '/v' + version + '/intermission-engine-' + platform + '.tar.gz',
      ],
      { timeoutMs: 10 * 60 * 1000 },
    )
    if (fetched.exitCode !== 0) throw new Error(fetched.stderr.trim() || 'the download failed')
    const unpacked = await $.process.run([tool('tar'), '-xzf', archive, '-C', dist])
    await removeFile($, archive)
    if (unpacked.exitCode !== 0) throw new Error(unpacked.stderr.trim() || 'the download was damaged')
    showStatus((await lacksRuntime($)) ? RUNTIME_NEEDED : 'The game is ready.')
  } catch (error) {
    showStatus("Couldn't get the game: " + error.message)
  }
}

function engineRequest(root, id) {
  return {
    argv: [
      enginePath(root),
      '-iwad', root + '/dist/freedoom2.wad',
      // Its own settings, so a person's own Odamex setup is never touched
      '-config', tempPath('intermission-' + id + '.cfg'),
      '-width', String(WIDTH),
      '-height', String(HEIGHT),
      '+vid_fullscreen', '0',
      '+vid_maxfps', '35',
      // Odamex's macOS music player ignores volume changes, so it played on
      // while muted between drop-ins; its built-in OPL synth mixes through SDL
      '+snd_musicsystem', '4',
      '+cl_name', name,
      ...(isOffline ? ['+map', 'MAP01'] : ['+connect', SERVER]),
    ],
    env: {
      SDL_VIDEODRIVER: 'dummy',
      SDL_RENDER_DRIVER: 'software',
      // A per-run name keeps two sessions' frames from colliding. On Windows
      // it starts the path of each frame's file, in a folder the engine sweeps
      INTERMISSION_FRAMES: isWindows ? tempPath('intermission-frames\\' + id + '-') : '/im' + id + '-',
      INTERMISSION_INPUT: inputPath,
    },
  }
}

async function runEngine($) {
  const id = Math.random().toString(36).slice(2, 6)
  inputPath = tempPath('intermission-' + id + '.input')
  await writeInput($)
  score = { kills: 0, deaths: 0 }
  engine = $.process.spawn(engineRequest($.plugin.root, id))
  const startedAt = await $.clock.now()
  let isConnected = isOffline
  let isUnreachable = false
  let pending = ''
  let failure = null
  try {
    for await (const { stream, text } of engine) {
      if (stream !== 'stdout') continue
      // Pieces arrive as written, not as lines, which end in \r\n on Windows
      const lines = (pending + text).split(/\r?\n/)
      pending = lines.pop()
      for (const line of lines) {
        if (line === '@connected') {
          isConnected = true
          continue
        }
        if (!isConnected && (await $.clock.now()) - startedAt > CONNECT_TIMEOUT_MS) {
          isUnreachable = true
          break
        }
        const sentAway = /^@disconnected (.*)/.exec(line)
        if (sentAway) {
          failure = 'intermission was disconnected' + (sentAway[1] ? ': ' + sentAway[1] : '')
          break
        }
        const scored = /^@score (\d+) (\d+)/.exec(line)
        if (scored) {
          score = { kills: Number(scored[1]), deaths: Number(scored[2]) }
          $.ui.invalidate('ui.render')
          continue
        }
        // A Windows frame is a file path, which may hold spaces
        const match = /^@frame (.+) \d+ \d+$/.exec(line)
        if (!match) continue
        const isFirst = frame === null
        frame = match[1]
        if (isFirst) {
          $.ui.invalidate('ui.render')
        } else {
          $.ui.blit({ requestId: PANE, key: 'view', source: frameSource(frame) }).catch(() => {})
        }
      }
      // Leaving the loop is what stops the engine
      if (failure || isUnreachable) break
    }
  } catch (error) {
    $.ui.log('the game did not start: ' + error, { to: 'debug' })
    failure = "intermission couldn't start the game"
  } finally {
    engine = null
    frame = null
    inputPath = null
  }
  if (isUnreachable) {
    isOffline = true
    if (phase === 'playing' || phase === 'countdown') {
      $.ui.toast(
        "Couldn't reach the game server. Your network may block UDP, as corporate VPNs like Zscaler do, so this is an offline game against monsters.",
        { timeoutMs: 8000 },
      )
      void runEngine($)
    }
    return
  }
  // Ending on its own while someone plays means the engine quit, crashed or was
  // sent away; while they're away, the next drop-in simply starts it again.
  // It also ends when this module unloads, and then there's nothing to close.
  if (phase === 'playing' || phase === 'countdown') {
    try {
      $.ui.toast(failure ?? 'intermission lost the game')
      await pullOut($)
    } catch {}
  }
}

// Claude Code reads POSIX shared memory only, so on Windows each frame is a
// file the terminal reads instead
function frameSource(name) {
  return isWindows
    ? { file: name, format: 'rgb', width: WIDTH, height: HEIGHT }
    : { shm: name, format: 'rgb', width: WIDTH, height: HEIGHT }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    // Every Windows process has OS=Windows_NT in its environment
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    if (isWindows) {
      tempDir = await $.env.get('TEMP')
      system32 = (await $.env.get('SystemRoot')) + '\\System32\\'
    }
    isOn = (await $.store.get('isOn')) === true
    name = await $.store.get('name')
    if (!name) {
      name = randomName()
      await $.store.set('name', name)
    }
    await $.command.register({
      name: 'intermission',
      description: 'Play Doom while Claude works',
      argumentHint: '[off]',
    })
    return next(e)
  })

  on('command.run', { command: 'intermission' }, async ($, e) => {
    if (e.args.trim() === 'off') {
      isOn = false
      await $.store.set('isOn', false)
      if (phase !== 'idle') await pullOut($)
      await stopEngine($)
      return { text: 'intermission is off.' }
    }
    isOn = true
    await $.store.set('isOn', true)
    // Opening it yourself also lets it open by itself in narrower terminals
    if (phase === 'idle') {
      isWelcomeOpen = true
      await $.ui.open({ id: PANE, title: 'intermission' })
    }
    void ensureEngine($)
    return {}
  })

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    isDismissed = false
    if (isWelcomeOpen) {
      isWelcomeOpen = false
      await $.ui.close({ id: PANE })
    }
    if (phase === 'countdown') {
      // A queued prompt started straight away, so keep playing
      cancelTimer()
      phase = 'playing'
      $.ui.invalidate('ui.render')
    }
    armDropIn($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    isTurnRunning = false
    if (phase === 'waiting' || phase === 'offered') {
      withdrawOffer($)
    } else if (phase === 'playing') {
      if (e.isAborted) await pullOut($)
      else startCountdown($)
    }
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const result = await next(e)
    // In auto mode an ask can go to the classifier instead of the person;
    // pulling out anyway costs a moment, missing a real prompt costs more
    if (e.tool_use_id && result.decision === 'ask') await needsYou($)
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion') await needsYou($)
    const result = await next(e)
    // Once an answered prompt lets Claude carry on, drop back in
    armDropIn($)
    return result
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    if (e.origin?.kind === 'person' && isTurnRunning) isDismissed = true
    await goAway($)
    return next(e)
  })

  on('ui.message', async ($, e) => {
    if (e.element !== 'input') return {}
    clientLine = e.data.line
    await writeInput($)
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (phase !== 'offered') return next(e)
    const { Box, Button } = $.ui.resolve(e)
    // Keep whatever other mods show in the band
    const others = await next(e)
    return Box({
      flexDirection: 'column',
      children: [
        Button({ key: 'play', label: 'Play Doom while Claude works', hotkey: '1', plain: true, onPress: () => acceptOffer($) }),
        ...(others ? [others] : []),
      ],
    })
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (phase === 'idle' || phase === 'waiting' || !score) return next(e)
    return next({ ...e, props: { ...e.props, suffix: ' · ' + scoreText(score) + '…' } })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Image, Client, Button } = $.ui.resolve(e)

    if (isWelcomeOpen) {
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: [
          Text({ bold: true, children: ['intermission is on'] }),
          Text({
            children: [
              'When Claude has been working for 2 seconds you drop into Doom here, and you get handed back when it is done or needs you.',
            ],
          }),
          ...(downloadStatus ? [Text({ children: [downloadStatus] })] : []),
          Text({ dimColor: true, children: ['/intermission off turns it off.'] }),
          Button({
            key: 'got-it',
            label: 'Got it',
            autoFocus: true,
            onPress: async () => {
              isWelcomeOpen = false
              await $.ui.close({ id: PANE })
            },
          }),
        ],
      })
    }

    if (e.surface !== 'terminal') {
      return Text({ children: ['intermission needs the terminal, in ' + (isWindows ? 'Rio.' : 'Ghostty or kitty.')] })
    }
    if (!frame) return Text({ children: [isOffline ? 'Starting an offline game…' : 'Joining the game as ' + name + '…'] })
    // Terminal cells are about twice as tall as they are wide
    const columns = Math.min(255, e.props.bodyColumns)
    const rows = Math.max(1, Math.round((columns * HEIGHT) / WIDTH / 2))
    const status =
      phase === 'countdown'
        ? Text({ bold: true, children: ["Claude's done · back in " + countdown] })
        : Text({
            dimColor: true,
            children: [
              'Click the game to play and lock the mouse · ' +
                (isWindows ? 'Esc or Alt' : 'Esc or ⌘') +
                ' releases it · WASD or arrows · left click fires · right click runs · space opens',
            ],
          })
    return Box({
      flexDirection: 'column',
      children: [
        Image({ key: 'view', source: frameSource(frame), columns, rows, alt: 'Doom' }),
        // Laid over the picture, so clicks land on the game
        Box({
          position: 'absolute',
          top: 0,
          left: 0,
          children: [Client({ key: 'input', module: './input.js', width: columns, height: rows })],
        }),
        status,
      ],
    })
  })
}
