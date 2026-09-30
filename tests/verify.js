import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { obfuscate } from "../src/obfuscator.js";

const fixtureDirectory = fileURLToPath(new URL("./logic/", import.meta.url));
const options = {
  seed: 20260930,
  compact: true,
  renameVariables: true,
  stringArray: true,
  numbersToExpressions: true,
  simplifyBranches: true,
  controlFlowFlattening: true,
  antiTamper: true
};

function execute(source, filename) {
  const module = { exports: null };
  const logs = [];
  const sandbox = {
    module,
    exports: module.exports,
    console: {
      log(...values) {
        logs.push(JSON.parse(JSON.stringify(values)));
      }
    }
  };
  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename }).runInContext(context, { timeout: 1500 });
  const snapshot = JSON.stringify({ result: module.exports, logs });
  if (snapshot === undefined) throw new Error(filename + " returned a non-serializable result.");
  return snapshot;
}

export function verifyAll() {
  const cases = readdirSync(fixtureDirectory)
    .filter(name => name.endsWith(".js"))
    .sort();
  if (!cases.length) throw new Error("No JavaScript logic fixtures were found.");

  for (const name of cases) {
    const filename = fixtureDirectory + name;
    const source = readFileSync(filename, "utf8");
    const first = obfuscate(source, options);
    const second = obfuscate(source, options);
    assert.equal(first.code, second.code, name + ": seeded output must be reproducible.");
    assert.equal(first.stats.antiTamperActive, true, name + ": string integrity should be enabled.");
    if (name === "dynamic-eval.js") {
      assert.equal(first.stats.dynamicScopeSkippedRenaming, true, "eval must disable local renaming.");
    }
    if (name === "control-flow-flattening.js") {
      assert.ok(first.stats.flattenedFunctions > 0, "a straight-line function should be flattened.");
    }
    assert.equal(
      execute(first.code, name + ".obfuscated.js"),
      execute(source, name + ".original.js"),
      name + ": obfuscated behavior differs from the original."
    );
    console.log("PASS " + name + " (" + first.stats.inputBytes + " → " + first.stats.outputBytes + " bytes)");
  }
  const probe = obfuscate('module.exports = "integrity probe";', {
    ...options, controlFlowFlattening: false, numbersToExpressions: false
  });
  const tampered = probe.code.replace(/(\[\[\s*)(\d+)/, (_, prefix, value) =>
    prefix + String((Number(value) + 1) & 65535));
  assert.notEqual(tampered, probe.code, "the test must alter an encoded string-table value.");
  assert.throws(() => execute(tampered, "tampered.js"), /String table integrity check failed/);
  console.log("PASS anti-tamper detects a modified string-table value.");
  console.log("Verified " + cases.length + " JavaScript logic fixtures.");
}
