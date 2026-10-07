import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
import * as RTL from '@testing-library/react'
const { renderHook } = RTL
import { Keypair } from '@stellar/stellar-sdk'
import { useKikisAppClient } from '../useKikisAppClient.js'
import { KikisAppClient } from '../../client/KikisAppClient.js'

describe('useKikisAppClient', () => {
  it('returns a memoized KikisAppClient instance', () => {
    const secret = Keypair.random().secret()
    const { result, rerender } = renderHook(() =>
      useKikisAppClient({ wallet: secret, network: 'testnet' }),
    )
    const first = result.current

    rerender()

    assert.ok(first instanceof KikisAppClient)
    assert.equal(result.current, first, 'identity is stable across rerenders')
  })

  it('rebuilds when wallet changes', () => {
    const a = Keypair.random().secret()
    const b = Keypair.random().secret()
    const { result, rerender } = renderHook(
      ({ secret }: { secret: string }) =>
        useKikisAppClient({ wallet: secret, network: 'testnet' }),
      { initialProps: { secret: a } },
    )
    const first = result.current

    rerender({ secret: b })

    assert.notEqual(result.current, first)
  })
})
