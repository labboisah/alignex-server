const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
const stage = path.resolve(process.argv[3]);
if (!stage.startsWith(path.join(root, 'releases') + path.sep)) throw new Error('Staging must remain inside the release directory.');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
let count = 0;
function stageLinkedDependencies(source, destination, ancestors = new Set()) {
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
        if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('Invalid runtime dependency name: ' + name);
        const dependencySource = path.dirname(require.resolve(name + '/package.json', { paths: [source] }));
        const resolved = fs.realpathSync(dependencySource);
        if (ancestors.has(resolved)) throw new Error('Circular linked runtime dependency: ' + name);
        const dependencyDestination = path.join(destination, 'node_modules', name);
        fs.mkdirSync(path.dirname(dependencyDestination), { recursive: true });
        fs.cpSync(dependencySource, dependencyDestination, {
            recursive: true,
            filter: (entry) => path.basename(entry) !== 'node_modules',
        });
        stageLinkedDependencies(dependencySource, dependencyDestination, new Set([...ancestors, resolved]));
    }
}
for (const [relative, dependency] of Object.entries(lock.packages)) {
    if (!relative || dependency.dev === true) continue;
    if (!relative.startsWith('node_modules/')) {
        if (relative === '../kernelbridge-license/packages/typescript'
            && dependency.name === '@kernelbridge/licensing-client-typescript') continue;
        throw new Error('Unexpected dependency path.');
    }
    if (relative.split('/').includes('..')) throw new Error('Unexpected dependency path.');
    const source = path.join(root, relative);
    let copySource = source;
    if (dependency.link === true) {
        const sdkPath = path.resolve(root, '..', 'kernelbridge-license', 'packages', 'typescript');
        const linkedPath = path.resolve(root, dependency.resolved);
        if (relative !== 'node_modules/@kernelbridge/licensing-client-typescript' || linkedPath !== sdkPath) {
            throw new Error('Unexpected linked runtime dependency: ' + relative);
        }
        copySource = sdkPath;
    }
    if (!fs.existsSync(copySource)) {
        if (dependency.optional) continue;
        throw new Error('Missing runtime dependency: ' + relative);
    }
    const destination = path.join(stage, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (dependency.link === true) {
        fs.mkdirSync(destination, { recursive: true });
        for (const entry of ['package.json', 'README.md', 'dist']) {
            const packageEntry = path.join(copySource, entry);
            if (!fs.existsSync(packageEntry)) throw new Error('SDK runtime package is incomplete: ' + entry);
            fs.cpSync(packageEntry, path.join(destination, entry), { recursive: true });
        }
        stageLinkedDependencies(copySource, destination);
    } else {
        fs.cpSync(copySource, destination, { recursive: true });
    }
    count++;
}
console.log('Staged ' + count + ' runtime dependencies.');
