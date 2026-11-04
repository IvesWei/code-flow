import { databaseConfig } from './database-config.js'
import { MysqlTaskPersistence } from './database.js'
import { loadStorageEnvironment } from './storage-runtime.js'

loadStorageEnvironment()
let database: MysqlTaskPersistence | undefined
try {
  const config = databaseConfig()
  if (!config) throw new Error('请设置 TASK_STORAGE=mysql 后检查连接')
  database = await MysqlTaskPersistence.connect(config)
  await database.health()
  console.log('MySQL 连接、schema v2、九张表字段和单实例锁检查通过；未导入或写入任务')
} catch (error) {
  console.error(error instanceof Error ? error.message : '数据库检查失败')
  process.exitCode = 1
} finally { await database?.close() }