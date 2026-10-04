// `700 wallet` — your private earnings wallet.
//
// This is visible only to you, on your machine (data in ~/.700ai/wallet.json).
// Live balance is pulled from Stripe when you connect a secret key, so the
// number reflects REAL money you can pay out to your bank via Stripe payouts.
// Without a Stripe key it falls back to the local sales ledger.
import { c, brand } from './theme.js';
import { wallet } from './store.js';
import { maskedInput } from './setup.js';
import { pickList } from './picker.js';

async function stripeBalance(key) {
  const res = await fetch('https://api.stripe.com/v1/balance', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Stripe ${res.status}`);
  const json = await res.json();
  const avail = (json.available || []).reduce((s, b) => s + b.amount, 0) / 100;
  const pending = (json.pending || []).reduce((s, b) => s + b.amount, 0) / 100;
  return { avail, pending, currency: (json.available?.[0]?.currency || 'usd').toUpperCase() };
}

export async function openWallet() {
  const w = wallet.read();
  console.log('\n' + brand('  700 AI — Private Wallet') + '\n');
  console.log(c.dim('  Only you can see this. Data stays in ~/.700ai/wallet.json\n'));

  let live = null;
  if (w.stripeKey) {
    try {
      live = await stripeBalance(w.stripeKey);
    } catch (e) {
      console.log(c.red('  Could not reach Stripe: ') + c.dim(e.message) + '\n');
    }
  }

  const localTotal = w.ledger.reduce((s, e) => s + (e.amount || 0), 0);

  if (live) {
    console.log('  ' + c.dim('Available (payable to bank)') + '   ' + c.green(`$${live.avail.toFixed(2)} ${live.currency}`));
    console.log('  ' + c.dim('Pending')                     + '                       ' + c.gold(`$${live.pending.toFixed(2)} ${live.currency}`));
  } else {
    console.log('  ' + c.dim('Local sales ledger total')     + '     ' + c.green(`$${localTotal.toFixed(2)} USD`));
    console.log('  ' + c.faint('  (connect Stripe for live bank-payable balance)'));
  }

  console.log('\n  ' + c.dim('Recent sales:'));
  const recent = w.ledger.slice(-5).reverse();
  if (!recent.length) console.log(c.faint('    — no sales yet —'));
  for (const e of recent) {
    console.log('    ' + c.white(`$${(e.amount || 0).toFixed(2)}`) + c.dim(`  ${e.item}  ${e.at.slice(0, 10)}`));
  }

  console.log('');
  const action = await pickList({
    title: 'Wallet', filter: false, summary: false,
    items: [
      { label: 'Connect / update Stripe key', desc: 'enables bank payouts', value: 'stripe' },
      { label: 'Payout to bank', desc: 'opens Stripe payouts', value: 'payout' },
      { label: 'Close', value: 'close' },
    ],
  });

  if (action === 'stripe') {
    const entered = await maskedInput('Stripe secret key (sk_live_...):');
    const key = (entered || '').trim();
    if (key) { wallet.write({ stripeKey: key }); console.log(c.green('  ✓ Stripe connected.\n')); }
  } else if (action === 'payout') {
    console.log(c.dim('\n  Payouts to your bank are handled by Stripe: ') + c.white('https://dashboard.stripe.com/payouts') + '\n');
  }
}
