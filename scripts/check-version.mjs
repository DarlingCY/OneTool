import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const cargoToml = readFileSync("src-tauri/Cargo.toml", "utf8");
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

const expected = packageJson.version;
const versions = {
  "package.json": packageJson.version,
  "src-tauri/tauri.conf.json": tauriConfig.version,
  "src-tauri/Cargo.toml": cargoVersion,
};

const mismatches = Object.entries(versions).filter(([, version]) => version !== expected);

if (mismatches.length > 0) {
  console.error(`Version mismatch. Expected ${expected}:`);
  for (const [file, version] of mismatches) {
    console.error(`- ${file}: ${version ?? "missing"}`);
  }
  process.exit(1);
}

console.log(`Version check passed: ${expected}`);
