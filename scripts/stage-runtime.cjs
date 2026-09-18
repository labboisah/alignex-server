const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
const stage = path.resolve(process.argv[3]);
if (!stage.startsWith(path.join(root, 'releases') + path.sep)) throw new Error('Staging must remain inside the release directory.');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
let count = 0;
for (const [relative, dependency] of Object.entries(lock.packages)) {
    if (!relative || dependency.dev === true) continue;
    if (!relative.startsWith('node_modules/') || relative.split('/').includes('..')) throw new Error('Unexpected dependency path.');
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) {
        if (dependency.optional) continue;
        throw new Error('Missing runtime dependency: ' + relative);
    }
    fs.mkdirSync(path.dirname(path.join(stage, relative)), { recursive: true });
    fs.cpSync(source, path.join(stage, relative), { recursive: true });
    count++;
}
console.log('Staged ' + count + ' runtime dependencies.');
