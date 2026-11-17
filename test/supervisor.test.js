import assert from 'node:assert/strict'
import { test } from 'node:test'
import { httpxNoProxy } from '../src/supervisor.js'

test('httpxNoProxy drops the bracketed IPv6 loopback httpx cannot parse and keeps the rest', () => {
  // dsh's resolved bypass list, as it reaches a child when a proxy is active.
  assert.equal(
    httpxNoProxy({ NO_PROXY: 'corp.example, localhost,127.0.0.1,::1,[::1]', no_proxy: 'localhost,10.0.0.0/8' }),
    'corp.example,localhost,127.0.0.1,::1,10.0.0.0/8',
  )
})

test('httpxNoProxy bypasses the loopback addresses when no list is set', () => {
  assert.equal(httpxNoProxy({}), 'localhost,127.0.0.1,::1')
})
