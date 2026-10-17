import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ChannelSession, startOrderbookPush } from '../ChannelSession.js'
import type { ReconciliationStats } from '@kikis-app/kikis-app/provider/hono'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('startOrderbookPush — timer teardown on broken sockets', () => {
  it('pushes snapshots while the socket is open and stops on demand', async () => {
    const sent: string[] = []
    const socket = {
      readyState: 1,
      send: (data: string) => {
        sent.push(data)
      },
    }
    let fetches = 0
    const pusher = startOrderbookPush(
      socket,
      async () => ({ seq: ++fetches }),
      10,
    )

    await delay(45)
    pusher.stop()
    assert.ok(fetches >= 2, 'expected periodic pushes while the socket is open')
    assert.equal(sent.length, fetches)
    assert.equal(JSON.parse(sent[0]!).seq, 1, 'first push must fire immediately')

    const fetchesAfterStop = fetches
    await delay(40)
    assert.equal(fetches, fetchesAfterStop, 'stop() must tear the interval down')
  })

  it('stops polling when the socket is no longer open (abnormal disconnect, no onClose)', async () => {
    const socket = { readyState: 1, send: () => {} }
    let fetches = 0
    const pusher = startOrderbookPush(socket, async () => ({ seq: ++fetches }), 10)

    await delay(30)
    // Client vanished without a close frame — onClose will never fire.
    socket.readyState = 3

    // Let any in-flight push finish and the next tick detect the dead socket.
    await delay(30)
    const fetchesAfterDisconnect = fetches
    await delay(50)
    assert.equal(
      fetches,
      fetchesAfterDisconnect,
      'no phantom Horizon polling may continue after the socket dies',
    )
    pusher.stop()
  })

  it('stops polling when send() throws (broken pipe)', async () => {
    const socket = {
      readyState: 1,
      send: () => {
        throw new Error('broken pipe')
      },
    }
    let fetches = 0
    startOrderbookPush(socket, async () => ({ seq: ++fetches }), 10)

    await delay(50)
    assert.equal(fetches, 1, 'the interval must be torn down after the first failed send')
  })

  it('keeps polling after a transient fetch failure', async () => {
    const socket = { readyState: 1, send: () => {} }
    let fetches = 0
    const pusher = startOrderbookPush(
      socket,
      async () => {
        fetches++
        if (fetches === 1) throw new Error('Horizon responded 429')
        return { seq: fetches }
      },
      10,
    )

    await delay(45)
    pusher.stop()
    assert.ok(fetches >= 2, 'a Horizon blip must not permanently stop the stream')
  })

  it('never arms the interval when the socket is already closed', async () => {
    const socket = { readyState: 3, send: () => {} }
    let fetches = 0
    startOrderbookPush(socket, async () => ({ seq: ++fetches }), 10)

    await delay(30)
    assert.equal(fetches, 0)
  })
})

describe('ChannelSession — reconciliation mutex', () => {
  /**
   * Structural view of the Durable Object under test: reconcileSessions is
   * the real prototype method; runReconciliation is the overridable seam the
   * tests use to control how long a reconciliation cycle takes.
   */
  type Reconciler = {
    reconcileSessions: () => Promise<ReconciliationStats | null>
    runReconciliation: () => Promise<ReconciliationStats | null>
  }

  const completed: ReconciliationStats = {
    orphanedCount: 2,
    recoveredCount: 1,
    skippedCount: 0,
    failedCount: 0,
    alreadyClosedCount: 1,
    errors: [],
  }

  it('skips a run while the previous reconciliation is still in progress', async () => {
    const session = Object.create(ChannelSession.prototype) as unknown as Reconciler

    let releaseFirst: () => void = () => {}
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let runs = 0
    session.runReconciliation = async () => {
      runs++
      if (runs === 1) await firstRunGate
      return completed
    }

    // First cron trigger starts and is still running.
    const first = session.reconcileSessions()
    // Second (overlapping) trigger must be skipped, not queued behind the first.
    const second = await session.reconcileSessions()
    assert.equal(runs, 1, 'an overlapping trigger must not start a second reconciliation')
    assert.ok(second)
    assert.equal(second.recoveredCount, 0, 'the skipped run reports no work done')

    releaseFirst()
    const firstStats = await first
    assert.ok(firstStats)
    assert.equal(firstStats.recoveredCount, 1, 'the in-flight run completes normally')

    // Lock released — the next cron tick runs again.
    const third = await session.reconcileSessions()
    assert.equal(runs, 2)
    assert.ok(third)
    assert.equal(third.recoveredCount, 1)
  })

  it('releases the lock when a reconciliation fails', async () => {
    const session = Object.create(ChannelSession.prototype) as unknown as Reconciler

    let runs = 0
    session.runReconciliation = async () => {
      runs++
      if (runs === 1) throw new Error('rpc outage')
      return completed
    }

    await assert.rejects(() => session.reconcileSessions(), /rpc outage/)

    const stats = await session.reconcileSessions()
    assert.equal(runs, 2, 'a failed run must not leave the mutex stuck')
    assert.equal(stats?.recoveredCount, 1)
  })
})