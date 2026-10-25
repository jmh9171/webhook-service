import { test } from 'node:test';
import assert from 'node:assert/strict';
import viteConfig from '../vite.config.js';

async function configured(env: Record<string, string>) {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    assert.equal(typeof viteConfig, 'function');
    if (typeof viteConfig !== 'function') throw Error('Expected Vite config factory');
    return await viteConfig({ mode: 'test', command: 'build' });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Vite exposes only the explicit public Signal alias and supports the VITE override', async () => {
  for (const override of ['', 'pk_public_override']) {
    const config = await configured({
      SIGNAL_API_KEY_FRONTEND: 'pk_public_alias',
      SIGNAL_API_KEY: 'sk_private_fixture',
      VITE_ANALYTICS_KEY: override,
      VITE_ANALYTICS_URL: 'https://collector.example.test',
    });
    assert.equal(config.define?.['import.meta.env.VITE_ANALYTICS_KEY'], JSON.stringify(override || 'pk_public_alias'));
    assert.equal(config.define?.['import.meta.env.VITE_ANALYTICS_URL'], '"https://collector.example.test"');
    assert.equal(config.envPrefix, undefined);
    assert.ok(!JSON.stringify(config.define).includes('sk_private_fixture'));
  }
});

test('Vite rejects private credentials before they can enter the browser bundle', async () => {
  for (const key of ['sk_private_fixture', 'admin-private-fixture']) {
    await assert.rejects(configured({ VITE_ANALYTICS_KEY: key, SIGNAL_API_KEY_FRONTEND: '' }), /requires a public pk_ key/);
    await assert.rejects(configured({ VITE_ANALYTICS_KEY: '', SIGNAL_API_KEY_FRONTEND: key }), /requires a public pk_ key/);
  }
});
