const assert = require('node:assert/strict');
const { test } = require('node:test');
const { translateLocale, translateBasePackage } = require('../game-localization.cjs');

test('the owned dictionary translates the active English locale and preserves unmatched entries', () => {
  const input = [
    'msgid ""\nmsgstr ""\n"Language: en_GB\\n"',
    '#: example\nmsgctxt "weapon"\nmsgid "Steel Dagger"\nmsgid_plural "Steel Daggers"\nmsgstr[0] "Steel Dagger"\nmsgstr[1] "Steel Daggers"',
    'msgid ""\n"Charge "\n"{Value:F0}"\nmsgstr "原值 " \n"{Value:F0}"',
    'msgid "New item"\nmsgstr "New item"',
    'msgid "Bonus {Value}"\nmsgstr "加成 {Value}"'
  ].join('\n\n');
  const { bytes, count } = translateLocale(input, {
    'Steel Dagger': '钢制匕首',
    'Charge {Value:F0}': '充能 {Value:F0}',
    'Bonus {Value}': '不兼容的译文'
  }, '0'.repeat(32));
  const result = bytes.toString();
  assert.equal(count, 2);
  assert.match(result, /msgctxt "weapon"\nmsgid "Steel Dagger"\nmsgid_plural "Steel Daggers"\nmsgstr\[0\] "钢制匕首"\nmsgstr\[1\] "钢制匕首"/);
  assert.match(result, /msgstr "充能 \{Value:F0\}"/);
  assert.match(result, /msgid "New item"\nmsgstr "New item"/);
  assert.match(result, /msgid "Bonus \{Value\}"\nmsgstr "加成 \{Value\}"/);
  assert.match(result, /"Language: en_GB\\n"/);
});

test('game data translation only replaces display text and preserves mechanical identifiers', () => {
  const data = { Objects: { Item: [{ Id: 'Axe', DisplayName: { Singular: 'Axe' }, Description: 'Equip for {Skill}',
    Reward: { Item: 'Axe', Quantity: 2 }, TemplateString: '{Skill}: {Value}' }] } };
  const { bytes, count } = translateBasePackage(Buffer.from(JSON.stringify(data)), {
    Axe: '斧头', 'Equip for {Skill}': '装备到{Skill}栏', '{Skill}: {Value}': '错误模板'
  });
  assert.equal(count, 2);
  assert.deepEqual(JSON.parse(bytes).Objects.Item[0], {
    Id: 'Axe', DisplayName: { Singular: '斧头' }, Description: '装备到{Skill}栏',
    Reward: { Item: 'Axe', Quantity: 2 }, TemplateString: '{Skill}: {Value}'
  });
  const largeInteger = '{"Description":"Axe", "Quantity":9223372036854775807}';
  assert.equal(translateBasePackage(Buffer.from(largeInteger), { Axe: '斧头' }).bytes.toString(),
    '{"Description":"斧头", "Quantity":9223372036854775807}');
});

test('damage range translation uses the two arguments that the game supplies', () => {
  const source = '{0:N0}-{0:N0} Damage';
  const bytes = translateLocale('msgid "' + source + '"\nmsgstr "' + source + '"',
    { [source]: '{0:N0}-{1:N0} 伤害' }, '0'.repeat(32)).bytes;
  assert.match(bytes.toString(), /msgstr "\{0:N0\}-\{1:N0\} 伤害"/);
});

test('missing runtime messages are added once for each context and plural forms keep their own translation', () => {
  const po = 'msgid "Dismiss"\nmsgstr "Dismiss"\n';
  const extra = [['Dismiss', '', ''], ['Dismiss', '', 'Notification'], ['Task', 'Tasks', '']];
  const { bytes, count } = translateLocale(po, { Dismiss: '关闭', Task: '任务', Tasks: '多项任务' }, '0'.repeat(32), extra);
  const result = bytes.toString();
  assert.equal(count, 3);
  assert.equal([...result.matchAll(/^msgid "Dismiss"/gm)].length, 2);
  assert.match(result, /msgctxt "Notification"\nmsgid "Dismiss"\nmsgstr "关闭"/);
  assert.match(result, /msgid_plural "Tasks"\nmsgstr\[0\] "任务"\nmsgstr\[1\] "多项任务"/);
});
