# 机器人日志回放前端

T05 已提供可独立运行的 Vue Mock 工作台。包含会话创建、示例上传/加载、播放控制、28 关节与底盘、配对画布、错误与迟到场景。当前机器人是程序绘制的合成示意图；实际 IsaacSim 视频、真实日志解析和正式后端业务尚未接入。

## 启动

本机验证环境为 Node 26.8.1、npm 11.19.0。依赖锁定在 `package-lock.json`，首次安装后默认启动明确标注的 Mock 模式，不需要 GPU 或后端：

```bash
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173`，依次点击“创建会话”→等待就绪→“载入示例日志”→“播放”。示例为 12 秒、721 个原采样点、20Hz 目标采集；暂停保持日志位置但继续生成带新身份的画面，便于独立检查配对。

上传入口仅用于模拟导入流程，最大 1MiB。Mock 保存文件名、SHA256 与映射信息，不解析或持久化文件内容；显示值始终来自合成轨迹。来源标记为推算，缺通道时明确标为无效/补值。

## 场景与同步

“演示场景”可切换正常、无日志、解析失败、缺通道、worker 故障、画面迟到、数据迟到和连接重建。解析失败与缺通道在下一次载入时生效；worker 故障需要关闭、重建会话并重新载入，从零开始。

Mock 帧依据冻结快照绘制，经 ImageBitmap 实际像素 ID＋CRC 校验后，与 WS 快照按完整 ID 配对。在同一 canvas 内绘制图像、28 关节、底盘、时间和进度。服务端接受控制不会直接改变当前显示数据；迟到时整组保持，不用固定延迟或最新遥测代替匹配。

`useVideoSource` 负责显式选择和释放源，连接代次、控制屏障与缓存上限隔离过期内容。正式 WHEP 适配在 T15 接入；真实模式当前不产生替代的 Mock 图像。

## 真实模式

```bash
VITE_USE_MOCK=false npm run dev
```

默认把 `/api`、`/ws` 代理至本机 8000。后端契约应用可在 `../backend` 按其 README 启动；当前合法业务调用返回 `503 BACKEND_NOT_CONFIGURED`，页面会显示真实错误。

用 `API_PROXY_TARGET=http://127.0.0.1:18000` 调整开发代理目标；`VITE_API_BASE_URL` 调整 API 基址。切换模式后重启 Vite 并刷新页面。生产构建的模式同样在构建时确定。

## 检查

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
```

完整 E2E 使用系统 Chrome，并托管 5173 Mock、5174 真实模式以及 18000 后端契约服务；需要已准备好的 `../backend/.venv`。不复用已有服务器，占用端口时明确失败，退出后清理测试服务。可通过 `CHROME_BIN` 指定 Chrome；仅测试前端时运行 `E2E_REAL=0 npm run test:e2e`。

浏览器检查独立读取画布 ID/CRC、时间与部分关节文字像素、进度条和机器人图像，覆盖迟到、故障、重连与资源释放。结果在 `output/test-results`；概要见 [T05 验证记录](docs/validation/t05-status.md)。

## 契约来源

`src/api/types.gen.ts` 来自后端 OpenAPI；`messages.gen.ts`、`generated/` 和 `schemas/` 来自独立 WS/IPC/媒体 JSON Schema。AJV 在浏览器运行时验证输入，不能只依赖编译期 TypeScript。

在 `../backend` 执行以下命令重新生成，禁止直接编辑生成文件：

```bash
env -u PYTHONPATH -u PYTHONHOME .venv/bin/python scripts/export_contracts.py
npm run generate --prefix tools/contracts -- --frontend-dir ../frontend/src/api
npm run check --prefix tools/contracts
```

`public/mockServiceWorker.js` 由固定版本 MSW 生成并入库；升级 MSW 后通过 `npx msw init public --save` 更新。不要手改生成契约、Schema 或关节元数据 fixture。

下一步为 T06/T07 的完整播放器交互、映射入口、关节分组与历史曲线/事件面板。ECharts 依赖已准备，曲线面板尚未实现。T08 之后再接真实文件适配与后端回放。
