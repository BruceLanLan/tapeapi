#!/usr/bin/env node
// Compile contracts/src/*.sol with solc-js and write ABI + bytecode to contracts/out/<Name>.json
// 用 solc-js 编译 contracts/src/*.sol，输出 ABI + 字节码到 contracts/out/<Name>.json
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const solc = require('solc');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'contracts', 'src');
const outDir = join(root, 'contracts', 'out');

// Only compile top-level contracts; interfaces.sol is pulled in via import / 仅编译主合约，接口文件通过 import 引入
const files = readdirSync(srcDir).filter((f) => f.endsWith('.sol'));
const sources = Object.fromEntries(files.map((f) => [f, { content: readFileSync(join(srcDir, f), 'utf8') }]));

// Resolve relative imports ("./interfaces.sol") against contracts/src / 解析相对导入
function findImports(path) {
  const candidates = [join(srcDir, path), join(srcDir, path.replace(/^\.\//, '')), resolve(root, path)];
  for (const c of candidates) if (existsSync(c)) return { contents: readFileSync(c, 'utf8') };
  return { error: `File not found: ${path}` };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris', // no PUSH0/TSTORE assumptions; safe on BSC / 兼容 BSC
    metadata: { bytecodeHash: 'none' },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.methodIdentifiers'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

let hasError = false;
for (const e of output.errors ?? []) {
  if (e.severity === 'error') hasError = true;
  process.stderr.write(e.formattedMessage);
}
if (hasError) {
  console.error('compile failed');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const written = [];
for (const [file, contracts] of Object.entries(output.contracts ?? {})) {
  if (file === 'interfaces.sol') continue; // shared interfaces/library only, no deployable / 仅共享定义，不产出
  for (const [name, c] of Object.entries(contracts)) {
    const bytecode = c.evm.bytecode.object;
    if (!bytecode || bytecode.length === 0) continue; // skip interfaces / abstract with no code
    const artifact = {
      contractName: name,
      sourceName: file,
      compiler: { version: solc.version(), evmVersion: input.settings.evmVersion, optimizer: input.settings.optimizer },
      abi: c.abi,
      bytecode: '0x' + bytecode,
      deployedBytecode: '0x' + c.evm.deployedBytecode.object,
      methodIdentifiers: c.evm.methodIdentifiers,
    };
    const outFile = join(outDir, `${name}.json`);
    writeFileSync(outFile, JSON.stringify(artifact, null, 2) + '\n');
    written.push({ name, file: basename(outFile), bytes: bytecode.length / 2, fns: c.abi.filter((x) => x.type === 'function').length });
  }
}

console.log(`solc ${solc.version()}`);
for (const w of written) console.log(`  ${w.name.padEnd(18)} -> contracts/out/${w.file}  (${w.bytes} bytes, ${w.fns} functions)`);
if (written.length === 0) { console.error('nothing compiled'); process.exit(1); }
