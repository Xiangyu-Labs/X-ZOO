import { describe, expect, it } from 'vitest';

import { DELETE, GET, POST } from './route';

describe('an API URL no route serves', () => {
  it('answers the JSON error envelope, not an HTML page', async () => {
    for (const handler of [GET, POST, DELETE]) {
      const response = handler();
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ code: 'NOT_FOUND', message: '资源不存在' });
    }
  });
});
