const { spawnSync } = require('child_process');

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.log('DATABASE_URL not set — skipping prisma migrate deploy (safe for local dev).');
  process.exit(0);
}

console.log('DATABASE_URL detected — running prisma migrate deploy');
const res = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', shell: true });
process.exit(res.status);
