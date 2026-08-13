# dsh-undo

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的上下文撤销/重做插件，灵感来自 [opencode](https://github.com/anomalyco/opencode) 等编码 agent 的 undo/redo 体验。

插件为每个根 agent 提供两个面向模型的工具：

- **`undo`** — 把模型上下文回滚到最近一个已完成步骤的末尾。该步骤的所有 assistant 消息与工具结果都会从可见上下文中隐去；持久化的会话日志仍保留全部被回滚的事件，数据不会丢失。
- **`redo`** — 把最近一次 `undo` 移除的消息重新加回上下文，恢复原状。

## 工作原理

会话日志是只追加的，因此 `undo` 从不删除事件，而是追加一条**内容为空的 `assistant/message`**，用其 surface `replace` 操作遮蔽目标步骤的模型可见节点。空的 assistant 内容不会派生任何消息，因此模型看到的上下文恰好等于步骤之前的状态，而日志始终是一份完整、可重放、可逆的历史。`redo` 则把被遮蔽的事件以全新副本重新追加为普通 surface append（消息身份重新生成；工具结果保留调用关联，因此对话中 tool-call → tool-result 的相邻关系保持不变）。

设计要点：

- **撤销单位是一个已完成的步骤**（最新一条 `step/end` 且该步骤仍有可见消息）。连续调用 `undo` 会一步一步往回走。
- **用户消息永不回滚** — 用户提示始终留在上下文中，可撤销的只是针对它的 assistant 工作。
- **新用户输入会使 redo 失效** — 任何新的 user-role 消息都会清空 redo 栈（标准的撤销/重做语义）。undo/redo 工具自身的调用、结果和 redo 副本不会使其失效。
- **持久化** — 每次操作在报告成功前都会经过共享的会话持久化屏障（`ctx.sessions.flush`）；无法证明持久化完成时返回 `persistence_uncertain`，而不是谎报成功。
- **撤销历史是进程内的** — 与浏览器的撤销栈一样，redo 栈只存在内存中。重启进程后日志保持一致（标记保持遮蔽、副本保持恢复），但 redo 栈会被清空。
- **作用范围** — 只为插件加载后发布的根 agent 安装（子 agent 与既有会话不会被动补装）。

## 安装

本包是 [dsh 组合包](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish/)：`package.json` 声明了 `dsh.bundle`，指向 `cordis.patch.yml`，该 patch 会激活插件行。

从 npm 安装：

```sh
dsh plugin --profile demo add dsh-undo
```

从 git 安装（源码检出——`prepare` 脚本会在安装时构建 `lib/`；需先在 profile 的 `pnpm-workspace.yaml` 中授权构建）：

```sh
dsh plugin --profile demo add github:LingLambda/dsh-undo#<sha>
```

针对 deepseek-harness 源码检出做本地开发时，可直接以 overlay 方式加载插件：

```sh
pnpm dsh web --patch ./cordis.patch.yml --patch /absolute/path/to/dsh-undo/overlay.yml
```

其中 `overlay.yml` 引用源码入口：

```yaml
- insert:
    - id: undo
      name: /absolute/path/to/dsh-undo/src/index.ts
```

## 用法

当你说“撤销/回滚刚才的操作”时，模型会调用 `undo`；说“重做/恢复被撤销的内容”时调用 `redo`：

```
> 那个修改是错的。撤销它，换一种方式重试。
```

每次调用都会在结果中说明发生了什么（`rolled_back` 并附被遮蔽数量与标记 seq、`restored`、`nothing_to_undo`、`nothing_to_redo`，或错误）。

## 开发

```sh
yarn install
yarn typecheck
yarn test
yarn build
```

## License

MIT
