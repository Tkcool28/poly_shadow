import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { config } from '../config/env';

export async function setupWallet(): Promise<void> {
  if (!config.PRIVATE_KEY) {
    console.error('Error: PRIVATE_KEY is required in .env');
    console.error('Add your Polymarket account private key to .env:');
    console.error('  PRIVATE_KEY=0x...');
    process.exit(1);
  }

  const signer = new Wallet(config.PRIVATE_KEY);
  console.log(`\nSigner address: ${signer.address}`);

  // Step 1: Derive API credentials
  console.log('\nDeriving CLOB API credentials...');
  const tempClient = new ClobClient('https://clob.polymarket.com', 137, signer);

  let creds;
  try {
    creds = await tempClient.createOrDeriveApiKey();
  } catch (err: any) {
    console.error(`Failed to derive API key: ${err.message}`);
    console.error('Make sure your private key is valid and your account exists on Polymarket.');
    process.exit(1);
  }

  console.log('\nAPI Credentials derived successfully!');
  console.log('Add these to your .env file:\n');
  console.log(`CLOB_API_KEY=${creds.key}`);
  console.log(`CLOB_API_SECRET=${creds.secret}`);
  console.log(`CLOB_API_PASSPHRASE=${creds.passphrase}`);

  // Step 2: Show funder address
  // The funder address is your proxy wallet on Polymarket.
  // For POLY_PROXY (type 1) or GNOSIS_SAFE (type 2), this is different from your signer address.
  console.log('\nFunder address (your proxy wallet from polymarket.com/settings):');
  console.log('Set this in .env:');
  console.log(`FUNDER_ADDRESS=<your proxy wallet address from Polymarket settings>`);

  // Step 3: Token approvals info
  console.log('\n─── Token Approvals ───');
  console.log('Before trading, you need 3 token approvals on Polygon.');
  console.log('If you trade through Polymarket.com already, these are likely set.');
  console.log('\nContract addresses for reference:');
  console.log('  USDC.e:              0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174');
  console.log('  CTF:                 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045');
  console.log('  CTF Exchange:        0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E');
  console.log('  NegRisk CTF Exchange: 0xC5d563A36AE78145C45a50134d48A1215220f80a');
  console.log('\nRequired approvals:');
  console.log('  1. USDC.e → CTF (for splitting into outcome tokens)');
  console.log('  2. CTF → CTF Exchange (setApprovalForAll)');
  console.log('  3. CTF → NegRisk CTF Exchange (setApprovalForAll)');

  // Step 4: Verify connection with credentials
  if (config.CLOB_API_KEY && config.CLOB_API_SECRET && config.CLOB_API_PASSPHRASE) {
    console.log('\nExisting credentials found in .env, verifying...');
    try {
      const fullClient = new ClobClient(
        'https://clob.polymarket.com',
        137,
        signer,
        { key: config.CLOB_API_KEY, secret: config.CLOB_API_SECRET, passphrase: config.CLOB_API_PASSPHRASE },
        config.SIGNATURE_TYPE,
        config.FUNDER_ADDRESS,
      );
      await fullClient.getOpenOrders();
      console.log('Credentials verified successfully!');
    } catch (err: any) {
      console.warn(`Warning: credential verification failed: ${err.message}`);
      console.warn('You may need to update your .env with the new credentials above.');
    }
  }

  console.log('\n─── Summary ───');
  console.log('1. Add the API credentials above to your .env');
  console.log('2. Set FUNDER_ADDRESS to your proxy wallet from Polymarket settings');
  console.log('3. Set SIGNATURE_TYPE=1 (POLY_PROXY) or SIGNATURE_TYPE=2 (GNOSIS_SAFE)');
  console.log('4. Ensure token approvals are set (usually already done if you trade on Polymarket)');
  console.log('5. Set COPY_TRADE_ENABLED=true when ready to start');
}
