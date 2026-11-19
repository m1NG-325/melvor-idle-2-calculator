const english = {
  '梅尔沃放置 2 · 工具台': 'Melvor Idle 2 Calculator',
  '梅尔沃放置 2': 'Melvor Idle 2', '工具': 'Tools',
  '挂机收益': 'GP Calculator', '经验效率': 'XP Calculator', '商店升级': 'Shop Upgrades',
  '正在读取本机游戏数据': 'Loading local game data…', '正在读取数据…': 'Loading data…',
  '正在读取商店数据…': 'Loading shop data…', '角色存档': 'Character Save', '重新读取存档': 'Reload Save',
  '挂机时长（小时）': 'Idle Time (hours)', '离线上限（小时）': 'Offline Cap (hours)',
  '排行依据': 'Sort By', '净收益': 'Net GP', '到手金币': 'GP Received', '回归后卖产物': 'Sell Loot on Return',
  '计算': 'Calculate', '本次首选': 'Top Recommendation', '按技能查看': 'Filter by Skill',
  '全部技能': 'All Skills', '搜索方案': 'Search Actions', '动作名或地点': 'Action or location',
  '方案': 'Action', '到手 GP': 'GP Received', '净 GP/小时': 'Net GP/hr', '预计停机': 'Stops When',
  '显示更多': 'Show More', '等级与加成': 'Levels and Bonuses', '技能': 'Skill', '等级': 'Level',
  '间隔变化 %': 'Interval Change %', '产量变化 %': 'Yield Change %', '额外加成': 'Extra Bonus',
  '间隔变化百分比': 'Interval change percentage', '产量变化百分比': 'Yield change percentage',
  '额外隐匿': 'Extra Stealth', '额外熟练度': 'Extra Proficiency', '额外鱼获概率百分点': 'Extra Fish Chance (pp)',
  '等级 0 表示技能不可用。可手填相对基础值的间隔变化和平均产量变化。偷窃只有成功率为 100% 或失败无伤害时才参与排名。':
    'Level 0 marks a skill unavailable. Enter changes to the base interval and average yield. The GP ranking includes Thieving only at 100% success or when failure deals no damage.',
  '库存与解锁条件': 'Inventory and Unlocks',
  '可以调整参与计算的库存。产出会按游戏内卖价折算。净收益扣除材料卖价，已锁定的仓库物品保留。':
    'Adjust the inventory used in calculations. Outputs use in-game sell prices. Net GP deducts the sell value of materials and leaves locked bank items untouched.',
  '物品（可搜索）': 'Item', '输入物品名称或 ID': 'Item name or ID', '可用数量': 'Available Quantity',
  '设定库存': 'Set Quantity', '游戏里已确认可做的动作': 'Action Available In-Game',
  '输入动作名或 ID': 'Action name or ID', '确认解锁': 'Confirm Unlocked', '排除动作': 'Exclude Action',
  '计算范围': 'Calculation Scope',
  '每次挂机只运行一项动作，以存档快照和基础机制计算期望值。离线上限 0 表示在线挂机。当前版本未完整模拟装备、专精、药水与天气、银行格数耗尽、自动停手、挂机升级或被动技能。战斗、宝箱、劫案、草药学、农业和狩猎未纳入。结果适合用来对比方案，实际结算会有波动。':
    'Each estimate covers one idle action using your saved character. Set the offline cap to 0 for online idling. Some equipment, mastery, potion and weather effects, bank limits, stop rules, level-ups and passive skills are not fully modeled. The GP ranking excludes combat, chests, heists, Herblore, Farming and Hunting. Actual results can vary.',
  '经验计算设置': 'XP Settings', '比较时长（小时）': 'Duration (hours)', '额外经验加成 %': 'Extra XP Bonus %',
  '按角色等级、库存和可识别的加成计算。未自动识别的修正可以填入额外加成。':
    'Uses your character levels, inventory and supported bonuses. Enter any missing XP bonuses manually.',
  '各技能首选': 'Top Action per Skill', '行动排行': 'Action Rankings', '行动': 'Action',
  '预计 XP': 'Estimated XP', 'XP / 小时': 'XP / hr', '数据和限制': 'Bonuses and Limits',
  '未购升级': 'Unpurchased Upgrades', '已购升级': 'Purchased Upgrades', '涉及资源': 'Resources Needed',
  '商店类别': 'Shop Categories', '统计范围': 'Scope', '当前显示': 'Visible in Shop',
  '全部已知（含隐藏）': 'All Known (Including Hidden)', '未上架数据（参考）': 'Unlisted (Reference)',
  '购买状态': 'Purchase Status', '仅未购买': 'Unpurchased Only', '显示已购买和未购买': 'Purchased and Unpurchased',
  '仅已购买': 'Purchased Only', '全选类别': 'Select All', '清空选择': 'Clear Selection',
  '升级资源清单': 'Upgrade Resource List', '搜索资源或升级': 'Search Resources or Upgrades',
  '例如铁锭、仓库、斧头': 'e.g. Iron Bar, Bank, Axe', '只看有缺口': 'Shortages Only',
  '资源 · 点击查看用途': 'Resource · click to see uses', '已购用量': 'Spent', '未购总需': 'Still Needed',
  '仓库 / 余额': 'In Bank / Balance', '还缺': 'Shortfall', '升级': 'Upgrade', '商店位置': 'Shop Location',
  '未购需求': 'Still Needed', '带已购标记的商品按首次购买规划。普通可重复购买的补给不计入。':
    'Items with a purchase marker count toward the first purchase. Repeatable supplies are excluded.',
  '已购用量按存档购买次数和本版标价估算。还缺只计算尚未购买的部分。':
    'Spent amounts use saved purchase counts and current prices. The shortfall only counts outstanding purchases.',
  '按存档的商店显示设置筛选。游戏开启「显示锁定项」时，这里也会统计可见但尚未解锁的升级。':
    'Follows the shop display settings in your save, including visible locked upgrades if Show Locked is enabled.',
  '统计本版正式商店里所有升级，包含还没显示或解锁的项目。展开资源可查看显示状态和前置条件。':
    'Includes every registered shop upgrade in this build, including hidden and locked entries. Expand a resource to see its uses and requirements.',
  '这里只列安装数据中有价格的未上架或旧测试条目，费用单独统计。':
    'Shows priced, unlisted or old test entries found in the local game data. Their costs are listed separately.',
  '请选择至少一个商店类别。': 'Select at least one shop category.',
  '载入角色存档后可判断当前显示的升级。也可以切换到「全部已知」。':
    'Load a character save to see visible upgrades, or switch to All Known.',
  '所选类别没有匹配的升级。': 'No upgrades match the selected categories.',
  '所选类别没有已购升级。': 'No purchased upgrades in these categories.',
  '所选升级无需支付资源。': 'These upgrades do not require any resources.',
  '没有匹配的资源或升级。': 'No matching resources or upgrades.',
  '所选升级的资源已经够用。': 'You have enough resources for the selected upgrades.',
  '未满足显示条件': 'Display requirements not met', '商店关闭了显示锁定项': 'Show Locked is off',
  '当前隐藏': 'Hidden', '当前显示 · 尚未解锁': 'Visible · locked', '显示状态待核对': 'Visibility unknown',
  '已购买': 'Purchased', '旧测试条目': 'Old test entry', '仅数据中有记录，当前未上架': 'In game data only; unlisted',
  '未读到购买记录，按未购计算': 'Purchase history unavailable; counting as unpurchased',
  '未载入存档，仅显示总需求': 'No save loaded; showing total requirements only',
  '手动设置': 'Manual Setup', '读取失败。可切换到手动设置。': 'Could not load the save. You can switch to Manual Setup.',
  '页面不存在': 'Page not found', '未知': 'Unknown', '金币': 'Gold Pieces',
  '当前筛选没有匹配项。': 'No actions match the current filters.',
  '没有正收益方案。检查技能等级、库存或出售选项。': 'No profitable actions. Check skill levels, inventory or sale settings.',
  '预计净收益': 'Estimated Net GP', '预计到手 GP': 'Estimated GP Received', '到手 GP/小时': 'GP Received/hr',
  '直接 GP {value}': 'Direct GP {value}', '出售收入 {value}': 'Sale Value {value}', '材料原值 {value}': 'Material Value {value}',
  '{value} 次': '{value} actions', '在本次计时时长内材料充足': 'Enough supplies for this duration',
  '约 {time}后用完{item}': 'Runs out of {item} after about {time}',
  '{time} · {item}用完': '{time} · out of {item}',
  '请选择有效物品并输入非负整数。': 'Select a valid item and enter a non-negative whole number.',
  '请选择一个已有动作。': 'Select an action from the list.',
  '{item}可用数量设为 {value}。': '{item} quantity set to {value}.',
  '{item}可用数量设为 {value}，仓库锁定设置仍生效。': '{item} quantity set to {value}. The bank lock still applies.',
  '{name}已确认解锁，仍按等级、库存和偷窃安全条件计算。':
    '{name} marked as unlocked. Levels, inventory and Thieving safety rules still apply.',
  '{name}已排除。': '{name} excluded.',
  'Steam 构建 {build} · {count} 项动作': 'Steam build {build} · {count} actions',
  '存档 {name}': 'Save: {name}', '存档 {count}（格式未知）': 'Save {count} (unknown format)',
  '仓库 {count} 种物品': '{count} bank item types', '{count} 项正收益方案': '{count} profitable actions',
  '离线最多结算 {time}': 'Offline rewards capped at {time}',
  '商店数据读取失败。请重新启动计算器。': 'Could not load shop data. Restart the calculator.',
  '初始化失败。请检查启动窗口。': 'Startup failed. Check the launcher window.',
  '{count} / {total} 个技能有可比较的行动 · 按所选时长内的总经验排序':
    '{count} / {total} skills have available actions · sorted by total XP for the selected duration',
  '受伤风险': 'Injury risk', '暂无可用行动': 'No available actions', '暂未支持': 'Not supported yet',
  '没有同时满足等级、解锁条件和库存的行动。': 'No actions match your level, unlocks and inventory.',
  '这项技能暂未支持经验排行。': 'XP ranking is not available for this skill yet.',
  '{skill}行动排行': '{skill} Rankings', '{value} XP / 小时': '{value} XP / hr',
  '识别加成 {value}%': 'Detected XP bonus {value}%', '额外 {value}%': 'Extra XP {value}%',
  '双倍伤害 {value}': 'Double damage {value}', '弱点 {value}': 'Weak spot {value}',
  '直接砍倒 {value}': 'Instant cut {value}', '产出翻倍 {value}': 'Double output {value}',
  '每击 {value} 秒': '{value}s per hit', '固定经验 {value}': 'Flat XP {value}', '砍倒经验 {value}': 'XP per tree {value}',
  '{time}后缺{item}': 'Out of {item} after {time}', '失败可受伤，未计生存时间': 'Failure can deal damage; survival time is not included',
  '{count} 个已选类别': '{count} categories selected', '其中 {count} 项当前隐藏': 'Includes {count} hidden upgrades',
  '已排除 {count} 项当前隐藏': '{count} hidden upgrades excluded',
  '{count} 项显示状态待核对': 'Visibility unknown for {count} upgrades',
  '{skill} {level} 级': '{skill} level {level}', '先购买「{name}」': 'Buy {name} first',
  '先购买「{name}」 {count} 次': 'Buy {name} {count} times first', '通关「{name}」{count} 次': 'Clear {name} {count} times',
  '完成「{name}」的任务 {count} 次': 'Complete {count} tasks for {name}', '完成任务「{name}」': 'Complete the quest {name}',
  '{count} 项': '{count} upgrades', '剩余 {count} 次': '{count} purchases left'
};

const requestedLanguage = new URLSearchParams(location.search).get('lang');
let uiLanguage = requestedLanguage === 'zh' ? 'zh' : 'en';
let staticLabels;

function t(source, args = {}) {
  const message = uiLanguage === 'en' ? english[source] ?? source : source;
  return message.replace(/\{(\w+)\}/g, (token, key) => args[key] ?? token);
}

function uiLocale() {
  return uiLanguage === 'en' ? 'en-US' : 'zh-CN';
}

function gameName(record) {
  return record?.names?.[uiLanguage] ?? record?.name;
}

function skillName(id, names) {
  return uiLanguage === 'en' ? id : names[id] ?? id;
}

function applyLanguage() {
  document.documentElement.lang = uiLocale();
  if (!staticLabels) {
    const nodes = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    staticLabels = [];
    while (nodes.nextNode()) {
      const node = nodes.currentNode;
      const label = node.textContent.trim();
      if (Object.hasOwn(english, label)) {
        const original = node.textContent;
        staticLabels.push(() => { node.textContent = original.replace(label, t(label)); });
      }
    }
    for (const node of document.querySelectorAll('[placeholder], [aria-label]')) {
      for (const attr of ['placeholder', 'aria-label']) {
        const label = node.getAttribute(attr);
        if (label) staticLabels.push(() => node.setAttribute(attr, t(label)));
      }
    }
    for (const button of document.querySelectorAll('[data-hours], [data-xp-hours]')) {
      const hours = button.dataset.hours ?? button.dataset.xpHours;
      staticLabels.push(() => { button.textContent = uiLanguage === 'en' ? hours + ' hr' : hours + ' 小时'; });
    }
  }
  for (const update of staticLabels) update();
  document.getElementById('language').value = uiLanguage;
}
