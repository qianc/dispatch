// Usage: node src/server/hash-password.ts '<password>'  → prints APP_PASSWORD_HASH value
import { hashPassword } from './auth.ts';
const pw = process.argv[2];
if (!pw) { console.error('usage: node src/server/hash-password.ts <password>'); process.exit(1); }
console.log(hashPassword(pw));
