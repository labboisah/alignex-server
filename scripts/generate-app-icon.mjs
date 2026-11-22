import pngToIco from '../../alignex-autoboot/node_modules/png-to-ico/index.js';
import sharp from '../../alignex-autoboot/node_modules/sharp/dist/index.mjs';
import { rm, writeFile } from 'node:fs/promises';

const resizedSourcePath = 'public/images/.logo-icon-source.png';

await sharp('public/images/logo.png')
	.resize(256, 256, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
	.png()
	.toFile(resizedSourcePath);

const icon = await pngToIco([resizedSourcePath]);
await writeFile('public/images/logo.ico', icon);
await rm(resizedSourcePath, { force: true });