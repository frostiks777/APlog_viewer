/**
 * API-сценарий правил и фильтров: сохранение, битый regex, нормализация, панель.
 * Исходные правила и фильтры восстанавливаются в finally.
 * Запуск: node scripts/check-rules.mjs [baseUrl]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:7801';

let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    console.log(`FAIL ${name}: ${JSON.stringify(detail)}`);
    failed += 1;
  }
}

async function get(path) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function send(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

const original = await get('/api/v1/profile');

const baseRule = {
  id: 'test-rule',
  enabled: true,
  match: 'NEEDLE',
  isRegex: false,
  caseSensitive: true,
  invert: false,
  fg: '#ffffff',
  bg: '#b3261e',
  bold: true,
  priority: 77,
  scope: 'global',
  tabId: null,
};

try {
  let result = await send('PUT', '/api/v1/rules', { rules: [...original.rules, baseRule] });
  check('PUT /rules отвечает 200', result.status === 200, result.status);
  check(
    'правило сохранено с приоритетом',
    result.json?.rules?.some((rule) => rule.id === 'test-rule' && rule.priority === 77),
    result.json?.rules,
  );
  let profile = await get('/api/v1/profile');
  check('правило видно в профиле', profile.rules.some((rule) => rule.id === 'test-rule'));

  const broken = { ...baseRule, id: 'test-broken', match: '(', isRegex: true };
  result = await send('PUT', '/api/v1/rules', { rules: [...original.rules, baseRule, broken] });
  check('битый regex не даёт HTTP-ошибку', result.status === 200, result.status);
  check('битый regex вернул issue', result.json?.issues?.some((issue) => issue.id === 'test-broken'), result.json?.issues);
  check(
    'текст битого выражения сохранён',
    result.json?.rules?.find((rule) => rule.id === 'test-broken')?.match === '(',
    result.json?.rules?.find((rule) => rule.id === 'test-broken'),
  );

  const weird = { ...baseRule, id: 'test-color', fg: 'red; background:url(x)', bg: '#FFF' };
  result = await send('PUT', '/api/v1/rules', { rules: [weird] });
  const colorRule = result.json?.rules?.find((rule) => rule.id === 'test-color');
  check('невалидный цвет заменён на безопасный', colorRule?.fg === '#ffffff', colorRule);
  check('короткий hex нормализован', colorRule?.bg === '#ffffff', colorRule);

  result = await send('PUT', '/api/v1/filters', {
    filters: [
      {
        id: 'test-filter',
        enabled: true,
        mode: 'include',
        match: 'ERROR',
        isRegex: false,
        caseSensitive: true,
        tabId: null,
      },
    ],
  });
  check('PUT /filters отвечает 200', result.status === 200, result.status);
  check('фильтр сохранён', result.json?.filters?.some((rule) => rule.id === 'test-filter'), result.json?.filters);
  profile = await get('/api/v1/profile');
  check('фильтр виден в профиле', profile.filters.some((rule) => rule.id === 'test-filter'));

  result = await send('PATCH', '/api/v1/ui', {
    panels: { rulesOpen: true, rulesWidth: 420, rulesTab: 'filters' },
  });
  check('PATCH /ui отвечает 200', result.status === 200, result.status);
  check(
    'панель сохранена',
    result.json?.panels?.rulesOpen === true &&
      result.json?.panels?.rulesWidth === 420 &&
      result.json?.panels?.rulesTab === 'filters',
    result.json?.panels,
  );

  result = await send('PATCH', '/api/v1/ui', { panels: { rulesWidth: 10 } });
  check('ширина панели зажата снизу', result.json?.panels?.rulesWidth === 300, result.json?.panels);
} finally {
  await send('PUT', '/api/v1/rules', { rules: original.rules });
  await send('PUT', '/api/v1/filters', { filters: original.filters });
  await send('PATCH', '/api/v1/ui', { panels: original.ui.panels });
}

process.exitCode = failed === 0 ? 0 : 1;
