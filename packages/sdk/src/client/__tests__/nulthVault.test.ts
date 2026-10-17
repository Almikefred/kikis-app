/**
 * Nulth ZK vault integration tests — no live chain or x402 settlement.
 */

import assert from 'node:assert/strict'
import { Address, Networks, hash, nativeToScVal, xdr, Keypair } from '@stellar/stellar-sdk'
import {
  assertNulthVaultManifest,
  prepareNulthSigner,
  createPolicyState,
  paymentContextFromManifest,
} from '../NulthVault.js'
import type { KikisAppManifest } from '../../types.js'
import { KikisAppManifestError, KikisAppVaultConfigError, KikisAppPolicyRejectError } from '../../errors.js'
import { decodeAuthSignature, NulthPolicyError } from '../NulthVault.js'
import { resolvePayee } from '../../internal/payee.js'
import { KikisAppClient } from '../KikisAppClient.js'
import { InMemorySpendStore } from '../../store/SpendStore.js'

const NULTH = 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT'
const PAYEE = 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK'
const OTHER_PAYEE = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const OTHER_ASSET = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

/** Build a real Soroban authorization preimage for a SEP-41 `transfer` call. */
function transferPreimage(asset: string, from: string, to: string, amount: bigint): string {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(asset).toScAddress(),
        functionName: 'transfer',
        args: [
          nativeToScVal(from, { type: 'address' }),
          nativeToScVal(to, { type: 'address' }),
          nativeToScVal(amount, { type: 'i128' }),
        ],
      }),
    ),
    subInvocations: [],
  })
  return xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(Networks.TESTNET)),
      nonce: xdr.Int64.fromString('1'),
      signatureExpirationLedger: 300,
      invocation,
    }),
  ).toXDR('base64')
}

const baseManifest: KikisAppManifest = {
  'kikis-app': '1.0',
  name: 'Nulth Test Provider',
  description: 'ZK vault test',
  modes: ['x402'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: USDC,
  payee: PAYEE,
  pricing: {
    x402: {
      amount: '0.001',
      per: 'request',
      facilitator: 'https://channels.openzeppelin.com/x402/testnet',
    },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
  vault: 'nulth',
  nulth_account: NULTH,
}

assertNulthVaultManifest(baseManifest, NULTH)

assert.throws(
  () => assertNulthVaultManifest({ ...baseManifest, vault: 'agent-vault' }, NULTH),
  KikisAppManifestError,
)

const vault = {
  mode: 'nulth' as const,
  nulthAccount: NULTH,
  witnessSecret: 'witness',
  allowedPayees: [PAYEE],
  dailyCapUsdc: '1.00',
}

const { signer } = await prepareNulthSigner(
  vault,
  baseManifest,
  'x402',
  'testnet',
  100_000,
)
assert.equal(signer.address, NULTH)

// 0.001 USDC == 10_000 stroops, matching baseManifest.pricing.x402.amount
const signed = await signer.signAuthEntry(
  transferPreimage(USDC, NULTH, PAYEE, 10_000n),
)
const decoded = decodeAuthSignature(signed.signedAuthEntry)
assert.equal(decoded.proof.version, 1)
assert.doesNotMatch(decoded.proof.publicInputs.payeeHash, new RegExp(PAYEE.slice(4)))
assert.notEqual(decoded.proof.publicInputs.capCommitment, '1.00')
assert.notEqual(decoded.proof.publicInputs.allowlistCommitment, PAYEE)

console.log('✓ Nulth ZK vault SDK integration PASSED')

{
  const vault = {
    mode: 'nulth' as const,
    nulthAccount: NULTH,
    witnessSecret: 'witness',
    allowedPayees: [PAYEE],
    dailyCapUsdc: '1.00',
  }

  const manifest: KikisAppManifest = { ...baseManifest, network: 'mainnet' }

  await assert.rejects(
    () => prepareNulthSigner(vault, manifest, 'x402', 'mainnet', 100_000),
    (err: unknown) =>
      err instanceof KikisAppVaultConfigError &&
      (err as KikisAppVaultConfigError).code === 'VAULT_CONFIG' &&
      /mock prover/i.test(err.message),
  )
  console.log('✓ mainnet guard rejects mock prover')
}

{
  const vault = {
    mode: 'nulth' as const,
    nulthAccount: NULTH,
    witnessSecret: 'witness',
    allowedPayees: [PAYEE],
    dailyCapUsdc: '1.00',
  }

  for (const network of [undefined, 'pubnet'] as const) {
    await assert.rejects(
      () =>
        prepareNulthSigner(
          vault,
          baseManifest,
          'x402',
          network as unknown as 'testnet' | 'mainnet',
          100_000,
        ),
      (err: unknown) =>
        err instanceof KikisAppVaultConfigError &&
        (err as KikisAppVaultConfigError).code === 'VAULT_CONFIG' &&
        /network must be 'testnet'/.test(err.message),
      `prepareNulthSigner must reject network=${String(network)}`,
    )
  }
  console.log('✓ prepareNulthSigner fails closed for missing/misspelled network')
}

// ── signAuthEntry rejects an auth entry that doesn't match the payment context ──

{
  const isMismatch = (err: unknown) =>
    err instanceof NulthPolicyError && err.code === 'auth_entry_mismatch'

  async function freshSigner() {
    const { signer } = await prepareNulthSigner(vault, baseManifest, 'x402', 'testnet', 100_000)
    return signer
  }

  // wrong `to` (payee)
  await assert.rejects(
    () => freshSigner().then((s) => s.signAuthEntry(transferPreimage(USDC, NULTH, OTHER_PAYEE, 10_000n))),
    isMismatch,
    'rejects when the preimage payee differs from paymentContext.payee',
  )

  // wrong amount, higher
  await assert.rejects(
    () => freshSigner().then((s) => s.signAuthEntry(transferPreimage(USDC, NULTH, PAYEE, 10_000_000_000n))),
    isMismatch,
    'rejects when the amount is higher than paymentContext.amountStroops',
  )

  // wrong amount, lower
  await assert.rejects(
    () => freshSigner().then((s) => s.signAuthEntry(transferPreimage(USDC, NULTH, PAYEE, 1n))),
    isMismatch,
    'rejects when the amount is lower than paymentContext.amountStroops',
  )

  // wrong contract
  await assert.rejects(
    () => freshSigner().then((s) => s.signAuthEntry(transferPreimage(OTHER_ASSET, NULTH, PAYEE, 10_000n))),
    isMismatch,
    'rejects when the invoked contract differs from paymentContext.assetContract',
  )

  // wrong `from`
  await assert.rejects(
    () => freshSigner().then((s) => s.signAuthEntry(transferPreimage(USDC, OTHER_PAYEE, PAYEE, 10_000n))),
    isMismatch,
    'rejects when the from argument differs from nulthAccount',
  )

  // wrong function name
  {
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(USDC).toScAddress(),
          functionName: 'approve',
          args: [
            nativeToScVal(NULTH, { type: 'address' }),
            nativeToScVal(PAYEE, { type: 'address' }),
            nativeToScVal(10_000n, { type: 'i128' }),
          ],
        }),
      ),
      subInvocations: [],
    })
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(Networks.TESTNET)),
        nonce: xdr.Int64.fromString('1'),
        signatureExpirationLedger: 300,
        invocation,
      }),
    ).toXDR('base64')

    await assert.rejects(
      () => freshSigner().then((s) => s.signAuthEntry(preimage)),
      isMismatch,
      'rejects when the function name is not transfer',
    )
  }

  // sub-invocations present
  {
    const subInvocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(USDC).toScAddress(),
          functionName: 'transfer',
          args: [
            nativeToScVal(NULTH, { type: 'address' }),
            nativeToScVal(PAYEE, { type: 'address' }),
            nativeToScVal(10_000n, { type: 'i128' }),
          ],
        }),
      ),
      subInvocations: [],
    })
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(USDC).toScAddress(),
          functionName: 'transfer',
          args: [
            nativeToScVal(NULTH, { type: 'address' }),
            nativeToScVal(PAYEE, { type: 'address' }),
            nativeToScVal(10_000n, { type: 'i128' }),
          ],
        }),
      ),
      subInvocations: [subInvocation],
    })
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(Networks.TESTNET)),
        nonce: xdr.Int64.fromString('1'),
        signatureExpirationLedger: 300,
        invocation,
      }),
    ).toXDR('base64')

    await assert.rejects(
      () => freshSigner().then((s) => s.signAuthEntry(preimage)),
      isMismatch,
      'rejects when the invocation has sub-invocations',
    )
  }

  // not a HashIdPreimage / envelopeTypeSorobanAuthorization at all
  await assert.rejects(
    () => freshSigner().then((s) => s.signAuthEntry(Buffer.from('route-dock-auth-entry').toString('base64'))),
    isMismatch,
    'rejects a plain non-XDR string',
  )

  console.log('✓ signAuthEntry rejects auth entries that mismatch the payment context')
}

// ── A rejected entry never advances daily spend ──────────────────────────────

{
  const tightVault = {
    mode: 'nulth' as const,
    nulthAccount: NULTH,
    witnessSecret: 'witness',
    allowedPayees: [PAYEE],
    dailyCapUsdc: '0.001',
  }
  const { signer } = await prepareNulthSigner(tightVault, baseManifest, 'x402', 'testnet', 100_000)

  await assert.rejects(
    () => signer.signAuthEntry(transferPreimage(USDC, NULTH, OTHER_PAYEE, 10_000n)),
    (err: unknown) => err instanceof NulthPolicyError && err.code === 'auth_entry_mismatch',
  )

  // Cap equals the context amount (0.001 USDC == 10_000 stroops) — the
  // mismatched attempt above must not have spent it.
  const result = await signer.signAuthEntry(transferPreimage(USDC, NULTH, PAYEE, 10_000n))
  const decoded = decodeAuthSignature(result.signedAuthEntry)
  assert.equal(decoded.proof.publicInputs.amountStroops, '10000')
  console.log('✓ a rejected sign attempt leaves daily spend unchanged')
}

// --- usdcToStroops validation tests ---

function manifestWithPrice(amount: string): KikisAppManifest {
  const pricing = { ...baseManifest.pricing! }
  pricing.x402 = { ...baseManifest.pricing!.x402!, amount }
  return { ...baseManifest, pricing }
}

const INVALID_AMOUNTS = ['-5', '-1.5', '', '1.123456789', '0.00000009']

for (const amount of INVALID_AMOUNTS) {
  assert.throws(
    () => createPolicyState({ dailyCapUsdc: amount, allowedPayees: [PAYEE], witnessSecret: 'witness' }),
    RangeError,
  )
  assert.throws(
    () => paymentContextFromManifest(
      { payee: PAYEE, asset_contract: baseManifest.asset_contract, pricing: { x402: { amount } } },
      'x402',
      100_000,
    ),
    RangeError,
  )
}
console.log('✓ invalid amounts throw RangeError')

{
  const policy = createPolicyState({ dailyCapUsdc: '1.00', allowedPayees: [PAYEE], witnessSecret: 'witness' })
  assert.equal(policy.dailyCapStroops, 10_000_000n)
}
{
  const ctx = paymentContextFromManifest(
    { payee: PAYEE, asset_contract: baseManifest.asset_contract, pricing: { x402: { amount: '0.001' } } },
    'x402',
    100_000,
  )
  assert.equal(ctx.amountStroops, 10_000n)
}
console.log('✓ valid amounts produce correct stroops')

await assert.rejects(
  () => prepareNulthSigner(vault, manifestWithPrice('-1'), 'x402', 'testnet', 100_000),
  RangeError,
)
console.log('✓ prepareNulthSigner rejects negative price')

{
  const vaultWithExpiry = {
    ...vault,
    expiryLedger: 10,
  }
  const { signer } = await prepareNulthSigner(
    vaultWithExpiry,
    baseManifest,
    'x402',
    'testnet',
    Number.NaN,
  )
  await assert.rejects(
    () =>
      signer.signAuthEntry(
        transferPreimage(USDC, NULTH, PAYEE, 10_000n),
      ),
    RangeError,
  )
  console.log('✓ prepareNulthSigner rejects NaN ledger on signing with RangeError')
}

// ── per-mode payee override: context must match the address providers charge ──

{
  const manifestWithOverride: KikisAppManifest = {
    ...baseManifest,
    payee: PAYEE,
    pricing: {
      ...baseManifest.pricing!,
      x402: { ...baseManifest.pricing!.x402!, payee: OTHER_PAYEE },
      'mpp-charge': {
        amount: '0.001',
        per: 'request',
        facilitator: 'https://channels.openzeppelin.com/x402/testnet',
        payee: OTHER_PAYEE,
      },
    },
  }

  const manifestNoOverride: KikisAppManifest = {
    ...baseManifest,
    payee: PAYEE,
    pricing: {
      ...baseManifest.pricing!,
      'mpp-charge': {
        amount: '0.001',
        per: 'request',
        facilitator: 'https://channels.openzeppelin.com/x402/testnet',
      },
    },
  }

  // Allowlisting the override address — the one providers actually charge — signs.
  {
    const vaultWithOverride = { ...vault, allowedPayees: [OTHER_PAYEE] }
    const { signer } = await prepareNulthSigner(
      vaultWithOverride,
      manifestWithOverride,
      'x402',
      'testnet',
      100_000,
    )
    await signer.signAuthEntry(transferPreimage(USDC, NULTH, OTHER_PAYEE, 10_000n))
    console.log('✓ allowlisting the per-mode override address signs')
  }

  // Allowlisting only the top-level payee rejects: the preimage targets the
  // override, which this vault does not list.
  {
    const { signer } = await prepareNulthSigner(
      { ...vault, allowedPayees: [PAYEE] },
      manifestWithOverride,
      'x402',
      'testnet',
      100_000,
    )
    await assert.rejects(
      () => signer.signAuthEntry(transferPreimage(USDC, NULTH, OTHER_PAYEE, 10_000n)),
      (err: unknown) => err instanceof NulthPolicyError && err.code === 'payee_not_allowed',
    )
    console.log('✓ allowlisting only the top-level payee rejects')
  }

  // The context agrees with resolvePayee for both modes, override and fallback.
  for (const manifest of [manifestWithOverride, manifestNoOverride]) {
    for (const mode of ['x402', 'mpp-charge'] as const) {
      assert.equal(
        paymentContextFromManifest(manifest, mode, 100_000).payee,
        resolvePayee(manifest, mode),
        `${mode} context payee must match resolvePayee`,
      )
    }
  }
  console.log('✓ paymentContextFromManifest matches resolvePayee for both modes')
}

// ── mpp-charge payment mode with Nulth vault (#34) ──

{
  // Self-signed payee keypair so the local manifest server serves a verifiable
  // document. Nulth allowlists authorize PAYEE, so keep the manifest payee on
  // that value via a deterministic keypair derived from it.
  const { Keypair: StellarKeypair } = await import('@stellar/stellar-sdk')
  const { signManifest } = await import('../../manifest/sign.js')
  const payeeKp = StellarKeypair.random()
  const mppChargeManifest = signManifest(
    {
      ...baseManifest,
      payee: payeeKp.publicKey(),
      modes: ['mpp-charge'],
      pricing: {
        'mpp-charge': {
          amount: '0.0005',
          per: 'request',
        },
      },
    },
    payeeKp.secret(),
  )
  const allowedPayee = payeeKp.publicKey()

  // 1. prepareNulthSigner builds valid Soroban auth context for mpp-charge
  const vaultForMppCharge = { ...vault, allowedPayees: [allowedPayee] }
  const { signer, config } = await prepareNulthSigner(
    vaultForMppCharge,
    mppChargeManifest,
    'mpp-charge',
    'testnet',
    100_000,
  )
  assert.equal(signer.address, NULTH)
  assert.equal(config.paymentContext?.amountStroops, 5_000n)
  const signed = await signer.signAuthEntry(
    transferPreimage(USDC, NULTH, allowedPayee, 5_000n),
  )
  const decoded = decodeAuthSignature(signed.signedAuthEntry)
  assert.equal(decoded.proof.publicInputs.amountStroops, '5000')
  console.log('✓ prepareNulthSigner supports mpp-charge mode')

  // 2. KikisAppClient.pay executes mpp-charge with Nulth vault and commits spend cap.
  // Serve the manifest from a local HTTP server: `_resolveManifest` is a
  // TS-private method so it cannot be stubbed per-instance from a test.
  const { createServer } = await import('node:http')
  const manifestServer = createServer((req, res) => {
    if (req.url === '/.well-known/kikis-app.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(mppChargeManifest))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => manifestServer.listen(0, '127.0.0.1', resolve))
  const manifestPort = (manifestServer.address() as { port: number }).port
  const providerUrl = `http://127.0.0.1:${manifestPort}/infer`

  try {
    const spendStore = new InMemorySpendStore({ warn: false })
    const payerKp = Keypair.random()
    const client = new KikisAppClient({
      wallet: payerKp,
      network: 'testnet',
      spendCap: { daily: '0.01', asset: 'USDC', decimals: 7 },
      spendStore,
      vault: {
        mode: 'nulth',
        nulthAccount: NULTH,
        witnessSecret: 'witness',
        allowedPayees: [allowedPayee],
        dailyCapUsdc: '1.00',
      },
    })

    // Seed trustline cache so Horizon isn't queried
    ;(KikisAppClient as unknown as { _trustlineCache: Map<string, unknown> })._trustlineCache.set(
      `testnet:${payerKp.publicKey()}:USDC`,
      { exists: true, expiresAt: Date.now() + 300_000 },
    )

    type ChargeStub = {
      withSigner: (s: unknown) => {
        pay: (
          url: string,
          manifest: KikisAppManifest,
          options?: { forceMode?: 'mpp-charge' },
        ) => Promise<{
          data: { result: string }
          txHash: string
          mode: 'mpp-charge'
          amount: string
          timestamp: number
        }>
      }
    }
    let capturedSigner: unknown = null
    let chargePayCalls = 0
    ;(client as unknown as { charge: ChargeStub }).charge = {
      withSigner: (s: unknown) => {
        capturedSigner = s
        return {
          pay: async () => {
            chargePayCalls++
            return {
              data: { result: 'canned-response' },
              txHash: '0x123abc',
              mode: 'mpp-charge' as const,
              amount: '0.0005',
              timestamp: Date.now(),
            }
          },
        }
      },
    }

    const result = await client.pay(providerUrl, { forceMode: 'mpp-charge' })
    assert.equal(result.mode, 'mpp-charge')
    assert.equal(result.amount, '0.0005')
    assert.equal(chargePayCalls, 1)
    assert.ok(capturedSigner && (capturedSigner as { address: string }).address === NULTH)

    const spendAfterSuccess = await spendStore.read()
    assert.ok(spendAfterSuccess)
    assert.equal(spendAfterSuccess.totalMicros, '5000', 'spend cap must commit 0.0005 USDC (5000 micros)')
    console.log('✓ client.pay mpp-charge succeeds with Nulth vault and commits spend cap')

    // 3. Nulth policy rejection properly rolls back and releases spend reservation.
    // The allowlist is enforced when the charge sub-client signs (not during
    // prepare), so trigger the rejection through a failing charge stub with an
    // isolated spend store.
    const rejectStore = new InMemorySpendStore({ warn: false })
    const clientReject = new KikisAppClient({
      wallet: payerKp,
      network: 'testnet',
      spendCap: { daily: '0.01', asset: 'USDC', decimals: 7 },
      spendStore: rejectStore,
      vault: {
        mode: 'nulth',
        nulthAccount: NULTH,
        witnessSecret: 'witness',
        allowedPayees: [allowedPayee],
        dailyCapUsdc: '1.00',
      },
    })
    // Seed trustline cache so Horizon isn't queried
    ;(KikisAppClient as unknown as { _trustlineCache: Map<string, unknown> })._trustlineCache.set(
      `testnet:${payerKp.publicKey()}:USDC`,
      { exists: true, expiresAt: Date.now() + 300_000 },
    )
    ;(clientReject as unknown as { charge: ChargeStub }).charge = {
      withSigner: () => ({
        pay: async () => {
          throw new KikisAppPolicyRejectError('payee_not_allowlisted')
        },
      }),
    }

    await assert.rejects(
      () => clientReject.pay(providerUrl, { forceMode: 'mpp-charge' }),
      (err: unknown) => err instanceof KikisAppPolicyRejectError && err.code === 'POLICY_REJECT',
    )

    const spendAfterRejection = await rejectStore.read()
    assert.ok(spendAfterRejection)
    assert.equal(spendAfterRejection.totalMicros, '0', 'rejected payment must roll back spend reservation')
    console.log('✓ Nulth policy rejection releases spend reservation')
  } finally {
    await new Promise<void>((resolve) => manifestServer.close(() => resolve()))
  }
}
