import { expect, it } from 'vitest';
import { validateRoleSessionLocation as validate } from '../src/main/roleSession.js';
it('rejects login and foreign-origin storage but accepts a business page with secret fields', () => {
  expect(() => validate('https://app.test/login?redirect=/index', 'https://app.test/')).toThrow('AUTH_REQUIRED');
  expect(() => validate('https://other.test/index', 'https://app.test/')).toThrow('AUTH_REQUIRED');
  expect(() => validate('https://app.test/index', 'https://app.test/', undefined, true)).toThrow('AUTH_REQUIRED');
  expect(() => validate('https://app.test/channel', 'https://app.test/', undefined, false)).not.toThrow();
});
it('uses the configured hash login route without rejecting the authenticated hash workspace', () => {
  expect(() => validate('https://app.test/login#/login', 'https://app.test/', '/login#/login')).toThrow('AUTH_REQUIRED');
  expect(() => validate('https://app.test/login#/workspace', 'https://app.test/', '/login#/login')).not.toThrow();
});
