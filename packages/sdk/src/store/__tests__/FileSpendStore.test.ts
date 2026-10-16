import assert from 'node:assert/strict'
import { describe, it, after, before } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { FileSpendStore } from '../FileSpendStore.js'
import type { DailySpend, PendingReserve } from '../SpendStore.js'

let tmpDir: string

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spendstore-test-'))
})

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('FileSpendStore', () => {
  it('returns null when no file exists', async () => {
    const filePath = path.join(tmpDir, 'nonexistent.json')
    const store = new FileSpendStore(filePath)
    assert.equal(await store.read(), null)
  })

  it('round-trips a written accumulator', async () => {
    const filePath = path.join(tmpDir, 'roundtrip.json')
    const store = new FileSpendStore(filePath)
    const state: DailySpend = {
      date: '2026-06-26',
      totalMicros: '5000000',
      endpoints: { 'https://api.example.com': '2000000' },
    }
    await store.write(state)
    const read = await store.read()
    assert.deepEqual(read, state)
  })

  it('creates parent directories if they do not exist', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'spend.json')
    const store = new FileSpendStore(filePath)
    const state: DailySpend = {
      date: '2026-06-26',
      totalMicros: '1000000',
      endpoints: {},
    }
    await store.write(state)
    const read = await store.read()
    assert.deepEqual(read, state)
  })

  it('overwrites an existing file', async () => {
    const filePath = path.join(tmpDir, 'overwrite.json')
    const store = new FileSpendStore(filePath)
    const state1: DailySpend = {
      date: '2026-06-25',
      totalMicros: '100',
      endpoints: { 'https://a.com': '50' },
    }
    const state2: DailySpend = {
      date: '2026-06-26',
      totalMicros: '200',
      endpoints: { 'https://b.com': '150' },
    }
    await store.write(state1)
    await store.write(state2)
    const read = await store.read()
    assert.deepEqual(read, state2)
    assert.notDeepEqual(read, state1)
  })

  it('returns the file path', () => {
    const filePath = path.join(tmpDir, 'accessor.json')
    const store = new FileSpendStore(filePath)
    assert.equal(store.filePath, filePath)
  })

  it('satisfies the SpendStore interface', async () => {
    const filePath = path.join(tmpDir, 'interface.json')
    const store = new FileSpendStore(filePath)
    assert.equal(typeof store.read, 'function')
    assert.equal(typeof store.write, 'function')
  })

  it('throws on corrupted JSON file instead of silently returning null', async () => {
    const filePath = path.join(tmpDir, 'corrupt.json')
    await fs.writeFile(filePath, '{ not valid json', 'utf-8')
    const store = new FileSpendStore(filePath)
    // A corrupt file means the cap state is unknown — must throw, not return null,
    // so the caller fails closed rather than assuming zero spend.
    await assert.rejects(
      () => store.read(),
      (err: Error) => {
        assert.ok(err.message.includes('invalid JSON'), `Expected 'invalid JSON' in: ${err.message}`)
        return true
      },
    )
  })

  it('throws on a directory instead of a file (EISDIR)', async () => {
    const dirPath = path.join(tmpDir, 'is-dir')
    await fs.mkdir(dirPath, { recursive: true })
    const store = new FileSpendStore(dirPath)
    // EISDIR is not ENOENT — the file path exists but is unreadable as a file.
    await assert.rejects(
      () => store.read(),
      (err: Error) => {
        assert.ok(err.message.includes('Failed to read'), `Expected 'Failed to read' in: ${err.message}`)
        return true
      },
    )
  })

  it('leaves no window where the file is absent or partial (atomic write)', async () => {
    const filePath = path.join(tmpDir, 'atomic.json')
    const store = new FileSpendStore(filePath)
    const state: DailySpend = {
      date: '2026-06-26',
      totalMicros: '1000000',
      endpoints: { 'https://api.example.com': '500000' },
      pendingReserves: [],
    }
    await store.write(state)

    // The .tmp file must not exist after a successful write — it was renamed.
    await assert.rejects(
      () => fs.access(`${filePath}.tmp`),
      { code: 'ENOENT' },
      '.tmp file must not remain after write',
    )

    // The target file must contain valid JSON matching the written state.
    const read = await store.read()
    assert.deepEqual(read, state)
  })

  it('round-trips pendingReserves in DailySpend', async () => {
    const filePath = path.join(tmpDir, 'pending.json')
    const store = new FileSpendStore(filePath)
    const reserve: PendingReserve = {
      reserveId: 'reserve-123',
      amountMicros: '500000',
      endpointKey: 'https://api.example.com',
      timestamp: '2026-06-26T10:00:00.000Z',
    }
    const state: DailySpend = {
      date: '2026-06-26',
      totalMicros: '1000000',
      endpoints: {},
      pendingReserves: [reserve],
    }
    await store.write(state)
    const read = await store.read()
    assert.deepEqual(read, state)
    assert.equal(read?.pendingReserves.length, 1)
    assert.equal(read?.pendingReserves[0]?.reserveId, 'reserve-123')
  })

  it('simulates crash recovery: pending reserves survive store restart', async () => {
    const filePath = path.join(tmpDir, 'crash.json')
    const store1 = new FileSpendStore(filePath)
    const state: DailySpend = {
      date: '2026-06-26',
      totalMicros: '5000000',
      endpoints: { 'https://api.example.com': '2000000' },
      pendingReserves: [
        {
          reserveId: 'stale-reserve',
          amountMicros: '500000',
          endpointKey: 'https://api.example.com',
          timestamp: new Date(Date.now() - 200_000).toISOString(), // > 2 min ago
        },
        {
          reserveId: 'fresh-reserve',
          amountMicros: '100000',
          endpointKey: 'https://api.example.com',
          timestamp: new Date().toISOString(), // just now
        },
      ],
    }
    await store1.write(state)

    // Simulate a new store instance (process restart) reading the same file
    const store2 = new FileSpendStore(filePath)
    const recovered = await store2.read()
    assert.deepEqual(recovered, state)
    assert.equal(recovered?.pendingReserves.length, 2)
    // One stale (>2min), one fresh (<2min)
    const stale = recovered!.pendingReserves.filter(
      (r) => Date.now() - Date.parse(r.timestamp) > 120_000,
    )
    assert.equal(stale.length, 1)
    assert.equal(stale[0]?.reserveId, 'stale-reserve')
  })
})
