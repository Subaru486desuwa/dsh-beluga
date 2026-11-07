# ChatGPT 网页能力对齐清单

记录 Beluga Chat 对照 ChatGPT 网页版的差距和实现顺序。整理于 2026-11-06，依据下方官方资料的搜索结果和指南页；帮助中心的能力总览页无法直接读取，套餐差异未核对。兼容目标仍是 DSH 0.2.1-rc.3，升级另行安排。

## 现状

| 能力 | ChatGPT | Beluga | 批次 |
|---|---|---|---|
| 流式回复、停止、重试、模型选择 | 有 | 已有 | — |
| 编辑消息、重新生成、分支 | 有 | 已有 | — |
| Markdown、代码、公式渲染 | 有 | 已有 | — |
| 搜索、重命名、归档、删除 | 有 | 已有 | — |
| 个人资料、自定义指令、记忆管理 | 有 | 已有，记忆质量待真实模型验证 | — |
| 临时聊天 | 有 | 已有 | — |
| 文本、PDF、图片上传 | 有 | 已有；图片需内联模型 | — |
| 联网搜索 | 有 | 工具已接，真实服务未验收 | — |
| Word 生成和修订 | 有 | 已有，需 Office 扩展 | — |
| 导入 ChatGPT 历史 | 无需 | 已有，真实导出待验证 | — |
| 置顶聊天 | 有 | 已有 | 第一批 |
| 导出单个聊天 | 有分享链接 | 已有，导出 Markdown | 第一批 |
| 朗读回复 | 有 | 已有，只用本机语音；真实发声待验证 | 第一批 |
| 回复下列出来源 | 有 | 已有，真实联网服务未验收 | 第一批 |
| 引用过去的聊天 | 有 | 已有，可在记忆页关闭；不含导入的原始历史，真实模型调用待验证 | 第一批 |
| Projects：聊天、文件、指令归组，可限定记忆范围 | 有 | 缺失 | 第二批 |
| Canvas：回复旁边的文档编辑区 | 有 | 缺失 | 第三批 |
| 文件库和跨类型搜索 | 有 | 缺失 | 第三批 |
| Excel、PPT 生成，文件预览 | 有 | 缺失 | 第三批 |
| 深度研究 | 有 | 缺失，依赖真实联网服务 | 第四批 |
| 数据分析（运行代码） | 有 | 缺失，需要沙箱决定 | 第四批 |
| 图片生成和编辑 | 有 | 缺失，需要图片模型 | 第四批 |
| 定时任务 | 有 | 缺失 | 第四批 |
| 自动生成标题、追问建议 | 有 | 缺失 | 待定 |

## 暂不复刻

| 能力 | 原因 |
|---|---|
| 实时语音 | 需要实时模型和音频通道，与 rc.3 的模型路由不匹配 |
| 群聊、共享项目 | 插件目前只服务单一所有者，需要新的授权边界 |
| 公开分享链接 | Host 只在本机运行，导出文件更符合这个前提 |
| 锁定聊天 | 单一所有者的本机场景价值低 |
| 购物、虚拟试穿、连接第三方账号 | 依赖官方服务 |
| Intelligent UI | 模型自带能力，插件无法单独实现 |

## 需要决定

- **数据分析：** 运行代码会放宽规格里 “Chat 不能执行代码” 的约束，要先验证 Harness 沙箱能否用于 Chat。
- **图片生成：** DeepSeek 路由目前没有对应能力，需要配置额外的图片服务。
- **搜索导入的历史：** 目前不搜索，因为界面承诺导入历史只有在续聊时才发送给模型。要纳入搜索，需要先改这条承诺。

## 官方资料

- [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
- [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
- [Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)
- [Scheduled tasks in ChatGPT](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt)
- [Introducing canvas](https://openai.com/index/introducing-canvas/)
- [Use ChatGPT](https://learn.chatgpt.com/docs/use-chatgpt)
- [Get started with ChatGPT Work](https://learn.chatgpt.com/docs/get-started-with-work)
