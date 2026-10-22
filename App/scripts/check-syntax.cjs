const fs = require('node:fs');
const path = require('node:path');
const parser = require('@babel/parser');

const root = path.resolve(__dirname, '..');
let checked = 0;
function check(file) {
  parser.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'unambiguous', plugins: ['jsx'] });
  checked += 1;
}
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(js|jsx|mjs|cjs)$/.test(entry.name)) check(file);
  }
}
check(path.join(root, 'App.js'));
walk(path.join(root, 'src'));
console.log(`Sintaxis verificada: ${checked} archivos.`);
