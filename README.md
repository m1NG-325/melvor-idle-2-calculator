# Melvor Idle 2 Calculator · 梅尔沃放置 2 本地计算器

[English](#english) · [简体中文](#简体中文) · [Downloads / 下载](https://github.com/m1NG-325/melvor-idle-2-calculator/releases/latest)

## English

A local calculator that reads your Steam game data and character save to compare idle GP, skill XP, and the resources you still need for shop upgrades.

### Getting started

1. Install Node.js on Windows, then download and extract the ZIP from [GitHub Releases](https://github.com/m1NG-325/melvor-idle-2-calculator/releases/latest).
2. Run `Start-GP-Calculator.cmd`. If the calculator cannot find the game, drag the folder containing `Melvor2.exe` onto the launcher.
3. Select your character in the sidebar. After the game saves, click **Reload Save** to refresh the results.
4. Keep the launcher window open while using the calculator. Close it when you are done.

**English** is the default. Use **语言 / Language** in the top-right corner to switch to Simplified Chinese. Game names come from the corresponding local game data when available.

### What it shows

- **GP Calculator** compares gross and net GP over your chosen duration and shows when ingredients are expected to run out.
- **XP Calculator** ranks available actions by expected XP and XP per hour. Supported bonuses are detected automatically, and you can enter extra XP bonuses manually.
- **Shop Upgrades** filters upgrades by category, visibility, and purchase status. Expand a resource to see which upgrades use it and how much each one costs.

### Compatibility

Tested on Windows with Steam build `26724394`. Game updates can change the data and save formats. Combat and some other skills are not covered by the XP rankings.

The calculator runs locally and reads game files and saves without modifying them. The ZIP contains the tool and documentation.

## 简体中文

读取本机 Steam 游戏数据和角色存档，比较挂机金币收益、经验效率，以及商店升级还缺多少材料。

### 使用方法

1. 在 Windows 上安装 Node.js，从 [GitHub 发布页](https://github.com/m1NG-325/melvor-idle-2-calculator/releases/latest)下载并解压 ZIP。
2. 双击 `Start-GP-Calculator.cmd`。如果没有自动找到游戏，把含 `Melvor2.exe` 的游戏文件夹拖到启动器上。
3. 在网页侧栏选择角色。游戏保存后，点击「重新读取存档」即可刷新结果。
4. 使用期间保留启动窗口。用完后可以关闭窗口。

网页默认使用英文，在右上角的「语言 / Language」可切换到简体中文。动作、物品和商店名称优先读取本机对应语言的游戏数据。

### 功能

- **挂机收益**按指定时长比较到手金币和净收益，并显示材料预计何时用完。
- **经验效率**按技能比较可用行动的预计总 XP 和 XP/小时。支持的加成会自动识别，其他经验加成可以手填。
- **商店升级**按类别、显示范围和购买状态筛选。展开任意资源，可查看用在哪些升级上、每项需要多少。

### 兼容性

已验证 Windows 版 Steam 构建 `26724394`。游戏更新后，数据包和存档格式可能变化。战斗等部分技能暂未接入经验排行。

工具在本机运行，只读游戏文件和存档。ZIP 内含工具和使用说明。
