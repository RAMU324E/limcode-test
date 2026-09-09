# 设置及时生效与保存等待修复记录

- 日期：2026年9月7日。
- 调查基线：版本 `0.0.18`，提交 `528d720f929acd84ece7d6d7bf8f1c68e8557f1e`。
- 状态：工作区修复；未提交、打包、安装或发布。
- 范围：压缩配置采用时机、渠道设置保存确认、冲突恢复、对话阈值显示。

## 已确认原因

1. 原来把压缩规则与模型、权限一起固定在整轮任务配置中。同一任务调用工具后再请求模型，仍沿用旧压缩规则；新手动压缩也完整继承上一轮配置。
2. 渠道和压缩配置有四百毫秒自动保存延迟，但发送消息和手动压缩原先不等待保存。
3. 压缩配置转成发送数据时，每次都会生成新的修改时间。即使用户没有继续编辑，保存比较也会认为又有变化；后台更新时间、前端补齐默认字段又扩大了这种误判。
4. 页面只靠原保存请求的对应回应解除等待。回应丢失后，后续保存一直排队；外部新配置先于冲突通知到达时，也可能一直等待已经收到的内容。
5. 对话用量提示把最近请求的旧阈值称为“配置压缩阈值”，造成设置页已修改但对话看起来未更新。

## 修复行为

1. 每个尚未建立的普通模型请求读取该模型对应的当前压缩设置，并通过现有 `ModelRequest.settings_snapshot_object_id` 保存一份独立请求设置。自动压缩和紧接它的普通请求使用同一份设置。
2. 新手动压缩读取当前压缩方法与阈值，不再仅采用上一轮旧压缩规则。已经建立的请求重试、恢复和历史重放只读取原请求设置；模型身份与工具权限不能被这份压缩设置替换。
3. 同一宿主内，新输入、编辑后执行、重新生成和新手动压缩先通知所有已就绪页面立即提交相关渠道设置，再等待保存确认。已提交命令的重复查询不再等待新设置，避免妨碍原任务恢复。
4. 保存回应五秒未到时先重新读取核对；再等五秒仍无法确认则报错并保留本地表单。页面确认最多等十二秒，宿主确认最多等十五秒；关闭页面和消息发送失败也会结束等待。
5. 保存比较忽略记录本身的修改时间差异，并统一前后端默认字段；不会忽略用户自定义参数里的同名字段。不同字段修改可合并，同字段冲突须用户明确选择，禁止静默覆盖；其他窗口撤回冲突后解除暂停并继续保存。
6. 重新读取设置或宿主重连不清掉未保存表单。迟到的旧保存回应不能覆盖刚确认的新设置。
7. 对话提示分别显示“当前配置压缩阈值”和“最近请求采用阈值”，并区分关闭自动压缩、仅手动压缩。

## 代码与测试位置

- 单请求设置：`backend/reliableKernel/requestCompressionSettings.ts`、`modelProviderControlPlane.ts`、`agentLoop.ts`、`contextCompressionCoordinator.ts`、`vscodeConfigurationAuthority.ts`。
- 保存协调：`backend/application/reliableKernel/GlobalSettingsSaveBarrier.ts`、`VscodeReliableKernelCommandRouter.ts`、`webview/src/stores/useGlobalSettingsStore.ts`、`webview/src/composables/useBridgeBootstrap.ts`。
- 对话显示：`webview/src/components/conversation/ReliableContextStatus.vue`。
- 新增回归测试：`tests/reliable-kernel/request-compression-settings.test.mjs`、`tests/reliable-kernel/global-settings-live-save.test.mjs`；同时补充现有命令入口测试与持续集成测试清单。
- 浏览器验证：`scripts/playwright/verify-compression-settings.mjs`，模拟修改滑条、扣住保存回应、重新核对保存、执行放行和不再重复保存。
- 规则同步：`docs/global-settings-data-integration.md`、`01-invariants-and-authority.md`、`contracts/context.json`、`phases/phase-e-context-provider.md`。

## 验证结果

- `npm run check:local`：编译、前端构建、前端类型检查、十一份合同检查通过；本机测试375项通过、13项跳过、0项失败。
- 保存与显示专项14项通过，已纳入上述完整检查，包含自定义参数时间字段冲突、冲突解除后继续保存和对话阈值即时刷新。
- `node --test tests/settingsRevisionConflict.test.cjs`：5项通过、7项仅适用于其他操作系统的测试跳过。
- 真实浏览器：1440×1000、700×1000两个尺寸通过；均复现扣住保存回应后的自动核对与恢复，未出现页面错误、请求失败或横向溢出，并检查了两张实际截图。
- 后台测试使用临时数据库、临时配置与模拟模型，验证同一任务第二次请求采用新阈值、自动压缩无需补发用户消息、手动压缩采用新方法、请求恢复不改用后来的配置。
- 本机完整检查中的13项跳过包含基础场景运行条件和平台限定测试，不表示这些项目已经在本次环境执行通过。
- 检查基于未提交工作区，不是干净提交、发布包或实际安装后的证明。
- 本机验证日志：`/tmp/limcode-settings-final-check-20260907.log`、`/tmp/limcode-settings-revision-check-20260907.log`；浏览器截图及报告位于 `/var/folders/cz/6c_ysj195sbcytsy44zttdbc0000gn/T/limcode-compression-visual-Dhnt9H/`。

## 数据与生效边界

- 未改变数据库表结构、运行数据版本或迁移规则；复用现有请求设置引用。不清库、不重建用户数据、不覆盖旧任务的基础配置。
- 本次未读取或修改用户真实对话，未调用外部模型，也未替换已安装扩展。
- 保存设置不会在空闲对话中自行启动收费的压缩请求。正在执行的长任务在下一次尚未建立的模型请求前采用新设置；已经开始的请求继续使用原设置。
- 模型选择、提示词、工具权限仍遵守原有整轮规则，本次不会在运行中强行切换这些执行条件。
- 保存确认覆盖同一宿主的已就绪页面。不同宿主中已落盘的配置仍由现有文件监听和下一请求读盘获得；没有新增跨进程未保存表单的原子协调保证。
- 已修复可复现的保存无限等待路径。缺少用户某次故障的现场日志，不能把所有模型网络慢、工具等待都归为同一原因。
