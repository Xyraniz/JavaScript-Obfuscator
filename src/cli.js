#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { obfuscate } from "./obfuscator.js";

function usage() {
  console.log("Usage: js-obfuscator <input.js> [-o output.js] [--seed n] [--no-mangle] [--no-strings] [--no-numbers] [--no-branches] [--pretty]");
  console.log("       js-obfuscator verify   Obfuscate and compare every logic fixture");
}
const args = process.argv.slice(2);
if (args[0] === "verify") {
  try {
    const { verifyAll } = await import("../tests/verify.js");
    verifyAll();
  } catch (error) {
    console.error("Verification failed: " + error.message);
    process.exit(1);
  }
  process.exit(0);
}
if (!args.length || args.includes("--help") || args.includes("-h")) { usage(); process.exit(args.length ? 0 : 1); }
let input = null, output = null;
const options = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if ((arg === "-o" || arg === "--out") && args[i + 1]) output = args[++i];
  else if (arg === "--seed" && args[i + 1]) options.seed = Number(args[++i]);
  else if (arg === "--no-mangle") options.renameVariables = false;
  else if (arg === "--no-strings") options.stringArray = false;
  else if (arg === "--no-numbers") options.numbersToExpressions = false;
  else if (arg === "--no-branches") options.simplifyBranches = false;
  else if (arg === "--pretty") options.compact = false;
  else if (!arg.startsWith("-") && input === null) input = arg;
  else { console.error("Unknown or incomplete option: " + arg); usage(); process.exit(2); }
}
if (!input) { console.error("Provide an input JavaScript file."); usage(); process.exit(2); }
try {
  const inputPath = resolve(input);
  const source = readFileSync(inputPath, "utf8");
  const result = obfuscate(source, options);
  const destination = output ? resolve(output) : inputPath.replace(/\.js$/i, "") + ".obfuscated.js";
  writeFileSync(destination, result.code, "utf8");
  console.log("Wrote " + destination + " (" + result.stats.inputBytes + " -> " + result.stats.outputBytes + " bytes)");
} catch (error) {
  console.error("Obfuscation failed: " + error.message);
  process.exit(1);
}
