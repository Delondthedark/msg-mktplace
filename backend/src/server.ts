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

// --- Simple in-memory catalog (edit to your needs) ---
const PRODUCTS: Record<string, { label: string; amount: number; img: string }> = {
  'corvette-1963-c2': {
    label: '1963 Chevrolet Corvette C2',
    amount: 25,                         // MSG amount you want to charge
    img: '/cars/1963_CCC2.png',         // served from backend/public/cars/...
  },
  'dodge-1968-charger': {
    label: '1968 Dodge Charger',
    amount: 15,
    img: '/cars/1968_charger.png',
  },
  'chevy-1970-camaro': {
    label: '1970 Chevrolet Camaro',
    amount: 12,
    img: '/cars/1970_camaro.png',
  },
  'rare-sports-car': {
    label: 'Rare Sports Car',
    amount: 40,
    img: '/cars/rare_sports.png',
  },
  'collectors-edition': {
    label: "Collector's Edition",
    amount: 5,
    img: '/cars/collectors.png',
  },
};

// --- Return product details as JSON (optional helper) ---
app.get('/products/:id', (req, res) => {
  const id = String(req.params.id);
  const p = PRODUCTS[id];
  if (!p) return res.status(404).json({ error: 'Product not found' });
  res.json({ itemId: id, ...p });
});

// --- Redirect short link: /p/<id> -> /pay.html?label=&amount=&itemId=&img= ---
app.get('/p/:id', (req, res) => {
  const id = String(req.params.id);
  const p = PRODUCTS[id];
  if (!p) {
    // Unknown product: minimal fallback (still opens pay page)
    const params = new URLSearchParams({ label: 'Item', amount: '1', itemId: id });
    return res.redirect(`/pay.html?${params.toString()}`);
  }
  const params = new URLSearchParams({
    label: p.label,
    amount: String(p.amount),
    itemId: id,
    img: p.img,
  });
  res.redirect(`/pay.html?${params.toString()}`);
});

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
  (tx as any).lastValidBlockHeight = lastValidBlockHeight; // tolerated by wallets
  tx.add(ix);
  return tx;
}

async function buildMsgPayTx(payer: PublicKey, amountMsg: number) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');

  // IMPORTANT: use recentBlockhash (not "blockhash") on the Transaction init
  const tx = new Transaction({
    feePayer: payer,
    recentBlockhash: blockhash,
    // lastValidBlockHeight is not part of the ctor type in some builds; set after if needed
  } as any);
  (tx as any).lastValidBlockHeight = lastValidBlockHeight;

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
