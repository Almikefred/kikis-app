import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  wrapMppError,
  KikisAppError,
  KikisAppNetworkError,
  KikisAppSignatureError,
  KikisAppManifestError,
  KikisAppChannelStateError,
  KikisAppPolicyRejectError,
} from '../errors.js'

describe('wrapMppError', () => {
  it('passes through an error that is already a KikisAppError unchanged', () => {
    const original = new KikisAppManifestError('manifest error')
    const wrapped = wrapMppError(original, 'test-context')
    assert.strictEqual(wrapped, original)
  })

  it('wraps TypeError as KikisAppNetworkError (retryable: true)', () => {
    const err = new TypeError('fetch failed')
    const wrapped = wrapMppError(err, 'MPP charge request')
    assert.ok(wrapped instanceof KikisAppNetworkError)
    assert.equal(wrapped.code, 'NETWORK')
    assert.equal(wrapped.retryable, true)
    assert.equal(wrapped.cause, err)
    assert.ok(wrapped.message.includes('MPP charge request: TypeError: fetch failed'))
  })

  it('wraps AbortError as KikisAppNetworkError (retryable: true)', () => {
    const err = new Error('request aborted')
    err.name = 'AbortError'
    const wrapped = wrapMppError(err, 'Voucher request')
    assert.ok(wrapped instanceof KikisAppNetworkError)
    assert.equal(wrapped.code, 'NETWORK')
    assert.equal(wrapped.retryable, true)
    assert.equal(wrapped.cause, err)
  })

  it('preserves abort signal causes in wrapped KikisAppNetworkError', () => {
    const abortReason = new Error('user aborted operation')
    const err = new Error('The operation was aborted', { cause: abortReason })
    err.name = 'AbortError'
    const wrapped = wrapMppError(err, 'Credential creation')
    assert.ok(wrapped instanceof KikisAppNetworkError)
    assert.equal(wrapped.code, 'NETWORK')
    assert.equal(wrapped.retryable, true)
    assert.equal((wrapped.cause as Error)?.cause, abortReason)
  })

  it('wraps TimeoutError as KikisAppNetworkError (retryable: true)', () => {
    const err = new Error('request timed out')
    err.name = 'TimeoutError'
    const wrapped = wrapMppError(err, 'Voucher request')
    assert.ok(wrapped instanceof KikisAppNetworkError)
    assert.equal(wrapped.code, 'NETWORK')
    assert.equal(wrapped.retryable, true)
    assert.equal(wrapped.cause, err)
  })

  it('wraps Horizon RPC simulation timeout as KikisAppNetworkError (retryable: true)', () => {
    const err = new Error('Horizon RPC timeout during simulation')
    const wrapped = wrapMppError(err, 'Simulation')
    assert.ok(wrapped instanceof KikisAppNetworkError)
    assert.equal(wrapped.code, 'NETWORK')
    assert.equal(wrapped.retryable, true)
  })

  it('wraps Soroban RPC simulation failure as KikisAppChannelStateError (not KikisAppSignatureError)', () => {
    const err = new Error('Soroban RPC simulation failed: HostError Error(Contract, #1)')
    const wrapped = wrapMppError(err, 'MPP charge credential')
    assert.ok(wrapped instanceof KikisAppChannelStateError)
    assert.equal(wrapped.code, 'CHANNEL_STATE')
    assert.equal(wrapped.retryable, false)
    assert.ok(!(wrapped instanceof KikisAppSignatureError))
  })

  it('wraps sequence mismatch / tx_bad_seq as KikisAppChannelStateError', () => {
    const err = new Error('Transaction simulation failed: tx_bad_seq')
    const wrapped = wrapMppError(err, 'MPP charge credential')
    assert.ok(wrapped instanceof KikisAppChannelStateError)
    assert.equal(wrapped.code, 'CHANNEL_STATE')
    assert.equal(wrapped.retryable, false)
  })

  it('wraps underfunded account or insufficient balance as KikisAppPolicyRejectError', () => {
    const err = new Error('Simulation failed: account underfunded for payment')
    const wrapped = wrapMppError(err, 'MPP charge credential')
    assert.ok(wrapped instanceof KikisAppPolicyRejectError)
    assert.equal(wrapped.code, 'POLICY_REJECT')
    assert.equal(wrapped.retryable, false)
  })

  it('wraps signing / challenge parsing errors as KikisAppSignatureError (retryable: false)', () => {
    const err = new Error('bad challenge')
    const wrapped = wrapMppError(err, 'MPP charge request')
    assert.ok(wrapped instanceof KikisAppSignatureError)
    assert.equal(wrapped.code, 'SIGNATURE')
    assert.equal(wrapped.retryable, false)
    assert.equal(wrapped.cause, err)
    assert.ok(wrapped.message.includes('MPP charge request: Error: bad challenge'))
  })
})
