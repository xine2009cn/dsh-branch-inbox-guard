# dsh-branch-inbox-guard

[English](README.md) | 中文

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

阻止 DSH 分支会话继承父会话未投递的排队提问。从某个会话分支出来后，在分支里输入的问题会被**立刻执行**，
而不是被父会话排在前面的那句顶掉。

- 纯宿主插件：不改核心包、没有客户端半、无需配置。
- 持久化：清理动作以正常的 `agent/inbox/spliced` 取消事件写进日志，重启后队列依然干净。
- 幂等、保守：只删除能证明来自 fork 父会话的待执行项。

## 它解决什么问题

DSH 的分支会话是一个 **fork 子会话**：它的日志以父会话"已完成轮次的前缀"作为种子，而这个前缀里可能包含
父会话**尚未投递**的 `agent/inbox/spliced` 事件 —— 也就是父会话还在忙时你排队进去的提问。

在 DSH **0.1.5** 上，agent 的 inbox 是一个折叠**全量日志**的 session 投影，于是这些被回放的 splice
变成了子会话的待执行队列。你在分支里新输入的问题被追加到它们**后面**，分支的第一轮取走的是父会话排队的那句 ——
你自己输入的问题看起来"消失了"。

而在 DSH **0.1.1-rc.2** 上，inbox 只用 fork 切点之后的日志重建队列，同一份种子得到的是**空队列**。
本插件用公开接口恢复了这个行为，不需要改任何核心包。

```text
父会话                              分支会话（fork 子会话）
  turn 10 ─ 已完成                    种子 = 父会话前缀
  队列: [A] [B]  ← 未投递             队列: [A] [B]   ← 0.1.5 会从种子里回放出来
  turn 11 执行 A                      你输入 C → 队列 [A] [B] [C]
                                      第一轮执行 A   ← C 在排队，看起来像是丢了
                                      装本插件后: 队列 [C] → 第一轮执行 C
```

## 它做什么

每次 `agent/created` 时检查待执行队列，只删除那些**插入位置落在本会话继承前缀之内**的项
（即插入事件 `seq < session.inheritedEventCount`）：

| 待执行项 | 处理 |
| --- | --- |
| 在 fork 切点之前插入（父会话的） | 删除。整队都是继承项时用一次 `inbox.clear()`，否则逐条 `inbox.remove(id)`；两者都会以取消事件持久化 |
| 由本会话自己的事件插入 | 保留。已经排了自己消息的分支（或之后被 resume 的会话）只会丢掉继承项 |
| 未 seed 的会话（`inheritedEventCount` 为 0） | 完全不碰 |
| 日志里找不到插入来源的项 | 保留（保守策略） |

它同样覆盖 **fork 型 subagent**（种子有同样的性质，否则子代理的任务会排在父会话提问后面），
并且能治好装插件之前就已经被污染的分支：打开一次，幽灵项被取消，而你自己输入的那条会保留。

## 安装

```bash
# 从 npm 安装（预构建，跳过构建授权步骤）
dsh plugin --profile web add dsh-branch-inbox-guard

# 从 GitHub 安装
dsh plugin --profile web add github:xine2009cn/dsh-branch-inbox-guard

# 从 Release 附件安装
dsh plugin --profile web add https://github.com/xine2009cn/dsh-branch-inbox-guard/releases/latest/download/dsh-branch-inbox-guard-0.1.0.tgz

# 从本地文件 / 目录安装
dsh plugin --profile web add ./dsh-branch-inbox-guard-0.1.0.tgz
```

装完重启 DSH（`docker restart <容器>` 或重启应用）并刷新 Web GUI。它是一个宿主侧 bundle row，
profile 的 `dsh.profile.bundles` 里列出它就会在启动时加载。

## 验证是否生效

每次清理都会在 DSH 日志里留一行：

```text
[branch-inbox-guard] session-xxxxxxxx: dropped 5 inherited prompt(s) from its fork parent
```

端到端验证：在智能体运行中往某个会话排一条消息 → 从某个已完成轮次末尾"在新对话中分支" →
新分支的排队区应当是**空的**，在分支里输入的问题应当**立刻开始执行**。

## 卸载

```bash
dsh plugin --profile web remove dsh-branch-inbox-guard
docker restart <容器>
```

不会留下任何残留：插件不往自己的包之外写文件，也不修改会话历史 —— 它唯一追加的就是去除继承项的那个取消事件。

## 兼容性

已在 DSH **0.1.5-rc.1** 与 **0.1.5-rc.2** 上验证（这两个版本的 inbox 投影会折叠 fork 继承前缀）。
在 **0.1.1-rc.2** 上，fork 时队列本来就是空的，插件是 no-op。

只用公开接口：`agent/created` 事件、`agent.inbox`（`nextTurn`/`nextStep`/`clear`/`remove`）、
`session.inheritedEventCount`、`session.snapshotEvents()`、`session.id`。
如果未来的 DSH 版本让 inbox 投影重新跳过继承前缀（即上游修复了这个问题），插件会发现"没有可删的项"，
可以直接卸载。

## 测试

```bash
npm test        # 等价于: node test/guard.test.mjs
```

自包含单元测试（无依赖、无 fixture、不含任何会话数据）：混合队列只删继承项保留自有项、纯 fork 子会话只写一次
持久化 `clear()`、继承的插话输入（`next-step`）同样被删、未 seed 会话不受影响、空队列不写事件、
重复执行是 no-op、来源不可追溯的项被保留。

## 许可

MIT
