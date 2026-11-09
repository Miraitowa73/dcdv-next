'use strict';

const { randomUUID } = require('node:crypto');

function createTableStore({ credentials, endpoint, instanceName, prefix = 'dcdv_' }, SDK = require('tablestore')) {
  if (!credentials?.accessKeyId || !credentials?.accessKeySecret || !credentials?.securityToken) throw new Error('FC function role credentials are required');
  if (!instanceName || !/^https:\/\/[a-z0-9.-]+\.tablestore\.aliyuncs\.com$/.test(endpoint || '')) throw new Error('A secure Tablestore endpoint is required');
  if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(prefix)) throw new Error('Invalid table prefix');
  const tables = Object.fromEntries(['users', 'progress', 'ephemeral', 'classes', 'class_members'].map(name => [name, `${prefix}${name}`]));
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
  function decode(row) {
    if (!row?.primaryKey?.length) return null;
    const fields = Object.fromEntries(row.attributes.map(column => [column.columnName, column.columnValue]));
    if (!fields.payload || !fields.revision) return null;
    return { value: JSON.parse(fields.payload), version: fields.revision };
  }
  return {
    async get(table, key) {
      const data = await call('getRow', { tableName: tableName(table), primaryKey: [{ key }], maxVersions: 1 });
      return decode(data.row);
    },
    async scan(table, prefixKey, cursor = null, limit = 100) {
      if (cursor && !cursor.startsWith(prefixKey)) throw new Error('Invalid range cursor');
      const data = await call('getRange', { tableName: tableName(table), direction: SDK.Direction.FORWARD, inclusiveStartPrimaryKey: [{ key: cursor || prefixKey }], exclusiveEndPrimaryKey: [{ key: prefixKey + '\uffff' }], limit, maxVersions: 1 });
      return { rows: (data.rows || []).map(row => ({ key: row.primaryKey[0].value, ...decode(row) })), cursor: data.nextStartPrimaryKey?.[0]?.value || null };
    },
    async summary(key) {
      const data = await call('getRow', { tableName: tableName('progress'), primaryKey: [{ key }], columnsToGet: ['summary'], maxVersions: 1 });
      const field = data.row?.attributes?.find(column => column.columnName === 'summary');
      return field ? JSON.parse(field.columnValue) : null;
    },
    async put(table, key, value, expectedVersion, version = randomUUID()) {
      const condition = expectedVersion === null
        ? new SDK.Condition(SDK.RowExistenceExpectation.EXPECT_NOT_EXIST, null)
        : new SDK.Condition(SDK.RowExistenceExpectation.EXPECT_EXIST, new SDK.SingleColumnCondition('revision', expectedVersion, SDK.ComparatorType.EQUAL, false, true));
      try {
        const attributeColumns = [{ payload: JSON.stringify(value) }, { revision: version }];
        if (table === 'progress' && value.summary) attributeColumns.push({ summary: JSON.stringify(value.summary) });
        await call('putRow', { tableName: tableName(table), primaryKey: [{ key }], attributeColumns, condition });
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
