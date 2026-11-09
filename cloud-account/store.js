'use strict';

const { randomUUID } = require('node:crypto');

function createTableStore({ credentials, endpoint, instanceName, prefix = 'dcdv_' }, SDK = require('tablestore')) {
  if (!credentials?.accessKeyId || !credentials?.accessKeySecret || !credentials?.securityToken) throw new Error('FC function role credentials are required');
  if (!instanceName || !/^https:\/\/[a-z0-9.-]+\.tablestore\.aliyuncs\.com$/.test(endpoint || '')) throw new Error('A secure Tablestore endpoint is required');
  if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(prefix)) throw new Error('Invalid table prefix');
  const tables = { users: `${prefix}users`, progress: `${prefix}progress`, ephemeral: `${prefix}ephemeral` };
  const client = new SDK.Client({ accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.accessKeySecret, securityToken: credentials.securityToken, endpoint, instancename: instanceName, maxRetries: 2 });
  // SDK 5.6.5 tries an unavailable XML parser for binary Tablestore errors,
  // losing OTSConditionCheckFail and other service codes. Decode the SDK's
  // protobuf Error envelope on this client only; keep its fallback for gateways.
  const protoError = require('tablestore/lib/protocol/tablestore_compiled_proto').main.proto.Error;
  const originalExtractError = client.extractError;
  client.extractError = function (response) {
    try {
      const decoded = protoError.decode(response.httpResponse.body);
      if (/^OTS[A-Za-z0-9]+$/.test(decoded.code)) {
        response.error = SDK.util.error(new Error(), { code: decoded.code, message: decoded.message || '', headers: response.httpResponse.headers });
        return;
      }
    } catch { /* Non-protobuf gateway errors retain the SDK's normal handling. */ }
    originalExtractError.call(this, response);
  };
  const call = (method, params) => new Promise((resolve, reject) => client[method](params, (error, data) => error ? reject(error) : resolve(data)));
  function tableName(table) {
    if (!tables[table]) throw new Error('Invalid table');
    return tables[table];
  }
  return {
    async get(table, key) {
      const data = await call('getRow', { tableName: tableName(table), primaryKey: [{ key }], maxVersions: 1 });
      if (!data.row?.primaryKey?.length) return null;
      const fields = Object.fromEntries(data.row.attributes.map(column => [column.columnName, column.columnValue]));
      if (!fields.payload || !fields.revision) return null;
      return { value: JSON.parse(fields.payload), version: fields.revision };
    },
    async put(table, key, value, expectedVersion, version = randomUUID()) {
      const condition = expectedVersion === null
        ? new SDK.Condition(SDK.RowExistenceExpectation.EXPECT_NOT_EXIST, null)
        : new SDK.Condition(SDK.RowExistenceExpectation.EXPECT_EXIST, new SDK.SingleColumnCondition('revision', expectedVersion, SDK.ComparatorType.EQUAL, false, true));
      try {
        await call('putRow', { tableName: tableName(table), primaryKey: [{ key }], attributeColumns: [{ payload: JSON.stringify(value) }, { revision: version }], condition });
        return true;
      } catch (error) {
        if (error.code === 'OTSConditionCheckFail') return false;
        throw error;
      }
    },
    async delete(table, key) {
      await call('deleteRow', { tableName: tableName(table), primaryKey: [{ key }], condition: new SDK.Condition(SDK.RowExistenceExpectation.IGNORE, null) });
    },
  };
}

module.exports = { createTableStore };
