import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import { io } from 'socket.io-client'
import './App.css'

const DEFAULT_WORLD = { width: 1200, height: 760 }
const PROD_BACKEND_URL = 'https://word-game-backend-9n6o.onrender.com'
const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  (['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : PROD_BACKEND_URL)

const EMPTY_STATE = {
  roomId: 'main',
  sessionId: '',
  performanceMode: 'smooth',
  running: false,
  timeLeft: 0,
  question: { prompt: '', options: [] },
  words: [],
  players: [],
  sessionTopFive: [],
  maxPlayers: 20,
  feed: [],
  event: { id: null, name: '', endsAtMs: 0 },
  world: DEFAULT_WORLD,
}

function getOrCreatePlayerSessionId() {
  if (typeof window === 'undefined') return ''
  const key = 'word-game-player-session-id'
  const existing = window.localStorage.getItem(key)
  if (existing) return existing
  const generated = `ps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  window.localStorage.setItem(key, generated)
  return generated
}

function hashString(value) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash)
}

const TOKEN_THEMES = [
  { from: '#25c7c1', to: '#2f7bdf', border: '#b9f7f2', glow: 'rgba(37, 199, 193, 0.38)' },
  { from: '#3ec4ff', to: '#3659d9', border: '#d0ebff', glow: 'rgba(62, 196, 255, 0.38)' },
  { from: '#42dba0', to: '#178f7d', border: '#cefbe7', glow: 'rgba(66, 219, 160, 0.36)' },
  { from: '#7ad0ff', to: '#2f8ca9', border: '#d9f3ff', glow: 'rgba(122, 208, 255, 0.35)' },
  { from: '#43e3d2', to: '#2f5fc7', border: '#ccfbf5', glow: 'rgba(67, 227, 210, 0.36)' },
  { from: '#6ec0ff', to: '#2a8f8f', border: '#d9ecff', glow: 'rgba(110, 192, 255, 0.34)' },
  { from: '#2fc0a7', to: '#2465b2', border: '#c7f5eb', glow: 'rgba(47, 192, 167, 0.36)' },
  { from: '#39d8ff', to: '#1f8a76', border: '#d0f7ff', glow: 'rgba(57, 216, 255, 0.34)' },
]

function getTokenGradient(word) {
  const seed = hashString(`${word.id}-${word.text}-${word.colorVariant || 0}`)
  const theme = TOKEN_THEMES[seed % TOKEN_THEMES.length]

  return {
    backgroundImage: `linear-gradient(140deg, ${theme.from}, ${theme.to})`,
    borderColor: theme.border,
    '--token-glow': theme.glow,
  }
}

function App() {
  const socketRef = useRef(null)
  const arenaRef = useRef(null)
  const [state, setState] = useState(EMPTY_STATE)
  const [connected, setConnected] = useState(false)
  const [playerId, setPlayerId] = useState('')
  const [playerSessionId, setPlayerSessionId] = useState(() => getOrCreatePlayerSessionId())
  const [selfJoinName, setSelfJoinName] = useState('')
  const [joinRequested, setJoinRequested] = useState(false)
  const [joinError, setJoinError] = useState('')
  const [arenaSize, setArenaSize] = useState(DEFAULT_WORLD)
  const [feedbackDone, setFeedbackDone] = useState(false)
  const [feedbackApps, setFeedbackApps] = useState([])
  const [feedbackWell, setFeedbackWell] = useState([])
  const [feedbackImprove, setFeedbackImprove] = useState([])
  const [feedbackWellOther, setFeedbackWellOther] = useState('')
  const [feedbackImproveOther, setFeedbackImproveOther] = useState('')
  const [feedbackSuggestions, setFeedbackSuggestions] = useState('')
  const [feedbackError, setFeedbackError] = useState('')
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false)

  const isPlayerView = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('view') === 'player'
  })

  const isMobileDevice = useMemo(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 820
  }, [])

  const activePlayer = useMemo(
    () => state.players.find((player) => player.id === playerId) ?? null,
    [playerId, state.players],
  )

  const sortedPlayers = useMemo(
    () => [...state.players].sort((left, right) => right.score - left.score),
    [state.players],
  )
  const topPlayers = useMemo(() => {
    if (Array.isArray(state.sessionTopFive) && state.sessionTopFive.length > 0) {
      return state.sessionTopFive.slice(0, 5)
    }
    return [...state.players].sort((left, right) => right.score - left.score).slice(0, 5)
  }, [state.players, state.sessionTopFive])
  const winnerRanking = useMemo(() => {
    const qualified = state.players.filter((player) => player.isQualified)
    const source = qualified.length > 0 ? qualified : state.players
    return [...source].sort((left, right) => {
      const leftAttempt = left.attempted ? 1 : 0
      const rightAttempt = right.attempted ? 1 : 0
      if (rightAttempt !== leftAttempt) return rightAttempt - leftAttempt
      return right.score - left.score
    })
  }, [state.players])
  const livePlayers = useMemo(
    () => state.players.filter((player) => player.isOnline),
    [state.players],
  )

  const groupLead = useMemo(() => {
    if (topPlayers.length === 0) return 'No scores yet'
    if (topPlayers.length > 1 && topPlayers[0].score === topPlayers[1].score) {
      return 'Tie'
    }
    return topPlayers[0].name
  }, [topPlayers])

  const activePlayerRank = useMemo(() => {
    if (!activePlayer) return null
    const index = winnerRanking.findIndex((player) => player.id === activePlayer.id)
    return index === -1 ? null : index + 1
  }, [activePlayer, winnerRanking])

  const rankProfile = useMemo(() => {
    if (activePlayerRank === 1) {
      return {
        label: 'Champion',
        message: 'Outstanding performance. You finished at the top.',
        className: 'rank-champion',
      }
    }
    if (activePlayerRank === 2) {
      return {
        label: 'Runner-Up',
        message: 'Strong finish. You secured second place.',
        className: 'rank-runnerup',
      }
    }
    if (activePlayerRank === 3) {
      return {
        label: 'Top 3',
        message: 'Great pace. You finished in the top three.',
        className: 'rank-top3',
      }
    }

    return {
      label: 'Contender',
      message: 'Good effort. Keep going for a higher rank next round.',
      className: 'rank-contender',
    }
  }, [activePlayerRank])

  const playerJoinLink = useMemo(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'player')
    return url.toString()
  }, [])

  useEffect(() => {
    const socket = io(BACKEND_URL, {
      transports: ['polling', 'websocket'],
      upgrade: true,
      timeout: 20000,
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
    })

    socket.on('disconnect', () => {
      setConnected(false)
    })

    socket.on('state', (nextState) => {
      setState(nextState)
    })

    socket.on('player:joined', ({ playerId: joinedPlayerId, name, sessionId }) => {
      setPlayerId(joinedPlayerId)
      setSelfJoinName(name)
      if (sessionId) {
        setPlayerSessionId(sessionId)
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('word-game-player-session-id', sessionId)
        }
      }
      setJoinRequested(false)
      setJoinError('')
    })

    socket.on('player:join:error', ({ message }) => {
      setJoinError(message || 'Unable to join this round')
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!arenaRef.current) return undefined

    const element = arenaRef.current
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setArenaSize({
        width: Math.max(320, entry.contentRect.width),
        height: Math.max(320, entry.contentRect.height),
      })
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!isPlayerView) return undefined
    if (!connected) return undefined
    if (activePlayer) return undefined
    if (!joinRequested) return undefined

    const trimmed = selfJoinName.trim()
    if (!trimmed) return undefined

    socketRef.current?.emit('player:join', { name: trimmed, sessionId: playerSessionId })

    const retryId = window.setInterval(() => {
      socketRef.current?.emit('player:join', { name: trimmed, sessionId: playerSessionId })
    }, 2500)

    return () => window.clearInterval(retryId)
  }, [activePlayer, connected, isPlayerView, joinRequested, playerSessionId, selfJoinName])

  const joinSelfInPlayerView = () => {
    const trimmed = selfJoinName.trim()
    if (!trimmed) {
      setJoinError('Name is required')
      return
    }

    setJoinError('')
    setJoinRequested(true)
  }

  const resetGame = () => {
    socketRef.current?.emit('host:reset')
  }

  const setPerformanceMode = (mode) => {
    socketRef.current?.emit('host:set-performance-mode', { mode })
  }

  const tapWord = (wordId) => {
    if (!activePlayer || !state.running) return
    socketRef.current?.emit('word:tap', { wordId })
  }

  const toggleFeedbackItem = (list, setList, value) => {
    setList((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    )
  }

  const submitFeedback = () => {
    if (feedbackSubmitting) return

    if (feedbackApps.length === 0) {
      setFeedbackError('Q1 is required — please select at least one application.')
      return
    }
    if (feedbackWell.length === 0) {
      setFeedbackError('Q2 is required — please select at least one aspect that works well.')
      return
    }
    if (feedbackImprove.length === 0) {
      setFeedbackError('Q3 is required — please select at least one area for improvement.')
      return
    }

    const aspectsWell = feedbackWell.filter((item) => item !== '__other_well__')
    const improvementsNeeded = feedbackImprove.filter((item) => item !== '__other_improve__')
    const trimmedWellOther = feedbackWellOther.trim()
    const trimmedImproveOther = feedbackImproveOther.trim()

    if (feedbackWell.includes('__other_well__') && !trimmedWellOther) {
      setFeedbackError('Please specify the "Other" value for question 2.')
      return
    }

    if (feedbackImprove.includes('__other_improve__') && !trimmedImproveOther) {
      setFeedbackError('Please specify the "Other" value for question 3.')
      return
    }

    if (feedbackWell.includes('__other_well__')) {
      aspectsWell.push(`Other: ${trimmedWellOther}`)
    }

    if (feedbackImprove.includes('__other_improve__')) {
      improvementsNeeded.push(`Other: ${trimmedImproveOther}`)
    }

    setFeedbackError('')
    setFeedbackSubmitting(true)

    socketRef.current?.emit(
      'player:survey-submitted',
      {
        playerId,
        playerSessionId,
        playerName: activePlayer?.name || selfJoinName,
        appsUsed: feedbackApps,
        aspectsWell,
        aspectsWellOther: feedbackWell.includes('__other_well__') ? trimmedWellOther : '',
        improvementsNeeded,
        improvementsOther: feedbackImprove.includes('__other_improve__') ? trimmedImproveOther : '',
        additionalSuggestions: feedbackSuggestions,
      },
      (response) => {
        setFeedbackSubmitting(false)
        if (!response?.ok) {
          setFeedbackError(response?.message || 'Unable to submit feedback right now.')
          return
        }
        setFeedbackDone(true)
      },
    )
  }

  const worldWidth = state.world?.width || DEFAULT_WORLD.width
  const worldHeight = state.world?.height || DEFAULT_WORLD.height
  const wordScale = Math.min(arenaSize.width / worldWidth, arenaSize.height / worldHeight)
  const eventName = state.event?.name ? `System Event: ${state.event.name}` : 'Nominal state'
  if (!isPlayerView) {
    return (
      <main className="app-shell host-screen">
        <header className="host-topbar">
          <div>
            <p className="label">Active Players</p>
            <p className="big">{state.players.length}/{state.maxPlayers || 20}</p>
          </div>
          <div>
            <p className="label">System State</p>
            <p className="event-name">{eventName}</p>
          </div>
          <div className="host-topbar-actions">
            <span className={connected ? 'status-pill status-live' : 'status-pill status-offline'}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
            <div className="mode-switch" role="group" aria-label="Performance mode">
              <button
                type="button"
                className={
                  state.performanceMode === 'standard' ? 'mode-btn active-mode' : 'mode-btn'
                }
                onClick={() => setPerformanceMode('standard')}
              >
                Standard
              </button>
              <button
                type="button"
                className={state.performanceMode === 'smooth' ? 'mode-btn active-mode' : 'mode-btn'}
                onClick={() => setPerformanceMode('smooth')}
              >
                Smooth
              </button>
            </div>
            <button type="button" className="reset-btn" onClick={resetGame}>
              Restart Match
            </button>
          </div>
        </header>

        <section className="host-grid">
          <article className="host-card leaderboard-card">
            <h2>Leaderboard</h2>
            <p className="subtle">Leader: {groupLead}</p>
            <ul className="leaderboard-list">
              {topPlayers.length === 0 ? (
                null
              ) : (
                topPlayers.map((player, index) => (
                  <li key={player.id}>
                    <span>
                      {index + 1}. {player.name}
                    </span>
                    <strong style={{ color: player.color }}>
                      {player.attempted ? player.score : 'No Attempt'}
                    </strong>
                  </li>
                ))
              )}
            </ul>
          </article>

          <article className="host-card live-card">
            <h2>Playing Live</h2>
            <ul className="live-list">
              {livePlayers.length === 0 ? (
                <li>No active players right now</li>
              ) : (
                livePlayers.map((player) => (
                  <li key={player.id}>
                    <span>{player.name}</span>
                  </li>
                ))
              )}
            </ul>
          </article>

          <article className="host-card qr-card">
            <h2>Scan to Join</h2>
            <div className="qr-frame" role="img" aria-label="QR code to open player game URL">
              <QRCodeSVG
                value={playerJoinLink}
                size={260}
                level="H"
                bgColor="#ffffff"
                fgColor="#0a0a0a"
                includeMargin
              />
            </div>
            <p className="subtle">Room: {state.roomId}</p>
            <p className="subtle">Players scan and join instantly.</p>
          </article>

          <article className="host-card instructions-card">
            <h2>How to Play</h2>
            <ol>
              <li>Scan the QR code</li>
              <li>Enter your name</li>
              <li>Read the current question</li>
              <li>Tap the correct floating answer option</li>
              <li>Wrong taps give 0 points</li>
            </ol>
            <p className="subtle">Current Question</p>
            <p className="question-preview">{state.question?.prompt || 'Loading question...'}</p>
            <p className="subtle">Active players: {state.players.length}</p>
          </article>
        </section>
      </main>
    )
  }

  if (activePlayer && !state.running && feedbackDone) {
    return (
      <main className="app-shell player-view">
        <div className="result-screen">
          <div className={`result-card ${rankProfile.className}`}>
            <div className="result-glow" />
            <div className={`rank-character ${rankProfile.className}`} aria-hidden="true">
              <div className="character-head" />
              <div className="character-body" />
            </div>
            <p className="result-rank-label">{rankProfile.label}</p>
            <p className="result-rank-num">#{activePlayerRank ?? '-'}</p>
            <p className="result-player-name">{activePlayer.name}</p>
            <div className="result-stats-row">
              <div className="result-stat">
                <span className="result-stat-value">{activePlayer.score ?? 0}</span>
                <span className="result-stat-key">Score</span>
              </div>
              <div className="result-stat-divider" />
              <div className="result-stat">
                <span className="result-stat-value">{sortedPlayers.length}</span>
                <span className="result-stat-key">Players</span>
              </div>
            </div>
            <p className="result-message">
              {activePlayer?.attempted
                ? rankProfile.message
                : 'No attempt recorded in this round. Score remains 0.'}
            </p>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="app-shell player-view">
      <section className="battle-zone-wrap">
        <div className="battle-zone">
          {!activePlayer && (
            <div className="player-join-overlay">
              <p className="join-title">Join This Round</p>
              <input
                className="player-join-input"
                type="text"
                value={selfJoinName}
                onChange={(event) => setSelfJoinName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') joinSelfInPlayerView()
                }}
                placeholder="Enter your name"
              />
              {joinError ? <p className="join-error">{joinError}</p> : null}
              <button type="button" className="player-join-btn" onClick={joinSelfInPlayerView}>
                Start Playing
              </button>
            </div>
          )}

          <div className="player-top-strip" aria-hidden="true">
            <div className="question-panel">Q: {state.question?.prompt || 'Syncing question...'}</div>
            <div className="player-stats-stack">
              <div className="stat-chip stat-timer">Time Left: {state.timeLeft}s</div>
              <div className="stat-chip stat-score">Score: {activePlayer?.score ?? 0}</div>
            </div>
          </div>

          <div className="word-field" ref={arenaRef}>
            {state.words.map((word) => {
              const faded = state.event?.id === 'visibility-drop' ? 0.48 : 1.0
              const tokenGradient = getTokenGradient(word)
              const leftPercent = (word.x / worldWidth) * 100
              const topPercent = (word.y / worldHeight) * 100
              return (
                <motion.button
                  type="button"
                  key={word.id}
                  className={`word token-${word.type} tier-${word.tier}`}
                  initial={false}
                  animate={{
                    left: `${leftPercent}%`,
                    top: `${topPercent}%`,
                    opacity: faded,
                  }}
                  transition={{
                    type: 'spring',
                    stiffness: isMobileDevice ? 96 : 130,
                    damping: isMobileDevice ? 17 : 21,
                    mass: 0.55,
                  }}
                  style={{
                    fontSize: `${Math.max(13, word.size * wordScale * (isMobileDevice ? 1.05 : 1.07))}px`,
                    ...tokenGradient,
                  }}
                  onClick={() => tapWord(word.id)}
                  disabled={!activePlayer || !state.running}
                >
                  {word.text}
                </motion.button>
              )
            })}
          </div>

          {activePlayer && !state.running && !feedbackDone ? (
            <div className="feedback-overlay">
              <div className="feedback-scroll">
                <h2 className="feedback-title">Application Usage &amp; Feedback Survey</h2>

                <fieldset className="feedback-group">
                  <legend>1. Which applications have you used? (Select all that apply)</legend>
                  {[
                    'OneConnect', 'V-Rewards', 'Pulse', 'Compass',
                    'Visitor Management System (VMS)', 'Contract Management System (CMS)',
                    'House of Ideas', 'MyAssets', 'eMbark',
                  ].map((app) => (
                    <label key={app} className="fb-check">
                      <input
                        type="checkbox"
                        checked={feedbackApps.includes(app)}
                        onChange={() => toggleFeedbackItem(feedbackApps, setFeedbackApps, app)}
                      />
                      {app}
                    </label>
                  ))}
                </fieldset>

                <fieldset className="feedback-group">
                  <legend>2. What aspects of these applications work well? (Select all that apply)</legend>
                  {[
                    'User-friendly interface (easy to navigate)',
                    'Helps improve efficiency / saves time',
                    'Reliable and stable performance',
                    'Availability of useful features',
                    'Good overall system performance',
                  ].map((opt) => (
                    <label key={opt} className="fb-check">
                      <input
                        type="checkbox"
                        checked={feedbackWell.includes(opt)}
                        onChange={() => toggleFeedbackItem(feedbackWell, setFeedbackWell, opt)}
                      />
                      {opt}
                    </label>
                  ))}
                  <label className="fb-check fb-other">
                    <input
                      type="checkbox"
                      checked={feedbackWell.includes('__other_well__')}
                      onChange={() => toggleFeedbackItem(feedbackWell, setFeedbackWell, '__other_well__')}
                    />
                    Other:
                    <input
                      className="fb-other-input"
                      type="text"
                      placeholder="Please specify"
                      value={feedbackWellOther}
                      onChange={(e) => setFeedbackWellOther(e.target.value)}
                    />
                  </label>
                </fieldset>

                <fieldset className="feedback-group">
                  <legend>3. What areas need improvement? (Select all that apply)</legend>
                  {[
                    'Performance issues (slow response, lag)',
                    'Complex or difficult to use',
                    'Missing or insufficient features',
                    'Bugs or technical errors',
                    'Limited relevance to my work needs',
                  ].map((opt) => (
                    <label key={opt} className="fb-check">
                      <input
                        type="checkbox"
                        checked={feedbackImprove.includes(opt)}
                        onChange={() => toggleFeedbackItem(feedbackImprove, setFeedbackImprove, opt)}
                      />
                      {opt}
                    </label>
                  ))}
                  <label className="fb-check fb-other">
                    <input
                      type="checkbox"
                      checked={feedbackImprove.includes('__other_improve__')}
                      onChange={() => toggleFeedbackItem(feedbackImprove, setFeedbackImprove, '__other_improve__')}
                    />
                    Other:
                    <input
                      className="fb-other-input"
                      type="text"
                      placeholder="Please specify"
                      value={feedbackImproveOther}
                      onChange={(e) => setFeedbackImproveOther(e.target.value)}
                    />
                  </label>
                </fieldset>

                <fieldset className="feedback-group">
                  <legend>4. Additional Feedback / Suggestions <span className="fb-optional">(Optional)</span></legend>
                  <p className="fb-hint">Please share any detailed feedback, suggestions, or experiences to help us improve these applications.</p>
                  <textarea
                    className="fb-textarea"
                    rows={4}
                    placeholder="Type your feedback here…"
                    value={feedbackSuggestions}
                    onChange={(e) => setFeedbackSuggestions(e.target.value)}
                  />
                </fieldset>

                {feedbackError ? <p className="fb-error">{feedbackError}</p> : null}
                <button
                  type="button"
                  className="fb-submit-btn"
                  onClick={submitFeedback}
                  disabled={feedbackSubmitting}
                >
                  {feedbackSubmitting ? 'Submitting...' : 'Submit & See My Result'}
                </button>
              </div>
            </div>
          ) : null}

        </div>
      </section>
    </main>
  )
}

export default App
