/**
 * Чистая семантика правил: компиляция matcher, выбор стиля по приоритету и видимость
 * строки. Ни React, ни DOM — поэтому функции проверяются юнит-сценарием и одинаково
 * работают в главном потоке и в воркере.
 */

export interface MatchRule {
  id: string;
  match: string;
  isRegex: boolean;
  caseSensitive: boolean;
}

export interface CompiledMatcher {
  id: string;
  test: (text: string) => boolean;
}

export interface CompileOutcome {
  matcher: CompiledMatcher | null;
  error: string | null;
}

/**
 * Пустое выражение не матчит ничего и НЕ является ошибкой: иначе фильтр «выключил бы всё»
 * в тот момент, когда пользователь стёр паттерн, чтобы набрать новый.
 */
export function compileMatcher(rule: MatchRule): CompileOutcome {
  if (!rule.match) return { matcher: null, error: null };

  if (rule.isRegex) {
    try {
      // Без флага g: lastIndex у общего regex делал бы результат зависящим от порядка строк.
      const expression = new RegExp(rule.match, rule.caseSensitive ? '' : 'i');
      return { matcher: { id: rule.id, test: (text) => expression.test(text) }, error: null };
    } catch (cause) {
      return { matcher: null, error: (cause as Error).message };
    }
  }

  const needle = rule.caseSensitive ? rule.match : rule.match.toLowerCase();
  return {
    matcher: {
      id: rule.id,
      test: rule.caseSensitive
        ? (text) => text.includes(needle)
        : (text) => text.toLowerCase().includes(needle),
    },
    error: null,
  };
}

/**
 * Область действия. Глобальное правило работает везде, правило вкладки — только на своей
 * (после нормализации профиля tabId у него всегда есть).
 */
export function ruleAppliesToTab(
  rule: { scope: 'global' | 'tab'; tabId: string | null },
  tabId: string | null,
): boolean {
  if (rule.scope === 'global') return true;
  return rule.tabId !== null && rule.tabId === tabId;
}

/** У фильтра нет отдельного scope: tabId === null означает «все вкладки». */
export function filterAppliesToTab(rule: { tabId: string | null }, tabId: string | null): boolean {
  return rule.tabId === null || rule.tabId === tabId;
}

/**
 * Первое совпавшее правило выигрывает, поэтому matchers обязаны идти по убыванию
 * приоритета. Заполняем только пустые ячейки — это тот же результат, что «для каждой
 * строки искать первое правило», но без повторных проходов по уже раскрашенным строкам.
 *
 * `onRule` вызывается ПЕРЕД матчингом очередного правила: по нему вотчдог понимает, на ком
 * именно завис воркер. Объявлять на этапе компиляции нельзя — компиляция не зависает.
 */
export function styleIdsFor(
  texts: string[],
  matchers: CompiledMatcher[],
  onRule?: (ruleId: string) => void,
): Array<string | null> {
  const styles: Array<string | null> = new Array(texts.length).fill(null);
  for (const matcher of matchers) {
    onRule?.(matcher.id);
    for (let index = 0; index < texts.length; index += 1) {
      if (styles[index] !== null) continue;
      const text = texts[index];
      if (text !== undefined && matcher.test(text)) styles[index] = matcher.id;
    }
  }
  return styles;
}

/**
 * visible = (нет include ИЛИ совпал хоть один include) И НЕ exclude.
 * Пустой include-список означает «показывать всё», а не «скрыть всё».
 * `onRule` — см. styleIdsFor: вызывается перед матчингом каждого правила.
 */
export function visibleFlags(
  texts: string[],
  include: CompiledMatcher[],
  exclude: CompiledMatcher[],
  onRule?: (ruleId: string) => void,
): Uint8Array {
  const visible = new Uint8Array(texts.length);

  if (include.length === 0) {
    visible.fill(1);
  } else {
    // Нельзя гасить видимость последовательно: при нескольких include это превратилось бы
    // в «совпали все». Собираем попадания, потом применяем один раз.
    for (const matcher of include) {
      onRule?.(matcher.id);
      for (let index = 0; index < texts.length; index += 1) {
        if (visible[index]) continue;
        const text = texts[index];
        if (text !== undefined && matcher.test(text)) visible[index] = 1;
      }
    }
  }

  for (const matcher of exclude) {
    onRule?.(matcher.id);
    for (let index = 0; index < texts.length; index += 1) {
      if (!visible[index]) continue;
      const text = texts[index];
      if (text !== undefined && matcher.test(text)) visible[index] = 0;
    }
  }

  return visible;
}
