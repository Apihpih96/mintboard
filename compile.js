// Compile MintBoardBadge.sol with solc-js, resolving @openzeppelin imports
// from the project's node_modules. Writes build/MintBoardBadge.abi.json and
// build/MintBoardBadge.bytecode.txt. Usage: node compile.js
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = __dirname;

function findImports(importPath) {
  const fromModules = path.join(root, "node_modules", importPath);
  if (fs.existsSync(fromModules)) {
    return { contents: fs.readFileSync(fromModules, "utf8") };
  }
  const local = path.join(root, importPath);
  if (fs.existsSync(local)) {
    return { contents: fs.readFileSync(local, "utf8") };
  }
  return { error: "not found: " + importPath };
}

const input = {
  language: "Solidity",
  sources: {
    "MintBoardBadge.sol": {
      content: fs.readFileSync(path.join(root, "contracts", "MintBoardBadge.sol"), "utf8"),
    },
  },
  settings: {
    evmVersion: "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } },
    optimizer: { enabled: true, runs: 200 },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join("\n"));
  process.exit(1);
}
(out.errors || []).forEach((e) => console.log(e.formattedMessage));

const contract = out.contracts["MintBoardBadge.sol"]["MintBoardBadge"];
fs.mkdirSync(path.join(root, "build"), { recursive: true });
fs.writeFileSync(
  path.join(root, "build", "MintBoardBadge.abi.json"),
  JSON.stringify(contract.abi, null, 2)
);
fs.writeFileSync(path.join(root, "build", "MintBoardBadge.bytecode.txt"), contract.evm.bytecode.object);
console.log(
  "COMPILED OK: ABI entries %d | creation bytecode bytes %d",
  contract.abi.length,
  contract.evm.bytecode.object.length / 2
);
