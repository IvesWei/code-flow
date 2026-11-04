# SDK 会话恢复排查

## 数据库存储

会话关联存放在 `codeflow_tasks.payload` 的 `copilotSession` 对象中，包括 id、directory 和 previousIds，不依赖单独的会话 ID 数据库列。完整 SDK 会话历史仍在本地 `DATA_DIR/sessions/<taskId>/session-state/<sessionId>`。

排查时先确认 payload 中的会话 ID、目录关联及对应本地历史是否存在，不输出凭据、完整对话或图片内容。不应因恢复错误直接修改数据库表。

## 附件兼容问题

2026-10-10 的实际任务出现 SDK 恢复错误：`Failed to read JSONL ... Invalid event ... untagged enum Attachment`。会话 ID 已保存在数据库，本地历史存在。当前 SDK 发送类型允许省略文件附件 displayName，但历史读取器无法解析这些附件；临时副本中只补齐 displayName 后越过了历史解析阶段。

平台发送附件时总是携带 displayName。恢复时仅命中上述明确的历史附件解析错误，才对缺少 displayName 的 file 附件补充文件名。消息正文、事件 ID、附件路径和图片 assetId 不变，保持原会话 ID；不删除历史、不重建会话。

修改前完整备份为同目录 `events.jsonl.<随机ID>.backup`，用临时文件替换并检查期间历史是否改变。修复后仅重试恢复一次。无法备份或无法安全补齐时停止，并给出提示。备份含完整对话，应使用与 SDK 历史相同的权限和敏感数据保留策略。

SDK 会话配置同时传递当前登录用户的 gitHubToken；token 不存入任务 payload 或活动日志。未登录或认证失败需要重新登录，不自动切换账号或创建新会话。

## 验证边界

已在真实失败任务的临时会话副本中复现原附件解析错误，并验证补齐显示名后进入认证阶段；探测使用无效测试凭据、不发送消息、不执行工具、不修改原任务。原任务在有效登录凭据下的完整继续执行仍需平台用户正常重试。

加载新后台代码后，继续原任务时不要选择备用新会话；否则会走显式降级路径，不执行原历史修复。恢复成功后活动记录应出现备份补齐及原 SDK 会话恢复信息。