# Beluga

Beluga 是 DeepSeek Harness 的个人聊天插件，自己管理聊天、记忆和导入的 ChatGPT 历史。Work 的会话和 Workspace 不归它管，两边只在用户打开的位置互相读取。

## 对话

**Chat（聊天）**:
Beluga 里的一个对话，包括它的全部分支、附件和回合，由 Beluga 自己保存。
_Avoid_: session、会话（那是 Work 的）

**Turn（回合）**:
用户在 Beluga 里发出一条消息，到助手这条回复结束为止的一次往返，包括其间的模型步骤和工具调用。
_Avoid_: 新请求、request、response

**Temporary Chat（临时聊天）**:
只存在于内存里的 Chat，不读也不写任何个人记忆，离开即消失。
_Avoid_: 无痕模式、incognito

**Archived Chat（已归档的聊天）**:
从侧栏隐藏的 Chat。它仍能被搜索，也仍会写进 Memory Summary；要让 Beluga 忘掉一个 Chat，只能删除它。
_Avoid_: 存档、archive（与 Imported History 混淆）

**Chat Activity State（聊天活动状态）**:
一个 Chat 此刻需要用户关注的程度：进行中、等你处理、有新回复或空闲。按优先级排序就是按它排序。
_Avoid_: priority、未读、单说“状态”

**Imported History（导入历史）**:
从 ChatGPT 官方导出导入的对话原文。它只读，并按原样保留，包括其中的指令块、ID 和原始导出数据。
_Avoid_: archive（与 Archived Chat 混淆）、旧对话、原先对话

**To-do List（待办清单）**:
模型在一个回合开始时列出的步骤及各步完成状态，是回合过程中用户看到的进度。单步回合没有待办清单。
_Avoid_: plan、todos、计划、进度日志

**Condensed History（压缩历史）**:
一个聊天里最早几轮由模型改写成的一段浓缩文字，模型请求用它代替这些轮次的原文。它只给模型看：用户照常看到、保存、搜索和导出每条消息。它只属于这个聊天，从不进入记忆摘要。
_Avoid_: 记忆摘要（那是跨聊天的）、省略消息、截断、compaction summary

**Sources（来源）**:
一条回复下列出的、这个回合用到的材料：网页、调取到的 Saved Memory 和引用的过去 Chat。Memory Summary 与 Custom Instructions 每个回合都在用，不逐条列出。
_Avoid_: citations、引用、参考资料

## 项目

**Project（项目）**:
一组 Chat，带自己的文件、项目指令和 Memory Scope。它不对应任何磁盘目录。
_Avoid_: workspace、文件夹、folder

**Memory Scope（记忆范围）**:
一个 Project 选定的记忆边界：默认，或仅限项目。仅限项目时，项目内外的 Chat 与个人记忆互不读取，项目里的 Chat 也不写进 Memory Summary；Custom Instructions 照常适用。
_Avoid_: project-only memory、隔离、沙箱

## 模型

**Model Route（模型路由）**:
用户可选的一个“提供方 + 模型”组合，来自 Harness 已配置的提供方或 Beluga 的 Inline Route。
_Avoid_: 自定义模型、provider、单说“模型”

**Inline Route（内联路由）**:
由 Beluga 自己直连的 Model Route，图片随请求发出，不交给 Harness 保存。只有它能发送图片。
_Avoid_: image route、图片模型

**Reasoning Effort（思考强度）**:
一个回合要求模型投入的思考档位。可选档位由所选 Model Route 提供。
_Avoid_: thinking level、推理强度、effort mode

## 记忆

**Memory Summary（记忆摘要）**:
Beluga 从用户自己的非临时聊天里提炼出的、关于用户的长期概述，按主题分节，并在聊天空闲后自动更新。它只记录用户自己说出或明确确认的内容；用户让助手写的稿件、粘贴的资料和假设都不算用户的观点。之后的普通聊天都会把它当作背景。它一开始是空白；Imported History、临时聊天、仅限项目的 Project 和 Work 都不会写进去。用户可以在设置里直接编辑它、询问它，或恢复上一版。
_Avoid_: 长期记忆、用户画像、profile、memory

**Saved Memory（已保存的记忆）**:
用户确认过的一条具体事实或偏好，逐条列出，可以单独编辑或忘记。它和 Memory Summary 并存，只在与当前消息相关时提供给模型。
_Avoid_: 记忆条目、memory item

**Custom Instructions（自定义指令）**:
用户亲手设定、希望每个普通聊天都遵守的内容：“关于你”，以及“回复方式”（基础风格、几项特征和自己写的要求）。模型不会改写它；临时聊天不使用它。它和 Memory Summary、Saved Memory 并列，是个人记忆中唯一完全由用户决定的一种。
_Avoid_: profile、个人资料（与 Harness profile 混淆）、个人聊天指令、personal instructions

**Sensitive Topic（敏感话题）**:
健康、性取向、宗教、政治观点、民族、犯罪记录、精确位置，以及财务和支付方式。默认不写进 Memory Summary，除非用户明确要求记住；用户可以打开“记录敏感话题”。密码、密钥、证件号、卡号、电话和邮箱不属于此类，任何时候都不写。
_Avoid_: 隐私信息、PII

## 应用

**App（应用）**:
回合中可供模型使用的服务，目前是网页搜索。用户在设置的“应用”页决定模型能否在需要时自动使用它；关闭后，只有从 + 菜单选了它的消息才会用。
_Avoid_: connector、连接器、integration

**Work Records（Work 记录）**:
一个 App：只读地搜索和读取用户允许的 Workspace 里的 Session。读到的内容是工具输出，不算用户说过的话，也不写进个人记忆。
_Avoid_: Work 历史、session history

## Work

**Work（工作）**:
Harness 原生的编码 agent，以 Session 为单位在 Workspace 里运行。Beluga 不保存也不改动它的数据。
_Avoid_: 开发模式、code mode

**Session（会话）**:
Work 里的一次原生 agent 会话。Beluga 的对话是 Chat，不叫 Session。
_Avoid_: 用来指 Chat

**Workspace（工作区）**:
Work 的一个项目目录记录，连同在其中运行过的 Session。它只属于 Work，Project 不绑定它。
_Avoid_: 项目（那是 Project）

**Memory Lookup（记忆查询）**:
用户打开后，顶层 Work Session 的模型在任务需要时只读地查询 Saved Memory 和 Memory Summary 的能力，默认关闭；子 agent 和生成的代码不能使用。Custom Instructions 不经由它进入 Work。
_Avoid_: 记忆同步、共享记忆

**Hand-off to Work（交给 Work）**:
用户从一个 Chat 发起的一次性交接：Beluga 写出任务说明并预填进 Work 的新 Session，由用户选择 Workspace 并发送。
_Avoid_: 同步、迁移、转换
