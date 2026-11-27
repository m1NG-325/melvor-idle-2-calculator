## 简体中文

- **新增物品检索**：可以用中英文搜索物品，查看从哪获得、用在哪里，也能按名称或售价排序
- **连锁产线可以展开耗时明细**：每一步做几次、平均每次多久、能产出多少，都可以点开看
- **改进按目标数量计算**：会比较更多配方组合，备料余量只加在产量会波动的物品上，预计产量和队列目标也分开显示
- **修复产线导入定时挂机**：按时长导入就按时间结束，已有的整分钟时长会尽量保留。按数量导入会沿用目标数量
- **修复手动存档回退**：手动选中的文件丢失或损坏时，会尝试读取同角色的自动存档，并继续每 15 秒刷新

## English

- **Item Lookup** — Search in English or Chinese to see where items come from and what they're used for. Sort by name or sell price
- **Production time breakdowns** — Expand a step to see its estimated action count, average time per action, and yield
- **Improved target-quantity planning** — Compare more recipe combinations, apply buffers only to variable yields, and see the estimated output and queue target separately
- **Fixed production imports into the timed queue** — Time-based plans use timers and preserve whole-minute steps where possible. Quantity-based plans keep the requested target
- **Manual save fallback** — If your selected save is missing or unreadable, the app tries the detected save for the same character and keeps refreshing every 15 seconds
