const { localId } = require('./game-data.cjs');

function makeShopCatalog(data) {
  const objects = data.Objects;
  const config = data.EntityConfig['MelvorBase:Shop'];
  const categories = new Map(objects.ShopCategory.map(entry => [entry.Id, entry]));
  const sections = new Map(objects.ShopSubcategory.map(entry => [entry.Id, entry]));
  const purchases = new Map(objects.ShopPurchase.map(entry => [entry.Id, entry]));
  const ordered = entries => [...entries].sort((a, b) => a.Priority - b.Priority).map(entry => localId(entry.Id));

  const groups = ordered(config.Categories).map(id => ({ id, name: categories.get(id).DisplayName }));
  const includedGroups = new Set(groups.map(group => group.id));
  const sectionOrder = new Map(ordered(config.Subcategories).map((id, index) => [id, index]));
  const registered = new Set(ordered(config.Purchases));
  const names = new Map(['ShopPurchase', 'Dungeon', 'SlayerMaster', 'Quest'].flatMap(type =>
    objects[type].map(entry => [entry.Id, entry.DisplayName])
  ));
  const describe = conditions => (conditions ?? []).map(({ Type, Data }) => {
    const id = localId(Data.ShopPurchase ?? Data.Dungeon ?? Data.Master ?? Data.Quest);
    return {
      type: localId(Type), or: !!Data.IsOr,
      skill: localId(Data.Component?.Entity), level: Data.Level,
      id, name: names.get(id), amount: Data.Amount ?? Data.Value
    };
  });
  const upgrades = [];
  const referenceUpgrades = [];

  for (const id of [...registered, ...[...purchases.keys()].filter(id => !registered.has(id))]) {
    const purchase = purchases.get(id);
    const section = sections.get(localId(purchase?.Subcategory));
    const group = localId(section?.Category);
    if (!purchase || !includedGroups.has(group)) continue;

    const limit = purchase.DefaultBuyLimit;
    // Count permanent upgrades and goods the shop marks as collected after the first purchase.
    if (limit !== 1 && !purchase.Provides?.Bonuses && !purchase.ShowPurchasedIndicator) continue;

    const resources = new Map();
    for (const [type, records] of [['item', purchase.Costs?.Items], ['currency', purchase.Costs?.Currencies]]) {
      for (const cost of records ?? []) {
        const resourceId = localId(type === 'item' ? cost.Item : cost.Currency);
        if (!resourceId || !(cost.Quantity > 0)) continue;
        const key = type + ':' + resourceId;
        const entry = resources.get(key) ?? { type, id: resourceId, quantity: 0 };
        entry.quantity += cost.Quantity;
        resources.set(key, entry);
      }
    }

    const displayRequirements = [describe(categories.get(group).DisplayRequirements), describe(purchase.DisplayRequirements)];
    const referenceReason = id === 'BankSpaceAlpha' ? '旧测试条目' : registered.has(id) ? null : '仅数据中有记录，当前未上架';
    (referenceReason ? referenceUpgrades : upgrades).push({
      id, group, section: section.DisplayName, sectionId: section.Id, name: purchase.DisplayName,
      target: Math.max(1, limit), referenceReason,
      costs: [...resources.values()], requirements: describe(purchase.Requirements), displayRequirements
    });
  }

  for (const list of [upgrades, referenceUpgrades]) {
    list.sort((a, b) => sectionOrder.get(a.sectionId) - sectionOrder.get(b.sectionId));
  }
  const currencies = Object.fromEntries(objects.Currency.map(entry => [entry.Id, entry.DisplayName]));
  const skillNames = Object.fromEntries(objects.EntityPage.map(entry => {
    const id = localId(entry.Entity);
    const shopName = groups.find(group => group.id === id + 'Upgrades' || group.id === id)?.name;
    return [id, shopName ?? id];
  }));
  const levelSkills = [...new Set(upgrades.flatMap(upgrade => [upgrade.requirements, ...upgrade.displayRequirements].flat())
    .filter(req => req.type === 'Level').map(req => req.skill))];
  return { groups, upgrades, referenceUpgrades, currencies, skillNames, levelSkills };
}

module.exports = { makeShopCatalog };
