import {fileURLToPath} from 'node:url';
// MCP may be launched from any workspace; all data and prompts belong to this checkout.
process.chdir(fileURLToPath(new URL('../',import.meta.url)));
await import('./asset-image-executor.ts');
