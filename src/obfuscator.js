import * as acorn from "acorn";
import * as eslintScope from "eslint-scope";
import estraverse from "estraverse";
import escodegen from "escodegen";

const RESERVED = new Set(("await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new package private protected public return static super switch this throw true try typeof var void while with yield null").split(" "));
const DEFAULTS = Object.freeze({
  seed: 1,
  compact: true,
  renameVariables: true,
  stringArray: true,
  numbersToExpressions: true,
  simplifyBranches: true,
  controlFlowFlattening: false,
  antiTamper: false,
  obfuscateProperties: false,
  opaquePredicates: true,
  deadCodeInjection: false
});

function randomSource(seed) {
  let state = (Number(seed) >>> 0) || 0x6d2b79f5;
  return function next(max = 0x100000000) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) % max;
  };
}

function parse(source) {
  const common = { ecmaVersion: "latest", allowHashBang: true, locations: false };
  try { return acorn.parse(source, { ...common, sourceType: "module" }); }
  catch (moduleError) {
    try { return acorn.parse(source, { ...common, sourceType: "script" }); }
    catch (scriptError) {
      const error = scriptError.pos >= moduleError.pos ? scriptError : moduleError;
      throw new SyntaxError(error.message);
    }
  }
}

function hasDynamicScope(ast) {
  let dynamic = false;
  estraverse.traverse(ast, {
    enter(node) {
      if (node.type === "WithStatement" ||
          (node.type === "CallExpression" && node.callee.type === "Identifier" &&
           node.callee.name === "eval" && !node.optional)) {
        dynamic = true;
        return estraverse.VisitorOption.Break;
      }
    }
  });
  return dynamic;
}

function freshIdentifier(used, next) {
  let candidate;
  do { candidate = "_" + next().toString(36); } while (used.has(candidate) || RESERVED.has(candidate));
  used.add(candidate);
  return candidate;
}

function renameBindings(ast, next) {
  const used = new Set();
  estraverse.traverse(ast, { enter(node) { if (node.type === "Identifier") used.add(node.name); } });
  let analysis;
  try {
    analysis = eslintScope.analyze(ast, {
      ecmaVersion: 2022,
      sourceType: ast.sourceType || "script",
      optimistic: true,
      directive: true,
      ignoreEval: false
    });
  } catch (_) { return 0; }

  const parents = new WeakMap();
  estraverse.traverse(ast, {
    enter(node, parent) { if (parent) parents.set(node, parent); }
  });
  let changed = 0;
  for (const scope of analysis.scopes) {
    if (scope.type === "global" || scope.type === "module" || scope.type === "function-expression-name") continue;
    for (const variable of scope.variables) {
      if (!variable.defs.length || variable.name === "arguments" || variable.name === "eval") continue;
      const replacement = freshIdentifier(used, next);
      const rename = identifier => {
        let child = identifier;
        let parent = parents.get(child);
        if (parent && parent.type === "AssignmentPattern" && parent.left === child) {
          child = parent;
          parent = parents.get(child);
        }
        if (parent && parent.type === "Property" && parent.shorthand && parent.value === child) {
          parent.shorthand = false;
          if (parent.key === identifier) parent.key = { type: "Identifier", name: variable.name };
        }
        identifier.name = replacement;
      };
      for (const identifier of variable.identifiers) rename(identifier);
      for (const reference of variable.references) rename(reference.identifier);
      changed++;
    }
  }
  return changed;
}

function obfuscateMemberAccess(ast) {
  let changed = 0;
  estraverse.traverse(ast, {
    enter(node) {
      if (node.type !== "MemberExpression" || node.computed || node.property.type !== "Identifier") return;
      node.computed = true;
      node.property = { type: "Literal", value: node.property.name };
      changed++;
    }
  });
  return changed;
}

function isDirective(parent, node) {
  return parent && parent.type === "ExpressionStatement" && parent.expression === node &&
    typeof parent.directive === "string";
}

function encodeStrings(ast, next, used, antiTamper = false) {
  const strings = [];
  const indexes = new Map();
  estraverse.traverse(ast, {
    enter(node, parent) {
      if (node.type !== "Literal" || typeof node.value !== "string" || isDirective(parent, node)) return;
      if (parent && ((parent.type === "Property" && parent.key === node && !parent.computed) ||
          parent.type === "ImportDeclaration" || parent.type === "ExportNamedDeclaration" ||
          parent.type === "ExportAllDeclaration")) return;
      if (!indexes.has(node.value)) {
        indexes.set(node.value, strings.length);
        strings.push(node.value);
      }
    }
  });
  if (!strings.length) return null;

  const order = strings.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i--) {
    const j = next(i + 1); [order[i], order[j]] = [order[j], order[i]];
  }
  const slots = new Map(order.map((original, slot) => [original, slot]));
  const tableName = freshIdentifier(used, next);
  const cacheName = freshIdentifier(used, next);
  const checkName = antiTamper ? freshIdentifier(used, next) : null;
  const decodeName = freshIdentifier(used, next);
  const key = 1 + next(255);
  const checksums = order.map(originalIndex => {
    const value = strings[originalIndex];
    let first = 2166136261 >>> 0;
    let second = 2654435769 >>> 0;
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i) ^ key;
      first = Math.imul(first ^ unit, 16777619) >>> 0;
      second = (Math.imul(second ^ (unit + i), 2246822519) + 3266489917) >>> 0;
    }
    return [first, second];
  });
  const encoded = order.map(originalIndex => {
    const value = strings[originalIndex];
    const units = [];
    for (let i = 0; i < value.length; i++) units.push(value.charCodeAt(i) ^ key);
    return { type: "ArrayExpression", elements: units.map(value => ({ type: "Literal", value })) };
  });
  const integrityCode = antiTamper
    ? "var h=2166136261,q=2654435769;for(var k=0;k<a.length;k++){h=Math.imul(h^a[k],16777619)>>>0;q=(Math.imul(q^(a[k]+k),2246822519)+3266489917)>>>0}if((h>>>0)!==" + checkName + "[i][0]||(q>>>0)!==" + checkName + "[i][1])throw new Error('String table integrity check failed');"
    : "";

  const decoder = parse(
    "function " + decodeName + "(i){var c=" + cacheName + "[i];if(c!==void 0)return c;var a=" + tableName + "[i],s=\"\";" + integrityCode + "for(var j=0;j<a.length;j++)s+=String.fromCharCode(a[j]^" + key + ");" + cacheName + "[i]=s;return s}"
  ).body[0];
  estraverse.replace(ast, {
    leave(node, parent) {
      if (node.type !== "Literal" || typeof node.value !== "string" || isDirective(parent, node)) return node;
      if (parent && ((parent.type === "Property" && parent.key === node && !parent.computed) ||
          parent.type === "ImportDeclaration" || parent.type === "ExportNamedDeclaration" ||
          parent.type === "ExportAllDeclaration")) return node;
      return {
        type: "CallExpression",
        callee: { type: "Identifier", name: decodeName },
        arguments: [{ type: "Literal", value: slots.get(indexes.get(node.value)) }],
        optional: false
      };
    }
  });

  const table = {
    type: "VariableDeclaration",
    kind: "var",
    declarations: [{ type: "VariableDeclarator", id: { type: "Identifier", name: tableName },
      init: { type: "ArrayExpression", elements: encoded } }]
  };
  const cache = {
    type: "VariableDeclaration",
    kind: "var",
    declarations: [{ type: "VariableDeclarator", id: { type: "Identifier", name: cacheName },
      init: { type: "ArrayExpression", elements: [] } }]
  };
  const runtime = [table, cache];
  if (antiTamper) {
    runtime.push({
      type: "VariableDeclaration",
      kind: "var",
      declarations: [{ type: "VariableDeclarator", id: { type: "Identifier", name: checkName },
        init: { type: "ArrayExpression", elements: checksums.map(pair => ({
          type: "ArrayExpression", elements: pair.map(value => ({ type: "Literal", value }))
        })) } }]
    });
  }
  runtime.push(decoder);
  return runtime;
}

function flattenSimpleFunctions(ast, next) {
  const used = new Set();
  estraverse.traverse(ast, { enter(node) { if (node.type === "Identifier") used.add(node.name); } });
  let flattened = 0;

  estraverse.traverse(ast, {
    enter(node) {
      if (!["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type) ||
          !node.body || node.body.type !== "BlockStatement") return;
      const body = node.body.body;
      let directiveCount = 0;
      while (directiveCount < body.length && typeof body[directiveCount].directive === "string") directiveCount++;
      const statements = body.slice(directiveCount);
      if (statements.length < 4) return;
      for (let i = 0; i < statements.length; i++) {
        const statement = statements[i];
        const supported = (statement.type === "VariableDeclaration" && statement.kind === "var") ||
          statement.type === "ExpressionStatement" || statement.type === "ReturnStatement" ||
          statement.type === "ThrowStatement";
        if (!supported || ((statement.type === "ReturnStatement" || statement.type === "ThrowStatement") &&
            i !== statements.length - 1)) return;
      }

      const stateName = freshIdentifier(used, next);
      const labelSet = new Set();
      const labels = statements.map(() => {
        let label;
        do { label = 1 + next(0x7ffffffe); } while (labelSet.has(label));
        labelSet.add(label);
        return label;
      });
      const order = statements.map((_, index) => index);
      for (let i = order.length - 1; i > 0; i--) {
        const j = next(i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
      const state = () => ({ type: "Identifier", name: stateName });
      const literal = value => value < 0
        ? { type: "UnaryExpression", operator: "-", prefix: true,
          argument: { type: "Literal", value: -value } }
        : { type: "Literal", value };
      const cases = order.map(index => {
        const statement = statements[index];
        const consequent = [statement];
        if (statement.type !== "ReturnStatement" && statement.type !== "ThrowStatement") {
          consequent.push({
            type: "ExpressionStatement",
            expression: { type: "AssignmentExpression", operator: "=", left: state(),
              right: literal(index + 1 < statements.length ? labels[index + 1] : -1) }
          });
          consequent.push({ type: "BreakStatement", label: null });
        }
        return { type: "SwitchCase", test: literal(labels[index]), consequent };
      });
      cases.push({
        type: "SwitchCase",
        test: null,
        consequent: [{ type: "ExpressionStatement",
          expression: { type: "AssignmentExpression", operator: "=", left: state(), right: literal(-1) } }]
      });
      const controlLoop = {
        type: "WhileStatement",
        test: { type: "BinaryExpression", operator: "!==", left: state(), right: literal(-1) },
        body: { type: "BlockStatement", body: [{
          type: "SwitchStatement", discriminant: state(), cases
        }] }
      };
      body.splice(directiveCount, body.length - directiveCount,
        { type: "VariableDeclaration", kind: "var", declarations: [{
          type: "VariableDeclarator", id: state(), init: literal(labels[0])
        }] },
        controlLoop);
      flattened++;
    }
  });
  return flattened;
}

function transformNumbers(ast, next) {
  estraverse.replace(ast, {
    leave(node, parent) {
      if (node.type !== "Literal" || typeof node.value !== "number" ||
          !Number.isSafeInteger(node.value) || node.value < 2 || node.value > 1000000000) return node;
      if (parent && parent.type === "Property" && parent.key === node && !parent.computed) return node;
      const offset = 2 + next(31);
      return {
        type: "BinaryExpression",
        operator: "-",
        left: { type: "BinaryExpression", operator: "+", left: node,
          right: { type: "Literal", value: offset } },
        right: { type: "Literal", value: offset }
      };
    }
  });
}

function mutateBranches(ast) {
  estraverse.traverse(ast, {
    enter(node) {
      if (node.type === "IfStatement" || node.type === "ConditionalExpression" ||
          node.type === "WhileStatement" || node.type === "DoWhileStatement") {
        node.test = { type: "UnaryExpression", operator: "!", prefix: true,
          argument: { type: "UnaryExpression", operator: "!", prefix: true, argument: node.test } };
      }
    }
  });
}

function guardBranchTests(ast, opaqueCall) {
  let guarded = 0;
  estraverse.traverse(ast, {
    enter(node) {
      if (node.type !== "IfStatement" && node.type !== "ConditionalExpression") return;
      node.test = { type: "LogicalExpression", operator: "&&", left: opaqueCall(true), right: node.test };
      guarded++;
    }
  });
  return guarded;
}

function buildDeadStatements(next, used) {
  const count = 2 + next(3);
  const statements = [];
  let previous = null;
  for (let i = 0; i < count; i++) {
    const name = freshIdentifier(used, next);
    const base = 100 + next(900000);
    const operator = ["+", "-", "*", "^"][next(4)];
    const init = previous
      ? { type: "BinaryExpression", operator, left: { type: "Identifier", name: previous },
        right: { type: "Literal", value: base } }
      : { type: "Literal", value: base };
    statements.push({
      type: "VariableDeclaration",
      kind: "let",
      declarations: [{ type: "VariableDeclarator", id: { type: "Identifier", name }, init }]
    });
    previous = name;
  }
  return statements;
}

function buildDeadBlock(next, used, opaqueCall) {
  return {
    type: "IfStatement",
    test: opaqueCall(false),
    consequent: { type: "BlockStatement", body: buildDeadStatements(next, used) },
    alternate: null
  };
}

function insertDeadCode(ast, next, used, opaqueCall) {
  let injected = 1;
  insertAfterDirectivesAndImports(ast, [buildDeadBlock(next, used, opaqueCall)]);
  estraverse.traverse(ast, {
    enter(node) {
      if (!["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) return;
      if (!node.body || node.body.type !== "BlockStatement") return;
      if (next(2) === 0) return;
      let index = 0;
      while (index < node.body.body.length && typeof node.body.body[index].directive === "string") index++;
      node.body.body.splice(index, 0, buildDeadBlock(next, used, opaqueCall));
      injected++;
    }
  });
  return injected;
}

function insertAfterDirectivesAndImports(ast, statements) {
  if (!statements || !statements.length) return;
  let index = 0;
  while (index < ast.body.length) {
    const node = ast.body[index];
    if ((node.type === "ExpressionStatement" && typeof node.directive === "string") ||
        node.type === "ImportDeclaration") index++;
    else break;
  }
  ast.body.splice(index, 0, ...statements);
}

export function obfuscate(source, options = {}) {
  if (typeof source !== "string") throw new TypeError("Source code must be a string.");
  if (source.length > 2_000_000) throw new RangeError("Source is larger than the 2 MB limit.");
  const settings = { ...DEFAULTS, ...options };
  const next = randomSource(settings.seed);
  const ast = parse(source);
  const flattenedFunctions = settings.controlFlowFlattening ? flattenSimpleFunctions(ast, next) : 0;
  const dynamicScope = hasDynamicScope(ast);
  if (settings.renameVariables && !dynamicScope) renameBindings(ast, next);
  const obfuscatedProperties = settings.obfuscateProperties ? obfuscateMemberAccess(ast) : 0;

  const used = new Set();
  estraverse.traverse(ast, { enter(node) { if (node.type === "Identifier") used.add(node.name); } });

  let opaqueHelperName = null;
  let opaqueHelperNode = null;
  function opaqueCall(mode) {
    if (!opaqueHelperName) {
      opaqueHelperName = freshIdentifier(used, next);
      opaqueHelperNode = parse(
        "function " + opaqueHelperName + "(m){var t=Date.now()%2;return m?(t===0||t===1):(t===2)}"
      ).body[0];
    }
    return {
      type: "CallExpression",
      callee: { type: "Identifier", name: opaqueHelperName },
      arguments: [{ type: "Literal", value: mode }],
      optional: false
    };
  }

  const guardedBranches = settings.opaquePredicates ? guardBranchTests(ast, opaqueCall) : 0;
  const deadCodeBlocks = settings.deadCodeInjection ? insertDeadCode(ast, next, used, opaqueCall) : 0;

  let stringRuntime = null;
  if (settings.stringArray) stringRuntime = encodeStrings(ast, next, used, settings.antiTamper);
  if (settings.numbersToExpressions) transformNumbers(ast, next);
  if (settings.simplifyBranches) mutateBranches(ast);
  const runtime = opaqueHelperNode
    ? (stringRuntime ? [opaqueHelperNode, ...stringRuntime] : [opaqueHelperNode])
    : stringRuntime;
  insertAfterDirectivesAndImports(ast, runtime);

  const output = escodegen.generate(ast, {
    comment: false,
    format: {
      compact: Boolean(settings.compact),
      semicolons: true,
      parentheses: true,
      safeConcatenation: true,
      escapeless: false,
      renumber: false,
      hexadecimal: false
    }
  });
  return { code: output, stats: {
    inputBytes: new TextEncoder().encode(source).length,
    outputBytes: new TextEncoder().encode(output).length,
    dynamicScopeSkippedRenaming: dynamicScope,
    flattenedFunctions,
    antiTamperActive: Boolean(settings.antiTamper && stringRuntime),
    obfuscatedProperties,
    guardedBranches,
    deadCodeBlocks
  } };
}

export { DEFAULTS };
