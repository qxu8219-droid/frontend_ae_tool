# 机器人日志回放前端

T05～T07 已提供可独立运行的 Vue Mock 工作台。包含会话创建、上传检查与映射、完整播放器、28 关节分组与底盘朝向、历史曲线、事件过滤/定位、系统健康与故障场景。当前机器人是程序绘制的合成示意图；实际 IsaacSim 视频、真实日志解析和正式后端业务尚未接入。

## 启动

本机验证环境为 Node 26.8.1、npm 11.19.0。依赖锁定在 `package-lock.json`，首次安装后默认启动明确标注的 Mock 模式，不需要 GPU 或后端：

```bash
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173`，依次点击“创建会话”→等待就绪→“载入示例日志”→“播放”。示例为 12 秒、721 个原采样点、20Hz 目标采集；暂停保持日志位置但继续生成带新身份的画面，便于独立检查配对。

上传入口仅用于模拟导入流程，最大 1MiB。选择文件后先显示统计、缺失通道、全部诊断与映射快照，再点击“激活此日志”；上传失败不会替换正在回放的日志，也不会留下旧候选供误激活。映射入口支持可选解析器标识和内联 JSON 对象，不假定真实日志字段。Mock 保存文件名、SHA256 与映射信息，不解析或持久化文件内容；显示值始终来自合成轨迹。来源标记为推算，缺通道时明确标为无效/补值。

## 场景与同步

“演示场景”可切换正常、无日志、解析失败、缺通道、worker 故障、画面迟到、数据迟到和连接重建。解析失败与缺通道在下一次载入时生效；worker 故障需要关闭、重建会话并重新载入，从零开始。

Mock 帧依据冻结快照绘制，经 ImageBitmap 实际像素 ID＋CRC 校验后，与 WS 快照按完整 ID 配对。在同一 1280×1080 canvas 内绘制图像、28 关节、底盘、时间、进度和曲线游标。图像区域仍为 900×506.25；扩展区域用于曲线。服务端接受控制不会直接改变当前显示数据；迟到时整组保持，不用固定延迟或最新遥测代替匹配。

时间轴拖动采用 100ms 防抖，释放立即提交最终位置；预览位置与已呈现时间分开。控制器合并等待中的定位，只保留最新意图；数字秒数与原采样帧序号（从 0 开始）均可定位。关节分为底盘、躯干、左臂与右臂四组，缺失数值显示“—”，连续关节显示无限位，其余关节有进度和临界/超限标记。

历史曲线通过已有 `curve` 接口一次加载当前日志，不因 seek 或重播重复追加。最多显示 4 个通道，各用独立纵轴；缺测断线，超限区间着色。ECharts 仅生成静态栅格，实时游标由共同画布根据已呈现帧绘制。通道多选使用 Ctrl / ⌘，需先取消已选项才能换入新通道。

事件有“预扫描限位历史”和“本轮播放已触发”两种视图，均支持倒序、级别筛选和点击定位。现有契约没有独立通用事件历史端点，预扫描视图明确来源于 `limit_intervals`，不冒充全部日志事件；本轮 WS 告警按实际呈现时刻放行。CPU/内存/GPU/worker 健康使用系统时间独立更新。

`useVideoSource` 负责显式选择和释放源，连接代次、控制屏障与缓存上限隔离过期内容。正式 WHEP 适配在 T15 接入；真实模式当前不产生替代的 Mock 图像。

## 真实模式

```bash
VITE_USE_MOCK=false npm run dev
```

默认把 `/api`、`/ws` 代理至本机 8000。后端契约应用可在 `../backend` 按其 README 启动；当前合法业务调用返回 `503 BACKEND_NOT_CONFIGURED`，页面会显示真实错误。

真实模式前端上传上限默认 64MiB，可通过 `VITE_MAX_UPLOAD_BYTES` 设置；最终仍以服务端校验为准。Mock 固定为 1MiB。

用 `API_PROXY_TARGET=http://127.0.0.1:18000` 调整开发代理目标；`VITE_API_BASE_URL` 调整 API 基址。切换模式后重启 Vite 并刷新页面。生产构建的模式同样在构建时确定。

## 检查

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
```

完整 E2E 使用系统 Chrome，并托管 5183 Mock、5184 真实模式以及 18010 后端契约服务（避开常用开发端口 5173）；需要已准备好的 `../backend/.venv`。不复用已有服务器，占用端口时明确失败，退出后清理测试服务。可通过 `CHROME_BIN` 指定 Chrome；仅测试前端时运行 `E2E_REAL=0 npm run test:e2e`。

浏览器检查独立读取画布 ID/CRC、时间与部分关节文字像素、进度条和机器人图像，覆盖迟到、故障、重连与资源释放。结果在 `output/test-results`；概要见 [T05 验证记录](docs/validation/t05-status.md)与 [T06/T07 验证记录](docs/validation/t06-t07-status.md)。

## 契约来源

`src/api/types.gen.ts` 来自后端 OpenAPI；`messages.gen.ts`、`generated/` 和 `schemas/` 来自独立 WS/IPC/媒体 JSON Schema。AJV 在浏览器运行时验证输入，不能只依赖编译期 TypeScript。

在 `../backend` 执行以下命令重新生成，禁止直接编辑生成文件：

```bash
env -u PYTHONPATH -u PYTHONHOME .venv/bin/python scripts/export_contracts.py
npm run generate --prefix tools/contracts -- --frontend-dir ../frontend/src/api
npm run check --prefix tools/contracts
```

`public/mockServiceWorker.js` 由固定版本 MSW 生成并入库；升级 MSW 后通过 `npx msw init public --save` 更新。不要手改生成契约、Schema 或关节元数据 fixture。

下一步为 T08 日志导入、映射与参考适配器，以及后端时间轴与 worker 业务。真实日志字段需要等待实际样例分析；目前不宣称真机数据解析或正式 IsaacSim 视频接入已完成。
