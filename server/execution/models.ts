import { CopilotClient } from '@github/copilot-sdk'
import type { ModelInfo } from '@github/copilot-sdk'

export function defaultModel(): string {
  return process.env.COPILOT_MODEL?.trim() || 'auto'
}

export async function availableModels(token: string): Promise<ModelInfo[]> {
  const client = new CopilotClient({ gitHubToken: token, useLoggedInUser: false })
  try {
    await client.start()
    return await client.listModels()
  } finally {
    await client.stop()
  }
}

export function validateModel(modelId: unknown, models: ModelInfo[], hasImages: boolean): string {
  if (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 120) throw new Error('请选择 Copilot 模型')
  if (modelId === 'auto') return modelId
  const model = models.find((item) => item.id === modelId)
  if (!model || (model.policy && model.policy.state !== 'enabled')) throw new Error('当前账号不可使用所选模型，请重新选择')
  if (hasImages && !model.capabilities.supports.vision) throw new Error('所选模型不支持设计截图，请选择支持图片的模型')
  return model.id
}