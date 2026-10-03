import fs from 'node:fs';
import path from 'node:path';

const logPath = path.resolve(process.cwd(), 'terminal.log');

if (!fs.existsSync(logPath)) {
  console.log('[LOGS] terminal.log does not exist yet. Run the terminal first.');
  process.exit(0);
}

console.log('=== MADMARKET TERMINAL LOG INSPECTOR ===\n');

const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
const recent = lines.slice(-40);

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
};

for (const line of recent) {
  if (!line) continue;
  let color = C.reset;
  if (line.includes('[SUCCESS]')) color = C.green;
  else if (line.includes('[ERROR]')) color = C.red + C.bold;
  else if (line.includes('[WARN]')) color = C.yellow;
  else if (line.includes('[DEBUG]')) color = C.dim;

  console.log(`${color}${line}${C.reset}`);
}

console.log(`\n=== Total lines in log: ${lines.length} ===`);
