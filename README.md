# 机器人日志回放前端

当前完成 T04 的生成接口类型，尚未初始化 Vue 工作台（T05）。`src/api/types.gen.ts` 来自后端 OpenAPI；`messages.gen.ts` 与 `generated/` 来自独立 WS、IPC、媒体及回放 JSON Schema。

在 `../backend` 执行以下命令重新生成，禁止直接编辑生成文件：

```bash
env -u PYTHONPATH -u PYTHONHOME .venv/bin/python scripts/export_contracts.py
npm run generate --prefix tools/contracts -- --frontend-dir ../frontend/src/api
npm run check --prefix tools/contracts
```

下一步接入 Vue/TypeScript、Mock 数据层及同步呈现状态管理。当前没有可启动的前端界面，也不依赖真实 log。
