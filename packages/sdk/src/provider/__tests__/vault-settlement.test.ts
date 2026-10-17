import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Account, Keypair, Networks, scValToNative, StrKey, TransactionBuilder } from '@stellar/stellar-sdk'
import { buildSessionSettlementTransaction, resolveVaultSettlementAddresses } from '../internal/vaultSettlement.js'

describe('vault session settlement attribution (#16)', () => {
  it('attributes every settlement to the vault instance that governs it', () => {
    // The vault is the governed payer account, so the settlement is
    // attributed to this vault no matter who opened the channel or which
    // payee settled it (#16). A third-party payer must never be accepted.
    const vault = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEUZ3'
    const payee = Keypair.random().publicKey()

    assert.deepEqual(resolveVaultSettlementAddresses(vault, payee), {
      payer: vault,
      payee,
    })
  })

  it('returns null when the vault address is unavailable', () => {
    // Publishing no audit event is safer than silently attributing the
    // settlement to the wrong account.
    assert.equal(resolveVaultSettlementAddresses(null, 'G...'), null)
  })
})

describe('buildSessionSettlementTransaction', () => {
  // `new Contract()` rejects account (G...) addresses, so mint a contract id.
  const VAULT = StrKey.encodeContract(Keypair.random().rawPublicKey())
  const CHANNEL = Keypair.random().publicKey()
  const PAYER = Keypair.random().publicKey()

  /**
   * Re-parse a built transaction so its operations carry decoded `type`/`func`
   * fields, then return the contract function name and args of the only
   * operation. Built (non-parsed) operations leave `func` unpopulated.
   */
  function hostCall(
    tx: { toXDR(): string },
    networkPassphrase: string,
  ): { fn: string; args: unknown[] } {
    const parsed = TransactionBuilder.fromXDR(tx.toXDR(), networkPassphrase)
    assert.equal(parsed.operations.length, 1, 'exactly one operation expected')

    const op = parsed.operations[0] as unknown as {
      type?: string
      func?: { invokeContract(): unknown }
    }
    assert.equal(op.type, 'invokeHostFunction')

    const func = op.func
    assert.ok(func, 'operation should carry a host function')
    const invoke = func.invokeContract() as unknown as {
      functionName(): string | Buffer
      args(): Array<Parameters<typeof scValToNative>[0]>
    }
    const rawName = invoke.functionName()
    return {
      fn: typeof rawName === 'string' ? rawName : Buffer.from(rawName).toString(),
      args: invoke.args().map(a => scValToNative(a)),
    }
  }

  it('sources the transaction from the payee so its own signature authorizes the record', () => {
    const payee = Keypair.random()
    const payeePublicKey = payee.publicKey()

    const tx = buildSessionSettlementTransaction(
      new Account(payeePublicKey, '0'),
      VAULT,
      CHANNEL,
      { payer: PAYER, payee: payeePublicKey },
      500_000n,
      42,
      Networks.TESTNET,
    )

    // The payee is the source, so the source-account signature satisfies
    // payee.require_auth() on the vault.
    assert.equal(tx.source, payeePublicKey)
    assert.equal(tx.operations.length, 1)

    const { fn, args } = hostCall(tx, Networks.TESTNET)
    assert.equal(fn, 'record_session_settlement')
    // (channel_id, payer, payee, cumulative_amount, voucher_count)
    assert.deepEqual(args, [CHANNEL, PAYER, payeePublicKey, 500_000n, 42])
  })

  it('attributed payer equals the vault contract instance', () => {
    const vault = StrKey.encodeContract(Keypair.random().rawPublicKey())
    const payee = Keypair.random()
    const payeePublicKey = payee.publicKey()

    const tx = buildSessionSettlementTransaction(
      new Account(payeePublicKey, '0'),
      vault,
      CHANNEL,
      { payer: vault, payee: payeePublicKey },
      500_000n,
      42,
      Networks.TESTNET,
    )

    const { fn, args } = hostCall(tx, Networks.TESTNET)
    assert.equal(fn, 'record_session_settlement')
    // (channel_id, payer=vault, payee, cumulative_amount, voucher_count)
    assert.deepEqual(args, [CHANNEL, vault, payeePublicKey, 500_000n, 42])
    // The payer carried on-chain must be the vault itself.
    assert.equal(args[1], vault)
  })

  it('passes the channel close amount and voucher count through unchanged', () => {
    const payee = Keypair.random()
    const tx = buildSessionSettlementTransaction(
      new Account(payee.publicKey(), '0'),
      VAULT,
      CHANNEL,
      { payer: PAYER, payee: payee.publicKey() },
      0n,
      0,
      Networks.PUBLIC,
    )

    const { args } = hostCall(tx, Networks.PUBLIC)
    assert.equal(args[2], payee.publicKey())
    assert.equal(args[3], 0n)
    assert.equal(args[4], 0)
    assert.equal(tx.networkPassphrase, Networks.PUBLIC)
  })
})