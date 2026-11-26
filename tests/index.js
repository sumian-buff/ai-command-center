// Node 24 resolves `node --test tests/` through the directory's index.js.
// Discover the same test files as a normal run without importing fixture programs.
const { readdirSync } = require('node:fs');

async function loadTests() {
  for (const name of readdirSync(__dirname).sort()) {
    if (name.endsWith('.test.mjs')) await import('./' + name);
  }
}

loadTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
