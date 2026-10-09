import {copyFileSync} from 'node:fs';
copyFileSync(new URL('../src/ui.css',import.meta.url),new URL('../dist/ui.css',import.meta.url));
