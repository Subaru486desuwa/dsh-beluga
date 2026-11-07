# 白鲸 Beluga

DeepSeek Harness 的个人 Chat 插件，名字来自最爱“说话”的鲸鱼之一。

[English](README.md)

用一个插件，在 Harness 的 Work 旁增加个人 Chat、ChatGPT 历史导入、用户画像和可控记忆。Chat 不要求选择仓库，也不会把个人聊天伪装成 Work 执行记录。

Chat 插件基础安装仅提供 **Chat 与 Memory**（含历史导入等已有能力）。**Word／PPT／Excel 办公扩展推荐但不预装**：必须由用户明确同意后，单独下载并启用 `dsh-beluga-office`。基础包不依赖办公包，也不包含其文件处理库；模型和上传文件均不能触发自动安装。

## 从源码构建

目前还没有发布好的 tarball 或 npm 包，需要用 Node 24.9+ 和 pnpm 自行构建：

```sh
git clone https://github.com/Subaru486desuwa/dsh-beluga.git
cd dsh-beluga
pnpm install --frozen-lockfile
pnpm run build
pnpm run pack
```

tarball 生成在 `dist/`，下面的命令请换成对应路径。

## 安装构建好的插件

目标版本：**未修改的 DSH 0.2.1-rc.3**，Node **24.9+**。当前是发布前候选版，尚未发布到 npm 或公共插件市场。

将构建好的 tarball 安装到所选 **web** profile，再重启该 profile：

```sh
dsh plugin --profile web add ./dsh-beluga-0.1.0.tgz
dsh --profile web
```

从 Harness 侧栏打开 **Chat**，选好已配置的模型即可聊天。**Work** 按钮返回原工作界面，保留原先选中的工作会话。插件只增加自己的配置项，不替换官方模块、不修改 Harness 核心。

## 聊天与文件

- 流式回复、停止、复制；编辑用户消息或重新生成回复时保留旧分支。
- 搜索标题和正文，重命名、归档／恢复、删除聊天及其附件。
- 上传文本、可提取文字的 PDF 和图片；扫描 PDF 需要先在外部 OCR。图片需要下方的独立内联模型配置。
- 用户安装办公扩展后，DOCX／XLSX／PPTX 支持结构化内容读取。可生成 Word 标题、正文和表格，并继续修改本插件生成的文档，旧版本保留；上传模板编辑、Excel／PPT 生成及聊天内办公预览尚未接通。
- 联网默认关闭；按请求开启后使用已有 Harness 联网服务。Chat 不开放终端、任意文件系统或部署工具。

## 导入 ChatGPT 历史

打开 **导入** → 选择官方 ZIP 或 `conversations.json` → 核对数量与警告 → **导入**。

保留原始 JSON、未知字段、角色、时间、完整 `mapping` 分支图和 `current_node`。可切换任意原分支查看。原档案中的媒体引用会保留，但不导入 ZIP 内媒体文件，也不会自动下载外链图片。重复内容跳过，变化的内容保存新修订；撤销导入只移除该批次的档案，不删除之后继续聊的内容。

直接在所选历史分支下继续聊天。模型获得有大小上限、明确标注为不可信历史的上下文；被省略的节点会提示，完整原档案仍可查看。

默认上限：上传 64 MiB、解压后对话 JSON 256 MiB、10,000 条对话、总计 500,000 个节点、已存档案 512 MiB。遇到不支持或损坏的记录时，预览会整体拒绝，不悄悄丢弃。当前兼容性测试使用合成数据；用户已申请的真实导出到达后，另行验收。

## 用户画像与记忆

**记忆** 页管理背景信息、个人指令、已确认记忆与待审核项。画像不依赖关键词召回。只有范围很窄、能追溯到用户原话的低风险偏好可自动保存；敏感、推断和冲突信息需要确认。自动保存会给出撤销入口；纠正会替代旧事实，忘记会阻止从相同文本或旧证据自动重新学回。

可先预览再导入已保存记忆的文本／JSON，以及个人指令 Markdown。导入 `AGENTS.md` 时需检查内容是否属于个人范围；插件不会修改源文件或 Work 规则。不要导入凭据。对话 ZIP 不会自动还原 ChatGPT 单独的已保存记忆库。

## 临时聊天

消息和附件仅保留在内存，不读取／写入画像和长期记忆，不进入历史，也不保存浏览器草稿。离开页面即关闭；断线后无人查看的临时聊天按配置超时清理，默认 60 秒。宿主重启后不保留。

所选模型服务仍会收到请求，适用其自身的数据保留政策。用户另装的 Harness 观察插件与操作系统转储不属于本插件的存储边界。文本调用不设置 Work `sessionId`，图片绕开宿主的持久上传流程。

## 可选：内联图片模型

文本复用 Harness 模型路由。图片需要一个接受内联图片的 OpenAI-compatible Chat Completions 接口，以及**已有 Harness 凭据引用**，不要在配置中写 API key。修改所选 profile 的 patch：

```yaml
- id: personal-chat
  config:
    dataDir: !!js dshHomePath('personal-chat')
    inlineProvider:
      baseURL: https://YOUR-PROVIDER.example/v1
      credentialRef: YOUR_EXISTING_CREDENTIAL_REFERENCE
      models: [YOUR_IMAGE_MODEL]
```

选择带 **Inline images** 标记的模型。它使用提供商 API，不等同于 ChatGPT 网页订阅。rc.3 原生图片流程会落盘，因此这里采用独立内联路径。协议与载荷由本地 HTTP fixture 验证；具体真实提供商／模型组合仍需单独验收。

## 数据与卸载

插件数据在 `$DSH_HOME/personal-chat`：私有 SQLite 数据库及附件。备份时先停止该 profile。删除聊天会清理其历史和附件，但单独确认过的记忆仍保留，需要在记忆页另行忘记。卸载不删除个人数据：

```sh
dsh plugin --profile web remove dsh-beluga
```

多个 profile 同时运行时应使用不同 `dataDir`；写入锁会阻止多个实例共用同一数据库。

## 按需安装办公扩展

确认愿意下载办公依赖并启用文件处理后，再在已安装 Chat 的同一 profile 执行：

```sh
dsh plugin --profile web add ./dsh-beluga-office-0.1.0.tgz
```

重启该 profile 后生效。未安装时可保管和下载 Office 原件，但不会向模型提供办公生成或编辑工具。卸载办公扩展只停止处理能力，保留聊天、记忆和已有产物下载：

```sh
dsh plugin --profile web remove dsh-beluga-office
```

两个包目前均未发布到公共市场；上述路径指自行构建或明确取得的 tarball。
