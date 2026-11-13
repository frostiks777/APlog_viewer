/**
 * Юнит-сценарий чистой семантики правил (без браузера и сервера).
 * Запуск: node scripts/check-rules-semantics.mjs
 * Node 26 исполняет .ts напрямую, отдельный сборщик не нужен.
 */
import { compileMatcher, styleIdsFor, visibleFlags, ruleAppliesToTab, filterAppliesToTab } from '../web/src/rules/evaluate.ts';

let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    console.log(`FAIL ${name}: ${JSON.stringify(detail)}`);
    failed += 1;
  }
}

function compiled(rules) {
  return rules.map((rule) => compileMatcher(rule).matcher).filter((matcher) => matcher !== null);
}

const errorRule = { id: 'error', match: 'ERROR', isRegex: false, caseSensitive: true };
const warnRule = { id: 'warn', match: 'WARN', isRegex: false, caseSensitive: true };
const exceptionRule = { id: 'exception', match: 'Exception|Ошибка', isRegex: true, caseSensitive: false };

// Приоритет: список уже отсортирован, побеждает первое совпавшее правило.
const ordered = compiled([errorRule, exceptionRule]);
const styles = styleIdsFor(['ERROR Exception', 'just Exception', 'plain'], ordered);
check('первое правило по приоритету побеждает', styles[0] === 'error', styles);
check('второе правило работает там, где нет первого', styles[1] === 'exception', styles);
check('без совпадений стиля нет', styles[2] === null, styles);

// Регистр.
const caseSensitive = compiled([errorRule]);
const caseInsensitive = compiled([{ ...errorRule, caseSensitive: false }]);
check('регистр учитывается', styleIdsFor(['error'], caseSensitive)[0] === null);
check('регистр игнорируется по флагу', styleIdsFor(['error'], caseInsensitive)[0] === 'error');

// Пустой паттерн не матчит и не считается ошибкой.
const empty = compileMatcher({ id: 'empty', match: '', isRegex: false, caseSensitive: true });
check('пустой паттерн — не ошибка', empty.error === null && empty.matcher === null, empty);

// Битый regex возвращает текст ошибки, а не бросает.
const broken = compileMatcher({ id: 'broken', match: '(', isRegex: true, caseSensitive: true });
check('битый regex даёт ошибку', broken.matcher === null && typeof broken.error === 'string', broken);

// Видимость: include/exclude.
const includeError = compiled([errorRule]);
const excludeWarn = compiled([warnRule]);
const flags = visibleFlags(['ERROR', 'WARN', 'ERROR WARN'], includeError, excludeWarn);
check('include оставляет совпавшие', flags[0] === 1, Array.from(flags));
check('include скрывает несовпавшие', flags[1] === 0, Array.from(flags));
check('exclude сильнее include', flags[2] === 0, Array.from(flags));

const allVisible = visibleFlags(['ERROR', 'WARN'], [], []);
check('без фильтров видно всё', allVisible[0] === 1 && allVisible[1] === 1, Array.from(allVisible));

const emptyInclude = visibleFlags(['ERROR'], [], excludeWarn);
check('пустой include ничего не ограничивает', emptyInclude[0] === 1, Array.from(emptyInclude));

// Область действия.
check(
  'глобальное правило действует на любой вкладке',
  ruleAppliesToTab({ scope: 'global', tabId: null }, 'tab-a') &&
    ruleAppliesToTab({ scope: 'global', tabId: null }, 'tab-b'),
);
check(
  'правило вкладки действует только на своей',
  ruleAppliesToTab({ scope: 'tab', tabId: 'tab-a' }, 'tab-a') &&
    !ruleAppliesToTab({ scope: 'tab', tabId: 'tab-a' }, 'tab-b'),
);
check('фильтр без вкладки действует везде', filterAppliesToTab({ tabId: null }, 'tab-a'));
check(
  'фильтр вкладки не действует на чужой',
  !filterAppliesToTab({ tabId: 'tab-a' }, 'tab-b'),
);

process.exitCode = failed === 0 ? 0 : 1;
