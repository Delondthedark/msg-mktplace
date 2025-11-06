import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getMint,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// --- Boilerplate paths ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUB_DIR = path.join(__dirname, '..', 'public');

// --- Env ---
const PORT = Number(process.env.PORT ?? 3001);
const RPC_URL = String(process.env.RPC_URL);
const MSG_MINT_KEY = new PublicKey(String(process.env.MSG_MINT));
const MERCHANT_WALLET = new PublicKey(String(process.env.MERCHANT_WALLET));

const app = express();
app.use(cors());
app.use(express.json());

// Serve the static pay.html
app.use(express.static(PUB_DIR));

// Solana connection
const conn = new Connection(RPC_URL, 'confirmed');

// ---------- Helpers ----------
function asAmount(name: string, raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${name}`);
  return n;
}
function asPubkey(raw: unknown): PublicKey {
  try {
    return new PublicKey(String(raw));
  } catch {
    throw new Error('Invalid account public key');
  }
}

async function buildPreviewTx(payer: PublicKey, note: string) {
  // Memo-only (no token movement)
  const memoProgram = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  const ix = new TransactionInstruction({
    programId: memoProgram,
    keys: [],
    data: Buffer.from(note, 'utf8'),
  });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
  const tx = new Transaction();
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.add(ix);
  return tx;
}

async function buildMsgPayTx(payer: PublicKey, amountMsg: number) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });

  // Ensure ATAs (idempotent)
  const payerAta = getAssociatedTokenAddressSync(MSG_MINT_KEY, payer);
  const merchantAta = getAssociatedTokenAddressSync(MSG_MINT_KEY, MERCHANT_WALLET);

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer,               // payer (funds creation)
      payerAta,            // ATA to create
      payer,               // owner
      MSG_MINT_KEY
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      merchantAta,
      MERCHANT_WALLET,
      MSG_MINT_KEY
    )
  );

  const mintInfo = await getMint(conn, MSG_MINT_KEY);
  const decimals = mintInfo.decimals;
  const amount = BigInt(Math.round(amountMsg * 10 ** decimals));

  tx.add(
    createTransferCheckedInstruction(
      payerAta,
      MSG_MINT_KEY,
      merchantAta,
      payer,
      amount,
      decimals,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  return tx;
}

// ---------- Actions-style endpoints ----------

// Manifest (optional for Dial/Blinks)
app.get('/actions.json', (_req, res) => {
  res.json({ rules: [{ pathPattern: '/*', apiPath: '/actions/*' }] });
});

// Metadata (optional; useful for clients that read action metadata)
app.get('/actions/pay', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    type: 'action',
    label: 'Buy with MSG',
    description: 'Pay in MSG tokens.',
    links: {
      actions: [
        {
          type: 'transaction',
          label: 'Preview (no charge)',
          href: `${base}/actions/pay?amount={amount}&itemId={itemId}&test=true`,
        },
        {
          type: 'transaction',
          label: 'Buy now',
          href: `${base}/actions/pay?amount={amount}&itemId={itemId}`,
        },
      ],
    },
    parameters: [
      { name: 'amount', label: 'Amount in MSG', required: true },
      { name: 'itemId', label: 'Item ID', required: true },
    ],
  });
});

// Build tx (Preview or Real)
app.post('/actions/pay', async (req, res) => {
  try {
    const amount = asAmount('amount', req.query.amount);
    const test = String(req.query.test ?? 'false') === 'true';
    const itemId = String(req.query.itemId ?? 'item');
    const account = asPubkey(req.body?.account);

    const tx = test
      ? await buildPreviewTx(account, `PREVIEW: ${itemId} for ${amount} MSG → ${MERCHANT_WALLET.toBase58()}`)
      : await buildMsgPayTx(account, amount);

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const base64 = Buffer.from(serialized).toString('base64');

    res.json({
      transaction: base64,
      message: test ? `Preview only — ${amount} MSG planned` : `Buy ${itemId} for ${amount} MSG`,
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? 'Failed to build transaction' });
  }
});

// Health ping
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`MSG Actions server running on :${PORT}`);
  console.log(`Serving pay page at http://localhost:${PORT}/pay.html`);
});
