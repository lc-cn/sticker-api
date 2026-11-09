// Generate a machine API token. Prints the plaintext ONCE (give it to the caller, e.g. Xiaozhi)
// and the MACHINE_TOKENS entry to put in Vercel env (hash only — the service never stores plaintext).
// usage: node scripts/new-machine-token.mjs xiaozhi assets:write,render,operations:read
import { createHash, randomBytes } from 'node:crypto';
const [id = 'xiaozhi', scopes = 'assets:write,render,operations:read'] = process.argv.slice(2);
const token = `stk_${id}_${randomBytes(32).toString('base64url')}`;
console.log(`token (show once, store in the caller's secret store):\n${token}\n`);
console.log('MACHINE_TOKENS entry:');
console.log(JSON.stringify({ id, scopes: scopes.split(','), sha256: createHash('sha256').update(token).digest('hex') }));
