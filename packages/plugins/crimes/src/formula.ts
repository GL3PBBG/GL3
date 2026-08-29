/**
 * The sandboxed success-formula dialect — audit §7 item 5's runtime half
 * (spec 2026-08-26-mccodes-migrator-design §2.2). MCCodes stores each
 * crime's success chance as `crimePERCFORM`, a staff-authored PHP expression
 * `eval()`'d at execution; GL3 imports the arithmetic subset verbatim and
 * executes it as data, never code: a hand-rolled recursive-descent parser,
 * no `eval`, no `Function` constructor, nothing dynamic.
 *
 * Fidelity rules, both deliberate:
 * - The stat tokens (`LEVEL`, `CRIMEXP`, `EXP`, `WILL`, `IQ`) are
 *   case-SENSITIVE. MCCodes substitutes them with `str_replace`, which is
 *   itself case-sensitive — `level` was a PHP fatal in the source game, and
 *   it is a parse error here.
 * - Function names are case-INSENSITIVE (`MIN` == `min`), because PHP
 *   function-call semantics are, and a formula that ran in MCCodes must
 *   keep running here.
 *
 * `SKILL` is the one GL3-native token: the player's learned per-crime chance
 * (V2's `US_crimes` value, GL3's `player_crime_skill` row, 35 default). A
 * formula that references it is the hybrid model — progression-by-use feeding
 * a stat formula — and referencing it is also what makes the commit job grow
 * the skill (see `formulaUsesToken`). Imported MCCodes `crimePERCFORM` never
 * contains it, so the migrator's parse-validate of imports is unaffected.
 *
 * Division or modulo by zero cannot be caught at parse time (it depends on
 * a live player's stats), so `evaluateSuccessFormula` throws
 * `FormulaEvalError` and the caller decides — the commit job resolves the
 * attempt as 0% and logs, never crashing the resolve.
 *
 * Numbers stay JS `number`: exact for integers below 2^53, which decades of
 * `crimeXP` accumulation cannot reach (the counter would need ~225 trillion).
 * The final result clamps to 0–100 — outcome-equivalent to MCCodes'
 * unclamped `rand(1,100) <= sucrate`, so normalization, not divergence.
 */

export type FormulaTokenName = "LEVEL" | "CRIMEXP" | "EXP" | "WILL" | "IQ" | "SKILL";

export type FormulaContext = Readonly<Record<FormulaTokenName, number>>;

type FormulaFnName = "min" | "max" | "floor" | "ceil" | "round" | "abs";

export type FormulaNode =
  | { kind: "num"; value: number }
  | { kind: "token"; name: FormulaTokenName }
  | { kind: "neg"; operand: FormulaNode }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "%"; left: FormulaNode; right: FormulaNode }
  | { kind: "call"; fn: FormulaFnName; args: FormulaNode[] };

export class FormulaParseError extends Error {
  constructor(message: string, readonly position: number) {
    super(message);
    this.name = "FormulaParseError";
  }
}

export class FormulaEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaEvalError";
  }
}

const TOKEN_NAMES: readonly FormulaTokenName[] = ["LEVEL", "CRIMEXP", "EXP", "WILL", "IQ", "SKILL"];

const FUNCTIONS: Readonly<Record<FormulaFnName, { minArgs: number; maxArgs: number }>> = {
  min: { minArgs: 2, maxArgs: Number.MAX_SAFE_INTEGER },
  max: { minArgs: 2, maxArgs: Number.MAX_SAFE_INTEGER },
  floor: { minArgs: 1, maxArgs: 1 },
  ceil: { minArgs: 1, maxArgs: 1 },
  round: { minArgs: 1, maxArgs: 1 },
  abs: { minArgs: 1, maxArgs: 1 },
};

// --- tokenizer ---------------------------------------------------------------

type Tok =
  | { t: "num"; v: number; pos: number }
  | { t: "ident"; v: string; pos: number }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "%"; pos: number }
  | { t: "("; pos: number }
  | { t: ")"; pos: number }
  | { t: ","; pos: number };

function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < text.length && /[0-9]/.test(text[i]!)) i++;
      if (text[i] === "." && /[0-9]/.test(text[i + 1] ?? "")) {
        i++;
        while (i < text.length && /[0-9]/.test(text[i]!)) i++;
      }
      toks.push({ t: "num", v: Number(text.slice(start, i)), pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) i++;
      toks.push({ t: "ident", v: text.slice(start, i), pos: start });
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%") {
      toks.push({ t: "op", v: ch, pos: i });
      i++;
      continue;
    }
    if (ch === "(") { toks.push({ t: "(", pos: i }); i++; continue; }
    if (ch === ")") { toks.push({ t: ")", pos: i }); i++; continue; }
    if (ch === ",") { toks.push({ t: ",", pos: i }); i++; continue; }
    throw new FormulaParseError(`unexpected character ${JSON.stringify(ch)}`, i);
  }
  return toks;
}

// --- parser ------------------------------------------------------------------
//
// expr   := term (('+'|'-') term)*
// term   := unary (('*'|'/'|'%') unary)*
// unary  := '-' unary | primary
// primary:= NUMBER | TOKEN | FN '(' expr (',' expr)* ')' | '(' expr ')'

export function parseSuccessFormula(text: string): FormulaNode {
  if (text.trim().length === 0) throw new FormulaParseError("formula is empty", 0);
  const toks = tokenize(text);
  let cursor = 0;

  function parseExpr(): FormulaNode {
    let left = parseTerm();
    for (;;) {
      const tok = toks[cursor];
      if (tok?.t !== "op" || (tok.v !== "+" && tok.v !== "-")) break;
      cursor++;
      left = { kind: "binary", op: tok.v, left, right: parseTerm() };
    }
    return left;
  }

  function parseTerm(): FormulaNode {
    let left = parseUnary();
    for (;;) {
      const tok = toks[cursor];
      if (tok?.t !== "op" || (tok.v !== "*" && tok.v !== "/" && tok.v !== "%")) break;
      cursor++;
      left = { kind: "binary", op: tok.v, left, right: parseUnary() };
    }
    return left;
  }

  function parseUnary(): FormulaNode {
    const tok = toks[cursor];
    if (tok?.t === "op" && tok.v === "-") {
      cursor++;
      return { kind: "neg", operand: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): FormulaNode {
    const tok = toks[cursor];
    if (tok === undefined) {
      throw new FormulaParseError("formula ends where an operand was expected", text.length);
    }
    if (tok.t === "num") { cursor++; return { kind: "num", value: tok.v }; }
    if (tok.t === "(") {
      cursor++;
      const inner = parseExpr();
      const close = toks[cursor];
      if (close?.t !== ")") {
        throw new FormulaParseError("missing closing parenthesis", close?.pos ?? text.length);
      }
      cursor++;
      return inner;
    }
    if (tok.t === "ident") {
      cursor++;
      // Tokens first, case-sensitively — the str_replace fidelity rule above.
      if ((TOKEN_NAMES as readonly string[]).includes(tok.v)) {
        return { kind: "token", name: tok.v as FormulaTokenName };
      }
      // Then functions, case-insensitively — PHP call semantics.
      const fn = tok.v.toLowerCase();
      if (fn in FUNCTIONS) {
        const open = toks[cursor];
        if (open?.t !== "(") {
          throw new FormulaParseError(`expected '(' after ${tok.v}`, open?.pos ?? text.length);
        }
        cursor++;
        const args: FormulaNode[] = [];
        if (toks[cursor]?.t === ")") {
          cursor++;
        } else {
          for (;;) {
            args.push(parseExpr());
            const next = toks[cursor];
            if (next?.t === ",") { cursor++; continue; }
            if (next?.t === ")") { cursor++; break; }
            throw new FormulaParseError(
              `expected ',' or ')' in ${tok.v}(...) argument list`, next?.pos ?? text.length,
            );
          }
        }
        const arity = FUNCTIONS[fn as FormulaFnName]!;
        if (args.length < arity.minArgs || args.length > arity.maxArgs) {
          const wanted = arity.minArgs === arity.maxArgs
            ? String(arity.minArgs)
            : `${arity.minArgs}+`;
          throw new FormulaParseError(`${fn} expects ${wanted} argument(s), got ${args.length}`, tok.pos);
        }
        return { kind: "call", fn: fn as FormulaFnName, args };
      }
      throw new FormulaParseError(
        `unknown identifier ${JSON.stringify(tok.v)} — the dialect allows only ` +
          "LEVEL, CRIMEXP, EXP, WILL, IQ, SKILL, min, max, floor, ceil, round, abs",
        tok.pos,
      );
    }
    throw new FormulaParseError(
      `unexpected ${tok.t === "op" ? JSON.stringify(tok.v) : tok.t}`, tok.pos,
    );
  }

  const root = parseExpr();
  const trailing = toks[cursor];
  if (trailing !== undefined) {
    throw new FormulaParseError("unexpected trailing input", trailing.pos);
  }
  return root;
}

// --- evaluator -----------------------------------------------------------------

/**
 * Whether the formula references the named token anywhere in its tree. The
 * commit job's growth gate: a formula crime grows `player_crime_skill` iff
 * its formula reads `SKILL` — a formula that never consults the learned
 * chance has no business silently accumulating one.
 */
export function formulaUsesToken(formula: FormulaNode, name: FormulaTokenName): boolean {
  switch (formula.kind) {
    case "num":
      return false;
    case "token":
      return formula.name === name;
    case "neg":
      return formulaUsesToken(formula.operand, name);
    case "binary":
      return formulaUsesToken(formula.left, name) || formulaUsesToken(formula.right, name);
    case "call":
      return formula.args.some((arg) => formulaUsesToken(arg, name));
  }
}

export function evaluateSuccessFormula(formula: FormulaNode, ctx: FormulaContext): number {
  const value = evalNode(formula, ctx);
  if (!Number.isFinite(value)) throw new FormulaEvalError("formula produced a non-finite result");
  return Math.max(0, Math.min(100, value));
}

function evalNode(node: FormulaNode, ctx: FormulaContext): number {
  switch (node.kind) {
    case "num":
      return node.value;
    case "token":
      return ctx[node.name];
    case "neg":
      return -evalNode(node.operand, ctx);
    case "binary": {
      const left = evalNode(node.left, ctx);
      const right = evalNode(node.right, ctx);
      switch (node.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/":
          if (right === 0) throw new FormulaEvalError("division by zero");
          return left / right;
        case "%":
          // PHP's % casts both operands to int before dividing; JS % is
          // float remainder. The truncation keeps `10.5 % 3` at 1 (PHP)
          // rather than 1.5.
          if (Math.trunc(right) === 0) throw new FormulaEvalError("modulo by zero");
          return Math.trunc(left) % Math.trunc(right);
      }
    }
    case "call": {
      const args = node.args.map((arg) => evalNode(arg, ctx));
      switch (node.fn) {
        case "min": return Math.min(...args);
        case "max": return Math.max(...args);
        case "floor": return Math.floor(args[0]!);
        case "ceil": return Math.ceil(args[0]!);
        case "round": return Math.round(args[0]!);
        case "abs": return Math.abs(args[0]!);
      }
    }
  }
}
