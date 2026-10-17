/**
 * Comprehensive test suite for Nulth auth context validation, preimage tampering,
 * multi-asset mismatch rejection, non-transfer contract calls, and edge boundaries.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Address, Networks, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import {
  prepareNulthSigner,
  assertAuthEntryMatchesContext,
  decodeAuthSignature,
  NulthPolicyError,
  dayBucket,
  type PaymentAuthContext,
  type NulthVaultConfig,
} from '../NulthVault.js'
import type { KikisAppManifest } from '../../types.js'

const NULTH_ACCOUNT = 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT'
const PAYEE_USDC = 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK'
const PAYEE_EURC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const EURC_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const XLM_CONTRACT = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'
const WITNESS_SECRET = 'multi-asset-test-witness'

function buildTransferPreimage(
  contractAddress: string,
  from: string,
  to: string,
  amount: bigint,
  options: {
    functionName?: string
    args?: xdr.ScVal[]
    subInvocations?: xdr.SorobanAuthorizedInvocation[]
    networkPassphrase?: string
    signatureExpirationLedger?: number
    nonce?: string
  } = {},
): string {
  const fnName = options.functionName ?? 'transfer'
  const args =
    options.args ?? [
      nativeToScVal(from, { type: 'address' }),
      nativeToScVal(to, { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
    ]

  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractAddress).toScAddress(),
        functionName: fnName,
        args,
      }),
    ),
    subInvocations: options.subInvocations ?? [],
  })

  return xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(options.networkPassphrase ?? Networks.TESTNET)),
      nonce: xdr.Int64.fromString(options.nonce ?? '1'),
      signatureExpirationLedger: options.signatureExpirationLedger ?? 500,
      invocation,
    }),
  ).toXDR('base64')
}

describe('Nulth Auth Context & Preimage Verification (#21)', () => {
  const vaultConfig: NulthVaultConfig = {
    mode: 'nulth',
    nulthAccount: NULTH_ACCOUNT,
    witnessSecret: WITNESS_SECRET,
    allowedPayees: [PAYEE_USDC, PAYEE_EURC],
    dailyCapUsdc: '50.00',
  }

  const multiAssetManifest: KikisAppManifest = {
    'kikis-app': '1.0',
    name: 'Multi-Asset Test Provider',
    description: 'Provider supporting USDC and EURC',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: USDC_CONTRACT,
    payee: PAYEE_USDC,
    assets: [
      { asset: 'USDC', asset_contract: USDC_CONTRACT },
      { asset: 'EURC', asset_contract: EURC_CONTRACT },
    ],
    pricing: {
      x402: {
        amount: '1.00',
        per: 'request',
        facilitator: 'https://channels.openzeppelin.com/x402/testnet',
      },
    },
    endpoints: { query: { method: 'GET', path: '/query' } },
    tags: ['multi-asset'],
    vault: 'nulth',
    nulth_account: NULTH_ACCOUNT,
  }

  describe('Multi-asset contract address mismatch rejections', () => {
    it('rejects auth preimage targeting a different asset contract than declared in manifest', async () => {
      const { signer } = await prepareNulthSigner(
        vaultConfig,
        multiAssetManifest,
        'x402',
        'testnet',
        100_000,
      )

      // Preimage attempts to charge EURC while manifest context declared USDC
      const eurcPreimage = buildTransferPreimage(
        EURC_CONTRACT,
        NULTH_ACCOUNT,
        PAYEE_USDC,
        10_000_000n,
      )

      await assert.rejects(
        () => signer.signAuthEntry(eurcPreimage),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /does not match assetContract/i)
          return true
        },
      )
    })

    it('rejects auth preimage targeting an undeclared third asset (XLM contract)', async () => {
      const { signer } = await prepareNulthSigner(
        vaultConfig,
        multiAssetManifest,
        'x402',
        'testnet',
        100_000,
      )

      const xlmPreimage = buildTransferPreimage(
        XLM_CONTRACT,
        NULTH_ACCOUNT,
        PAYEE_USDC,
        10_000_000n,
      )

      await assert.rejects(
        () => signer.signAuthEntry(xlmPreimage),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, new RegExp(XLM_CONTRACT))
          return true
        },
      )
    })

    it('assertAuthEntryMatchesContext rejects mismatched contract address directly', () => {
      const authEntry = buildTransferPreimage(
        EURC_CONTRACT,
        NULTH_ACCOUNT,
        PAYEE_USDC,
        5_000_000n,
      )

      assert.throws(
        () =>
          assertAuthEntryMatchesContext(authEntry, NULTH_ACCOUNT, {
            payee: PAYEE_USDC,
            amountStroops: 5_000_000n,
            assetContract: USDC_CONTRACT,
            ledgerSequence: 100_000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /does not match assetContract/)
          return true
        },
      )
    })

    it('signs successfully when asset contract matches declared context', async () => {
      const { signer } = await prepareNulthSigner(
        vaultConfig,
        multiAssetManifest,
        'x402',
        'testnet',
        100_000,
      )

      const validUsdcPreimage = buildTransferPreimage(
        USDC_CONTRACT,
        NULTH_ACCOUNT,
        PAYEE_USDC,
        10_000_000n,
      )

      const signed = await signer.signAuthEntry(validUsdcPreimage)
      const decoded = decodeAuthSignature(signed.signedAuthEntry)
      assert.equal(decoded.nulth, 'zk-v1')
      assert.equal(decoded.proof.publicInputs.amountStroops, '10000000')
      assert.equal(decoded.proof.publicInputs.dayBucket, String(dayBucket(100_000)))
    })
  })

  describe('Non-transfer contract function calls', () => {
    it('rejects contract functions with "approve" name', async () => {
      const { signer } = await prepareNulthSigner(
        vaultConfig,
        multiAssetManifest,
        'x402',
        'testnet',
        100_000,
      )

      const approvePreimage = buildTransferPreimage(
        USDC_CONTRACT,
        NULTH_ACCOUNT,
        PAYEE_USDC,
        10_000_000n,
        { functionName: 'approve' },
      )

      await assert.rejects(
        () => signer.signAuthEntry(approvePreimage),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /does not match expected transfer/i)
          return true
        },
      )
    })

    it('rejects contract functions with "transfer_from", "mint", or "burn"', () => {
      const ctx: Omit<PaymentAuthContext, 'authEntry'> = {
        payee: PAYEE_USDC,
        amountStroops: 10_000_000n,
        assetContract: USDC_CONTRACT,
        ledgerSequence: 100_000,
      }

      for (const fn of ['transfer_from', 'mint', 'burn', 'clawback', 'set_admin']) {
        const preimage = buildTransferPreimage(
          USDC_CONTRACT,
          NULTH_ACCOUNT,
          PAYEE_USDC,
          10_000_000n,
          { functionName: fn },
        )

        assert.throws(
          () => assertAuthEntryMatchesContext(preimage, NULTH_ACCOUNT, ctx),
          (err: unknown) => {
            assert.ok(err instanceof NulthPolicyError)
            assert.equal(err.code, 'auth_entry_mismatch')
            assert.match(err.message, new RegExp(fn))
            return true
          },
        )
      }
    })

    it('rejects non-contract authorized function types (e.g. host functions)', () => {
      const ctx: Omit<PaymentAuthContext, 'authEntry'> = {
        payee: PAYEE_USDC,
        amountStroops: 10_000_000n,
        assetContract: USDC_CONTRACT,
        ledgerSequence: 100_000,
      }

      const invocation = new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
          new xdr.CreateContractArgs({
            contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
              new xdr.ContractIdPreimageFromAddress({
                address: Address.fromString(NULTH_ACCOUNT).toScAddress(),
                salt: Buffer.alloc(32),
              }),
            ),
            executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)),
          }),
        ),
        subInvocations: [],
      })

      const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId: hash(Buffer.from(Networks.TESTNET)),
          nonce: xdr.Int64.fromString('1'),
          signatureExpirationLedger: 500,
          invocation,
        }),
      ).toXDR('base64')

      assert.throws(
        () => assertAuthEntryMatchesContext(preimage, NULTH_ACCOUNT, ctx),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /does not invoke a contract function/i)
          return true
        },
      )
    })
  })

  describe('Sub-invocation rejection', () => {
    it('rejects an invocation containing single child sub-invocations', async () => {
      const { signer } = await prepareNulthSigner(
        vaultConfig,
        multiAssetManifest,
        'x402',
        'testnet',
        100_000,
      )

      const childInvocation = new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(USDC_CONTRACT).toScAddress(),
            functionName: 'transfer',
            args: [
              nativeToScVal(NULTH_ACCOUNT, { type: 'address' }),
              nativeToScVal(PAYEE_USDC, { type: 'address' }),
              nativeToScVal(1_000n, { type: 'i128' }),
            ],
          }),
        ),
        subInvocations: [],
      })

      const preimage = buildTransferPreimage(
        USDC_CONTRACT,
        NULTH_ACCOUNT,
        PAYEE_USDC,
        10_000_000n,
        { subInvocations: [childInvocation] },
      )

      await assert.rejects(
        () => signer.signAuthEntry(preimage),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /unexpected sub-invocations/i)
          return true
        },
      )
    })

    it('rejects deeply nested sub-invocations', () => {
      const ctx: Omit<PaymentAuthContext, 'authEntry'> = {
        payee: PAYEE_USDC,
        amountStroops: 10_000_000n,
        assetContract: USDC_CONTRACT,
        ledgerSequence: 100_000,
      }

      const grandChild = new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(USDC_CONTRACT).toScAddress(),
            functionName: 'transfer',
            args: [],
          }),
        ),
        subInvocations: [],
      })

      const child = new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(USDC_CONTRACT).toScAddress(),
            functionName: 'transfer',
            args: [],
          }),
        ),
        subInvocations: [grandChild],
      })

      const preimage = buildTransferPreimage(
        USDC_CONTRACT,
        NULTH_ACCOUNT,
        PAYEE_USDC,
        10_000_000n,
        { subInvocations: [child] },
      )

      assert.throws(
        () => assertAuthEntryMatchesContext(preimage, NULTH_ACCOUNT, ctx),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /unexpected sub-invocations/i)
          return true
        },
      )
    })
  })

  describe('Preimage tampering & malformed structure', () => {
    const ctx: Omit<PaymentAuthContext, 'authEntry'> = {
      payee: PAYEE_USDC,
      amountStroops: 10_000_000n,
      assetContract: USDC_CONTRACT,
      ledgerSequence: 100_000,
    }

    it('rejects non-base64 or malformed XDR string', () => {
      assert.throws(
        () => assertAuthEntryMatchesContext('not-valid-base64!@#$', NULTH_ACCOUNT, ctx),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /does not decode as a HashIdPreimage/i)
          return true
        },
      )
    })

    it('rejects empty or corrupt base64 payload', () => {
      const corruptBase64 = Buffer.from('corrupt binary payload').toString('base64')
      assert.throws(
        () => assertAuthEntryMatchesContext(corruptBase64, NULTH_ACCOUNT, ctx),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          return true
        },
      )
    })

    it('rejects non-SorobanAuthorization preimage envelope type', () => {
      // Build a HashIdPreimage with envelopeTypeContractId
      const contractIdPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
        new xdr.HashIdPreimageContractId({
          networkId: hash(Buffer.from(Networks.TESTNET)),
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
            new xdr.ContractIdPreimageFromAddress({
              address: Address.fromString(NULTH_ACCOUNT).toScAddress(),
              salt: Buffer.alloc(32),
            }),
          ),
        }),
      ).toXDR('base64')

      assert.throws(
        () => assertAuthEntryMatchesContext(contractIdPreimage, NULTH_ACCOUNT, ctx),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /not a Soroban authorization preimage/i)
          return true
        },
      )
    })

    it('rejects altered argument count (e.g. 2 args instead of 3)', () => {
      const preimageTwoArgs = buildTransferPreimage(
        USDC_CONTRACT,
        NULTH_ACCOUNT,
        PAYEE_USDC,
        10_000_000n,
        {
          args: [
            nativeToScVal(NULTH_ACCOUNT, { type: 'address' }),
            nativeToScVal(PAYEE_USDC, { type: 'address' }),
          ],
        },
      )

      assert.throws(
        () => assertAuthEntryMatchesContext(preimageTwoArgs, NULTH_ACCOUNT, ctx),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /has 2 args, expected 3/i)
          return true
        },
      )
    })

    it('rejects altered argument count (e.g. 4 args instead of 3)', () => {
      const preimageFourArgs = buildTransferPreimage(
        USDC_CONTRACT,
        NULTH_ACCOUNT,
        PAYEE_USDC,
        10_000_000n,
        {
          args: [
            nativeToScVal(NULTH_ACCOUNT, { type: 'address' }),
            nativeToScVal(PAYEE_USDC, { type: 'address' }),
            nativeToScVal(10_000_000n, { type: 'i128' }),
            nativeToScVal('extra', { type: 'string' }),
          ],
        },
      )

      assert.throws(
        () => assertAuthEntryMatchesContext(preimageFourArgs, NULTH_ACCOUNT, ctx),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /has 4 args, expected 3/i)
          return true
        },
      )
    })

    it('rejects altered from account', () => {
      const preimageWrongFrom = buildTransferPreimage(
        USDC_CONTRACT,
        PAYEE_EURC,
        PAYEE_USDC,
        10_000_000n,
      )

      assert.throws(
        () => assertAuthEntryMatchesContext(preimageWrongFrom, NULTH_ACCOUNT, ctx),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /does not match nulthAccount/i)
          return true
        },
      )
    })

    it('rejects altered payee (to address)', () => {
      const preimageWrongTo = buildTransferPreimage(
        USDC_CONTRACT,
        NULTH_ACCOUNT,
        PAYEE_EURC,
        10_000_000n,
      )

      assert.throws(
        () => assertAuthEntryMatchesContext(preimageWrongTo, NULTH_ACCOUNT, ctx),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /does not match paymentContext.payee/i)
          return true
        },
      )
    })

    it('rejects altered amount (both higher and lower)', () => {
      const higherPreimage = buildTransferPreimage(
        USDC_CONTRACT,
        NULTH_ACCOUNT,
        PAYEE_USDC,
        10_000_001n,
      )
      const lowerPreimage = buildTransferPreimage(
        USDC_CONTRACT,
        NULTH_ACCOUNT,
        PAYEE_USDC,
        9_999_999n,
      )

      assert.throws(
        () => assertAuthEntryMatchesContext(higherPreimage, NULTH_ACCOUNT, ctx),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /does not match paymentContext.amountStroops/i)
          return true
        },
      )

      assert.throws(
        () => assertAuthEntryMatchesContext(lowerPreimage, NULTH_ACCOUNT, ctx),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'auth_entry_mismatch')
          assert.match(err.message, /does not match paymentContext.amountStroops/i)
          return true
        },
      )
    })
  })

  describe('Ledger boundary and bucket calculations', () => {
    it('accurately computes day bucket around ledger boundaries', () => {
      assert.equal(dayBucket(0), 0)
      assert.equal(dayBucket(17279), 0)
      assert.equal(dayBucket(17280), 1)
      assert.equal(dayBucket(34559), 1)
      assert.equal(dayBucket(34560), 2)
    })

    it('rejects expired session ledgers when expiryLedger is reached', async () => {
      const expiringVault: NulthVaultConfig = {
        ...vaultConfig,
        expiryLedger: 50_000,
      }

      const { signer } = await prepareNulthSigner(
        expiringVault,
        multiAssetManifest,
        'x402',
        'testnet',
        50_001, // Past expiry
      )

      const preimage = buildTransferPreimage(
        USDC_CONTRACT,
        NULTH_ACCOUNT,
        PAYEE_USDC,
        10_000_000n,
      )

      await assert.rejects(
        () => signer.signAuthEntry(preimage),
        (err: unknown) => {
          assert.ok(err instanceof NulthPolicyError)
          assert.equal(err.code, 'session_expired')
          return true
        },
      )
    })
  })
})
