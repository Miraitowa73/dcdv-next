const test = require('node:test');
const assert = require('node:assert/strict');
const SDK = require('../cloud-account/node_modules/tablestore');
const proto = require('../cloud-account/node_modules/tablestore/lib/protocol/tablestore_compiled_proto').main.proto;
const { createTableStore } = require('../cloud-account/store');
const { randomUUID } = require('node:crypto');

test('range reads use bounded key prefixes, decode cursor wire format and project summaries', async () => {
  const requests = []; const revision = randomUUID();
  const value = { classId: 'example' }, summary = { completed: 1, total: 39 };
  const row = SDK.PlainBufferBuilder.serializeForPutRow([{ key: 'owner:abc:one' }], [{ payload: JSON.stringify(value) }, { revision }]);
  const next = SDK.PlainBufferBuilder.serializePrimaryKey([{ key: 'owner:abc:two' }]);
  const wire = proto.GetRangeResponse.encode({ consumed: { capacityUnit: { read: 1, write: 0 } }, rows: row, nextStartPrimaryKey: next }).finish();
  class Client extends SDK.Client {
    getRange(params, callback) { requests.push(params); callback(null, SDK.decoder.decode('getRange', Buffer.from(wire))); }
    getRow(params, callback) { requests.push(params); callback(null, { row: { primaryKey: [{ name: 'key', value: 'abc' }], attributes: [{ columnName: 'summary', columnValue: JSON.stringify(summary) }] } }); }
  }
  const store = createTableStore({ credentials: { accessKeyId: 'test', accessKeySecret: 'test', securityToken: 'test' }, endpoint: 'https://test.cn-hangzhou.tablestore.aliyuncs.com', instanceName: 'test' }, { ...SDK, Client });
  const result = await store.scan('classes', 'owner:abc:', null, 50);
  assert.deepEqual(result.rows, [{ key: 'owner:abc:one', value, version: revision }]);
  assert.equal(result.cursor, 'owner:abc:two'); assert.equal(requests[0].limit, 50);
  assert.deepEqual(await store.summary('abc'), summary); assert.deepEqual(requests[1].columnsToGet, ['summary']);
  await assert.rejects(store.scan('classes', 'owner:abc:', 'owner:another:'), /cursor/);
});

test('Tablestore adapter encodes conditional writes and decodes real SDK row wire data', async () => {
  const requests = [];
  const revision = randomUUID();
  const value = { state: { completed: { '与门': true } }, updatedAt: '2026-10-10' };
  const row = SDK.PlainBufferBuilder.serializeForPutRow([{ key: 'user-id' }], [{ payload: JSON.stringify(value) }, { revision }]);
  const wire = proto.GetRowResponse.encode({ consumed: { capacityUnit: { read: 1, write: 0 } }, row }).finish();
  class Client extends SDK.Client {
    getRow(params, callback) {
      requests.push(proto.GetRowRequest.decode(proto.GetRowRequest.encode(SDK.encoder.encode('getRow', params)).finish()));
      callback(null, SDK.decoder.decode('getRow', Buffer.from(wire)));
    }
    putRow(params, callback) {
      const encoded = SDK.encoder.encode('putRow', params);
      const decoded = proto.PutRowRequest.decode(proto.PutRowRequest.encode(encoded).finish());
      requests.push(decoded);
      callback(params.primaryKey[0].key === 'conflict' ? { code: 'OTSConditionCheckFail' } : null, {});
    }
    deleteRow(params, callback) {
      requests.push(proto.DeleteRowRequest.decode(proto.DeleteRowRequest.encode(SDK.encoder.encode('deleteRow', params)).finish()));
      callback(null, {});
    }
  }
  const store = createTableStore({ credentials: { accessKeyId: 'test-only', accessKeySecret: 'test-only', securityToken: 'test-only' }, endpoint: 'https://dcdv-accounts.cn-hangzhou.tablestore.aliyuncs.com', instanceName: 'dcdv-accounts' }, { ...SDK, Client });
  assert.deepEqual(await store.get('progress', 'user-id'), { value, version: revision });
  assert.equal(await store.put('progress', 'user-id', value, null), true);
  assert.equal(await store.put('progress', 'user-id', value, revision), true);
  assert.equal(await store.put('progress', 'conflict', value, revision), false);
  await store.delete('ephemeral', 'session:test');
  assert.equal(requests[0].tableName, 'dcdv_progress');
  assert.equal(requests[1].condition.rowExistence, proto.RowExistenceExpectation.EXPECT_NOT_EXIST);
  assert.equal(requests[2].condition.rowExistence, proto.RowExistenceExpectation.EXPECT_EXIST);
  assert.ok(requests[2].condition.columnCondition.length > 0);
  assert.equal(requests[4].tableName, 'dcdv_ephemeral');
});

test('production storage refuses missing temporary role credentials and insecure endpoints', () => {
  assert.throws(() => createTableStore({}), /credentials/);
  assert.throws(() => createTableStore({ credentials: { accessKeyId: 'test', accessKeySecret: 'test', securityToken: 'test' }, instanceName: 'test', endpoint: 'http://insecure.example' }), /secure/);
});

test('real SDK error envelope preserves CAS conflicts without misclassifying permission failures', async () => {
  const config = { credentials: { accessKeyId: 'test', accessKeySecret: 'test', securityToken: 'test' }, endpoint: 'https://test.cn-hangzhou.tablestore.aliyuncs.com', instanceName: 'test' };
  const errorBody = code => Buffer.from(proto.Error.encode({ code, message: 'test error' }).finish());
  const unpatchedResponse = { httpResponse: { statusCode: 403, body: errorBody('OTSConditionCheckFail'), headers: {} } };
  new SDK.Client({}).extractError(unpatchedResponse);
  assert.equal(unpatchedResponse.error.code, 403); // Reproduces the upstream defect.
  class Client extends SDK.Client {
    putRow(params, callback) {
      const key = params.primaryKey[0].key;
      const body = key === 'gateway' ? Buffer.from('Gateway unavailable') : errorBody(key);
      const response = { httpResponse: { statusCode: key === 'gateway' ? 502 : 403, body, headers: {} } };
      this.extractError(response);
      callback(response.error);
    }
  }
  const store = createTableStore(config, { ...SDK, Client });
  assert.equal(await store.put('progress', 'OTSConditionCheckFail', {}, null), false);
  await assert.rejects(store.put('progress', 'OTSAuthFailed', {}, null), { code: 'OTSAuthFailed' });
  await assert.rejects(store.put('progress', 'gateway', {}, null), { code: 502 });
});
