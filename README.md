# 梅尔沃放置 2 本地计算器

读取本机 Steam 游戏数据和角色存档，比较挂机金币收益、经验效率，以及商店升级还缺多少材料。

## 使用方法

1. 在 Windows 上安装 Node.js，下载并解压发布页里的 ZIP。
2. 双击 `Start-GP-Calculator.cmd`。如果没有自动找到游戏，把含 `Melvor2.exe` 的游戏文件夹拖到这个启动器上。
3. 浏览器打开后，在侧栏选择角色。游戏保存后可点击「重新读取存档」更新。
4. 使用期间保留启动窗口。退出时可以关闭窗口。

网页默认使用 English，可在右上角的「语言 / Language」切换成简体中文。动作、物品和商店名称优先读取本机对应语言的游戏数据。

## Quick start in English

On Windows, install Node.js, unzip the calculator, and run `Start-GP-Calculator.cmd`. If the game is not found, drag the folder containing `Melvor2.exe` onto the launcher. Choose **English** in the top-right corner and select your character save in the sidebar. Click **Reload Save** after the game saves any changes.

## 功能

- **挂机收益**按指定时长比较到手金币和净收益，计入材料可能提前用完的情况。
- **经验效率**按技能比较预计 XP 和 XP/小时。已知修正自动计入，其他经验加成可手填。
- **商店升级**按类别、显示范围和购买状态筛选。资源可以展开，查看用在哪些升级、分别需要多少。

## 兼容性

已验证 Windows 版 Steam 构建 `26724394`。游戏更新后，数据包和存档格式可能变化。战斗等部分技能暂未接入经验排行。

工具只读取本机游戏文件和存档，网页运行在本机。发布包不包含游戏文件或存档。
