// CVE-2026-93753: Jest's configuration merger must not inherit source or target prototypes.
const { createRequire } = require('module');
const jestRequire = createRequire(require.resolve('jest/package.json'));
const coreRequire = createRequire(jestRequire.resolve('@jest/core/package.json'));
const configRequire = createRequire(coreRequire.resolve('jest-config/package.json'));
const merge = configRequire('deepmerge');

test('rejects prototype keys on both merge inputs while preserving normal merges', () => {
  const poison = JSON.parse('{"__proto__":{"admin":true},"safe":{"value":1}}');
  for (const target of [{}, Object.create(null), JSON.parse('{"__proto__":{"admin":true}}'), {session: null}]) {
    const result = merge(target, poison);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.admin).toBeUndefined();
    expect(result.safe.value).toBe(1);
  }
  const result = merge({session: null}, {session: poison});
  expect(Object.getPrototypeOf(result.session)).toBe(Object.prototype);
  expect(result.session.admin).toBeUndefined();
  expect(merge({items: [1], nested: {a: 1}}, {items: [2], nested: {b: 2}})).toEqual({items: [1, 2], nested: {a: 1, b: 2}});
});
