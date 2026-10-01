/**
 * The `weapp` ESLint plugin: three rules for code that runs in the WeChat mini-program
 * (apps/mini, @shop/storefront-blocks, the runtime of @shop/api-client). Each one stands for a
 * class of bug AGENTS.md lists because it shipped more than once:
 *
 * - `weapp/no-unsupported-regex` (rule 14): a regex iOS 12's JavaScriptCore cannot compile.
 *   A lookbehind `(?<=…)` / `(?<!…)` is ES2018, so Babel and the build's ES2018 parse
 *   (scripts/size-report.mjs) both let it through, and Safari only learned it in 16.4: the
 *   whole script fails to load on the phone. The `d` and `v` flags are later still.
 * - `weapp/no-void-handler` (rule 17): `onClick={() => void pay()}` throws the promise away,
 *   so `Pressable`'s double-tap lock never engages and a second tap pays twice. The handler
 *   returns the promise instead. Fixable.
 * - `weapp/no-raw-error-text` (rule 1): an error's own text — `error.message`, WeChat's
 *   `errMsg`, `String(error)` — reaching something a shopper reads: JSX, a toast or modal, a
 *   form's error setter, or a `title` / `message` / `content`… field. A runtime's `TypeError` and
 *   WeChat's `requestPayment:fail …` are English. Pass the error through the app's
 *   `errorMessage(error, fallback)` instead. Text read under an `isApiError(x)`,
 *   `ApiError.is(x)` or `x instanceof ApiError` check is the server's Chinese and is allowed.
 *
 * The last two also run in the admin (apps/web), under the plugin name `ui`: see ./ui.js.
 *
 * Not type-aware, like the rest of the preset: it goes by names. An "error" is a variable called
 * `e`, `err`, `error`, `ex`, `exception` or `cause`, or ending in `Error` / `Err` / `Exception`,
 * or a property called `error` / `err` or ending in `Error` (`query.error`, `code.loadError`).
 */

/** @param {import('estree').Node | null | undefined} node */
const nameOf = (node) => {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
};

// ---------------------------------------------------------------------------
// no-unsupported-regex
// ---------------------------------------------------------------------------

/**
 * Whether a regex source has a lookbehind, reading escapes and character classes the way the
 * regex engine does (`\(?<=` and `[(?<=]` are not one; `(?<name>` is a named group).
 * @param {string} pattern
 */
export function hasLookbehind(pattern) {
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char === '(' && pattern[i + 1] === '?' && pattern[i + 2] === '<') {
      const next = pattern[i + 3];
      if (next === '=' || next === '!') return true;
    }
  }
  return false;
}

/** @param {import('estree').Node | undefined} node */
function staticString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
const noUnsupportedRegex = {
  meta: {
    type: 'problem',
    docs: { description: 'Regex syntax iOS 12 cannot compile (lookbehind, d/v flags).' },
    schema: [],
    messages: {
      lookbehind:
        'iOS 16.4 以前不支持正则后行断言 (?<= / (?<!，整个脚本在老 iPhone 上加载失败；改写成捕获组或手工判断',
      flag: 'iOS 12 不支持正则的 {{flag}} 标志',
    },
  },
  create(context) {
    /**
     * @param {import('estree').Node} node
     * @param {string | null} pattern
     * @param {string | null} flags
     */
    const check = (node, pattern, flags) => {
      if (pattern !== null && hasLookbehind(pattern)) {
        context.report({ node, messageId: 'lookbehind' });
      }
      for (const flag of ['d', 'v']) {
        if (flags?.includes(flag)) context.report({ node, messageId: 'flag', data: { flag } });
      }
    };
    /** @param {import('estree').NewExpression | import('estree').CallExpression} node */
    const constructed = (node) => {
      if (node.callee.type !== 'Identifier' || node.callee.name !== 'RegExp') return;
      const [source, flags] = /** @type {import('estree').Node[]} */ (node.arguments);
      check(node, staticString(source), staticString(flags));
    };
    return {
      Literal(node) {
        if ('regex' in node && node.regex) check(node, node.regex.pattern, node.regex.flags);
      },
      NewExpression: constructed,
      CallExpression: constructed,
    };
  },
};

// ---------------------------------------------------------------------------
// no-void-handler
// ---------------------------------------------------------------------------

/** @type {import('eslint').Rule.RuleModule} */
const noVoidHandler = {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: {
      description: 'An on* prop handler returns its promise instead of `void`-ing it (AGENTS 17).',
    },
    schema: [],
    messages: {
      void: '事件处理函数要返回 promise（`() => {{call}}`），不要 `void`：否则按钮的防连点锁不生效（AGENTS.md 17）',
    },
  },
  create(context) {
    const source = context.sourceCode ?? context.getSourceCode();
    /**
     * `void message.success(…)`: antd's toast returns a thenable that settles when the toast
     * closes, seconds later. Dropping it is right; returning it would hold up whoever awaits the
     * handler (a form's `onSuccess`) until the toast is gone.
     */
    const isToast = (expression) =>
      expression.type === 'CallExpression' &&
      expression.callee.type === 'MemberExpression' &&
      /^(message|notification)$/.test(nameOf(expression.callee.object) ?? '');
    /** `pay(…)` for the message, however long the call. */
    const shortly = (expression) =>
      expression.type === 'CallExpression'
        ? `${source.getText(expression.callee)}(${expression.arguments.length ? '…' : ''})`
        : source.getText(expression).split('\n')[0];
    return {
      /** @param {any} node */
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier' || !/^on[A-Z]/.test(node.name.name)) return;
        const fn = node.value?.type === 'JSXExpressionContainer' ? node.value.expression : null;
        if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) {
          return;
        }
        const body = fn.body;
        if (
          body.type === 'UnaryExpression' &&
          body.operator === 'void' &&
          !isToast(body.argument)
        ) {
          context.report({
            node: body,
            messageId: 'void',
            data: { call: shortly(body.argument) },
            fix: (fixer) => fixer.removeRange([body.range[0], body.argument.range[0]]),
          });
          return;
        }
        if (body.type !== 'BlockStatement') return;
        const statements = body.body;
        statements.forEach((statement, index) => {
          if (
            statement.type !== 'ExpressionStatement' ||
            statement.expression.type !== 'UnaryExpression' ||
            statement.expression.operator !== 'void' ||
            isToast(statement.expression.argument)
          ) {
            return;
          }
          const expression = statement.expression;
          const last = index === statements.length - 1;
          context.report({
            node: expression,
            messageId: 'void',
            data: { call: shortly(expression.argument) },
            // Only the last statement can simply return its promise.
            ...(last
              ? {
                  fix: (fixer) =>
                    fixer.replaceTextRange(
                      [expression.range[0], expression.argument.range[0]],
                      'return ',
                    ),
                }
              : {}),
          });
        });
      },
    };
  },
};

// ---------------------------------------------------------------------------
// no-raw-error-text
// ---------------------------------------------------------------------------

/** A variable holding an error (a caught value, a callback's argument). */
const ERRORISH_NAME = /^_?(e|err|error|ex|exc|exception|cause)$|(Error|Err|Exception)$/;
/** A property holding one (`query.error`, `result.loadError`); not `refund.reason`, which is data. */
const ERRORISH_PROPERTY = /^(err|error)$|(Error|Exception)$/;

/** Object keys whose value a shopper reads. */
const TEXT_KEYS = new Set([
  'title',
  'content',
  'message',
  'text',
  'description',
  'desc',
  'label',
  'hint',
  'tip',
  'tips',
  'placeholder',
  'errorText',
  'errorMessage',
  'notice',
]);

/** A variable named for text someone reads (`errorText`, `codeError`, `message`). */
const TEXT_VARIABLE =
  /^(message|text|title|hint|tip|notice)$|(Error|Message|Text|Title|Hint|Tip|Notice)$/;

/** A call that puts its arguments in front of the shopper. */
function isSink(callee) {
  const names = [];
  let node = callee;
  while (node) {
    if (node.type === 'Identifier') {
      names.unshift(node.name);
      break;
    }
    if (node.type === 'MemberExpression') {
      const name = node.computed ? nameOf(node.property) : node.property.name;
      if (name) names.unshift(name);
      node = node.object;
      continue;
    }
    break;
  }
  const last = names[names.length - 1] ?? '';
  if (names.some((name) => /^(toast|modal|showToast|showModal|notify|alert)$/i.test(name))) {
    return true;
  }
  return /^set[A-Z]\w*(Error|Errors|Message|Notice|Hint|Tip|Text|Title|Reason)$/.test(last);
}

/** @param {any} node */
function isErrorish(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return ERRORISH_NAME.test(node.name);
  if (node.type === 'MemberExpression' && !node.computed) {
    return ERRORISH_PROPERTY.test(node.property.name);
  }
  if (node.type === 'ChainExpression') return isErrorish(node.expression);
  if (node.type === 'TSNonNullExpression' || node.type === 'TSAsExpression') {
    return isErrorish(node.expression);
  }
  return false;
}

/** String methods whose result is still the raw text. */
const TEXT_TRANSFORMS = new Set([
  'slice',
  'substring',
  'substr',
  'trim',
  'trimStart',
  'trimEnd',
  'replace',
  'toUpperCase',
  'toLowerCase',
  'concat',
  'padStart',
  'padEnd',
]);

/**
 * Whether `test` holds only when `subject` (source text) is an `ApiError`: `isApiError(x, …)`,
 * `x instanceof ApiError`, or either inside an `&&`.
 */
function asserts(test, subject, source) {
  if (!test) return false;
  if (test.type === 'LogicalExpression' && test.operator === '&&') {
    return asserts(test.left, subject, source) || asserts(test.right, subject, source);
  }
  // `isApiError(x)` (the mini) or `ApiError.is(x)` (the admin).
  const callee = test.type === 'CallExpression' ? test.callee : null;
  const isGuard =
    (callee?.type === 'Identifier' && callee.name === 'isApiError') ||
    (callee?.type === 'MemberExpression' &&
      !callee.computed &&
      nameOf(callee.object) === 'ApiError' &&
      callee.property.name === 'is');
  if (isGuard && test.arguments[0] && source.getText(test.arguments[0]) === subject) {
    return true;
  }
  return (
    test.type === 'BinaryExpression' &&
    test.operator === 'instanceof' &&
    test.right.type === 'Identifier' &&
    test.right.name === 'ApiError' &&
    source.getText(test.left) === subject
  );
}

/** Whether `test` is false only when `subject` is an `ApiError`: `!isApiError(x) || …`. */
function refutes(test, subject, source) {
  if (test.type === 'LogicalExpression' && test.operator === '||') {
    return refutes(test.left, subject, source) || refutes(test.right, subject, source);
  }
  return (
    test.type === 'UnaryExpression' &&
    test.operator === '!' &&
    asserts(test.argument, subject, source)
  );
}

/** `if (!isApiError(x)) return …;` (or `if (!isApiError(x) || …) return …;`). */
function refutesThenExits(statement, subject, source) {
  if (statement.type !== 'IfStatement' || statement.alternate) return false;
  const { test, consequent } = statement;
  if (!refutes(test, subject, source)) return false;
  const exit = consequent.type === 'BlockStatement' ? consequent.body.at(-1) : consequent;
  return exit?.type === 'ReturnStatement' || exit?.type === 'ThrowStatement';
}

const within = (node, outer) =>
  outer && node.range[0] >= outer.range[0] && node.range[1] <= outer.range[1];

/** Whether the text at `node` is known to be an `ApiError`'s (the server's Chinese). */
function guarded(node, subject, source) {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (
      (parent.type === 'IfStatement' || parent.type === 'ConditionalExpression') &&
      ((within(node, parent.consequent) && asserts(parent.test, subject, source)) ||
        (within(node, parent.alternate) && refutes(parent.test, subject, source)))
    ) {
      return true;
    }
    if (
      parent.type === 'LogicalExpression' &&
      parent.operator === '&&' &&
      within(node, parent.right) &&
      asserts(parent.left, subject, source)
    ) {
      return true;
    }
    if (parent.type === 'BlockStatement' || parent.type === 'Program') {
      for (const statement of parent.body) {
        if (statement === child) break;
        if (refutesThenExits(statement, subject, source)) return true;
      }
    }
  }
  return false;
}

/**
 * Where the raw text at `node` ends up: 'shown' when it reaches JSX, a sink call, a text field
 * or a variable named for text; `null` when it is consumed by anything else first (a log call,
 * a comparison, another variable, a `new Error(…)`), which the rule does not follow.
 */
function destination(node) {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    switch (parent.type) {
      case 'TemplateLiteral':
      case 'LogicalExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
      case 'TSSatisfiesExpression':
      case 'ChainExpression':
      case 'ObjectExpression':
      case 'ArrayExpression':
      case 'SpreadElement':
        continue;
      case 'BinaryExpression':
        if (parent.operator === '+') continue;
        return null;
      case 'ConditionalExpression':
        if (child === parent.test) return null;
        continue;
      case 'MemberExpression':
        if (
          child === parent.object &&
          !parent.computed &&
          TEXT_TRANSFORMS.has(parent.property.name)
        ) {
          continue;
        }
        return null;
      case 'CallExpression':
        if (child === parent.callee) continue; // error.message.slice(…)(…) — the call of a transform
        return isSink(parent.callee) ? 'shown' : null;
      case 'Property':
        if (child === parent.value && !parent.computed && TEXT_KEYS.has(nameOf(parent.key))) {
          return 'shown';
        }
        if (child === parent.value) continue;
        return null;
      case 'JSXExpressionContainer':
        return 'shown';
      case 'VariableDeclarator':
        // `const codeError = q.error.message` and then `{codeError}`: the name says what it is for.
        return child === parent.init &&
          parent.id.type === 'Identifier' &&
          TEXT_VARIABLE.test(parent.id.name)
          ? 'shown'
          : null;
      default:
        return null;
    }
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
const noRawErrorText = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "An error's own text (message, errMsg, String(error)) never reaches the shopper (AGENTS 1).",
    },
    schema: [],
    messages: {
      raw: '不要把错误原文（{{what}}）显示给人看：运行时、浏览器和微信的报错是英文。用 errorMessage(error, "…") 给中文提示，原文进日志（AGENTS.md 1）',
    },
  },
  create(context) {
    const source = context.sourceCode ?? context.getSourceCode();
    /**
     * @param {any} node the raw text
     * @param {any} subject the error it came from, for the ApiError guard; null for `errMsg`
     */
    const consider = (node, subject) => {
      if (destination(node) !== 'shown') return;
      if (subject && guarded(node, source.getText(subject), source)) return;
      context.report({ node, messageId: 'raw', data: { what: source.getText(node) } });
    };
    return {
      /** @param {any} node */
      MemberExpression(node) {
        const property = node.computed ? nameOf(node.property) : node.property.name;
        if (property === 'errMsg') consider(node, null);
        else if (property === 'message' && isErrorish(node.object)) consider(node, node.object);
        else if (
          property === 'toString' &&
          isErrorish(node.object) &&
          node.parent.type === 'CallExpression' &&
          node.parent.callee === node
        ) {
          consider(node.parent, node.object);
        }
      },
      /** @param {any} node */
      CallExpression(node) {
        const [first] = node.arguments;
        if (!isErrorish(first)) return;
        const callee = node.callee;
        const isString = callee.type === 'Identifier' && callee.name === 'String';
        const isStringify =
          callee.type === 'MemberExpression' &&
          nameOf(callee.object) === 'JSON' &&
          callee.property.name === 'stringify';
        if (isString || isStringify) consider(node, first);
      },
      /** @param {any} node */
      TemplateLiteral(node) {
        for (const expression of node.expressions) {
          if (isErrorish(expression)) consider(node, expression);
        }
      },
      /** @param {any} node */
      BinaryExpression(node) {
        if (node.operator !== '+') return;
        const text = (side) => side.type === 'Literal' && typeof side.value === 'string';
        if (isErrorish(node.left) && text(node.right)) consider(node, node.left);
        else if (isErrorish(node.right) && text(node.left)) consider(node, node.right);
      },
    };
  },
};

export const weappPlugin = {
  meta: { name: 'weapp' },
  rules: {
    'no-unsupported-regex': noUnsupportedRegex,
    'no-void-handler': noVoidHandler,
    'no-raw-error-text': noRawErrorText,
  },
};

export default weappPlugin;
