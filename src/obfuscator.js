import * as acorn from "acorn";
import eslintScope from "eslint-scope";
import estraverse from "estraverse";
import escodegen from "escodegen";

const RESERVED = new Set(("await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new package private protected public return static super switch this throw true try typeof var void while with yield null").split(" "));
const DEFAULTS = Object.freeze({
  seed: 1,
  compact: true,
  renameVariables: true,
  stringArray: true,
  numbersToExpressions: true,
  simplifyBranches: true
});

function randomSource(seed) {
  let state = (Number(seed) >>> 0) || 0x6d2b79f5;
  return function next(max) {
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
        const parent = parents.get(identifier);
        if (parent && parent.type === "Property" && parent.shorthand && parent.value === identifier) {
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

function isDirective(parent, node) {
  return parent && parent.type === "ExpressionStatement" && parent.expression === node &&
    typeof parent.directive === "string";
}

function encodeStrings(ast, next, used) {
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
  const decodeName = freshIdentifier(used, next);
  const key = 1 + next(255);
  const encoded = order.map(originalIndex => {
    const value = strings[originalIndex];
    const units = [];
    for (let i = 0; i < value.length; i++) units.push(value.charCodeAt(i) ^ key);
    return { type: "ArrayExpression", elements: units.map(value => ({ type: "Literal", value })) };
  });

  const decoder = parse(
    "function " + decodeName + "(i){var a=" + tableName + "[i],s=\"\";for(var j=0;j<a.length;j++)s+=String.fromCharCode(a[j]^" + key + ");return s}"
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
  return [table, decoder];
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
  const dynamicScope = hasDynamicScope(ast);
  if (settings.renameVariables && !dynamicScope) renameBindings(ast, next);

  const used = new Set();
  estraverse.traverse(ast, { enter(node) { if (node.type === "Identifier") used.add(node.name); } });
  let runtime = null;
  if (settings.stringArray) runtime = encodeStrings(ast, next, used);
  if (settings.numbersToExpressions) transformNumbers(ast, next);
  if (settings.simplifyBranches) mutateBranches(ast);
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
    dynamicScopeSkippedRenaming: dynamicScope
  } };
}

export { DEFAULTS };
