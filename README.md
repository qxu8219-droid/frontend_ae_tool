# 机器人日志回放前端

当前发布基线：**v1.0.0**。查看[发布说明](docs/releases/v1.0.0.md)与[Git 开发规范](CONTRIBUTING.md)。两个仓库需使用同名版本标签；后续需求从 `main` 新建分支。

本分支采用浅色工作台：顶部环境与日志工具条、右侧导入/详情抽屉、双臂在上的 2×2 关节分组、四条叠放曲线，以及下方阶段/限位/运行记录页签。通道选择、精确定位、会话关闭和健康信息通过局部弹层操作。

T05～T07 已提供可独立运行的 Vue Mock 工作台。包含会话创建、上传检查与映射、完整播放器、28 关节分组与底盘朝向、历史曲线、事件过滤/定位、系统健康与故障场景。T15 接入实际 IsaacSim 6.2 视频和正式后端业务，T16 已增加 B041 便携包上传、暂定映射来源及按源帧对齐的标注展示。真实视频与数据严格按同帧身份共同呈现；Mock 模式保留独立合成示意图。媒体使用见 [真实回放说明](docs/real-media-v1.md)，真机数据使用见 [B041 回放说明](https://github.com/qxu8219-droid/backend_ae_tool/blob/v1.0.0/docs/b041-replay-v1.md)。

首次安装和本地交付请先阅读 [运行手册](https://github.com/qxu8219-droid/backend_ae_tool/blob/v1.0.0/docs/delivery-v1.md)；故障定位见 [排查说明](https://github.com/qxu8219-droid/backend_ae_tool/blob/v1.0.0/docs/troubleshooting-v1.md)，本次交付版本见 [T18记录](https://github.com/qxu8219-droid/backend_ae_tool/blob/v1.0.0/docs/validation/t18-status.md)。

## 启动

T17 已完成本地 30 分钟真实回放、进程/消息故障与无损屏幕逐帧核对，见[验证记录](https://github.com/qxu8219-droid/backend_ae_tool/blob/v1.0.0/docs/validation/t17-status.md)。真实模式会记住当前标签页成功创建的会话；刷新时先释放旧会话，再重新创建并上传日志。失败时可“重试关闭”，复制标签页不会自动接管普通导航继承的会话。创建响应尚未返回 sid 就强制销毁文档的情况，暂不自动恢复。原始日志和映射需另行保留。

本机验证环境为 Node 26.8.1、npm 11.19.0。依赖锁定在 `package-lock.json`，首次安装后默认启动明确标注的 Mock 模式，不需要 GPU 或后端：

```bash
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173`，依次点击“创建会话”→等待就绪→“导入日志”→“载入示例日志”→关闭导入抽屉→“播放”。示例为 12 秒、721 个原采样点、20Hz 目标采集；暂停保持日志位置但继续生成带新身份的画面，便于独立检查配对。

上传入口仅用于模拟导入流程，最大 1MiB。选择文件后先显示统计、缺失通道、全部诊断与映射快照，再点击“激活此日志”；上传失败不会替换正在回放的日志，也不会留下旧候选供误激活。映射入口支持可选解析器标识和内联 JSON 对象，不假定真实日志字段。Mock 保存文件名、SHA256 与映射信息，不解析或持久化文件内容；显示值始终来自合成轨迹。来源标记为推算，缺通道时明确标为无效/补值。

## 场景与同步

“演示场景”可切换正常、无日志、解析失败、缺通道、worker 故障、画面迟到、数据迟到和连接重建。解析失败与缺通道在下一次载入时生效；worker 故障需要关闭、重建会话并重新载入，从零开始。

Mock 帧依据冻结快照绘制，经 ImageBitmap 实际像素 ID＋CRC 校验后，与 WS 快照按完整 ID 配对。在同一 1600×920 canvas 内绘制图像、28 关节、底盘、时间、进度和曲线游标。图像区域为 768×432；下方 1568×336 区域用于四条独立纵轴的历史曲线。服务端接受控制不会直接改变当前显示数据；迟到时整组保持，不用固定延迟或最新遥测代替匹配。

时间轴拖动采用 100ms 防抖，释放立即提交最终位置；预览位置与已呈现时间分开。控制器合并等待中的定位，只保留最新意图；数字秒数与原采样帧序号（从 0 开始）均可定位。关节分为底盘、躯干、左臂与右臂四组，缺失数值显示“—”，连续关节显示无限位，其余关节有进度和临界/超限标记。

历史曲线通过已有 `curve` 接口一次加载当前日志，不因 seek 或重播重复追加。最多显示 4 个通道，各用独立纵轴；缺测断线，超限区间着色。ECharts 仅生成静态栅格，实时游标由共同画布根据已呈现帧绘制。通过“选择通道”勾选最多四项，点击“应用”才更新；取消弹窗不改变当前选择。已选标签可直接移除。

事件有“预扫描限位历史”和“本轮播放已触发”两种视图，均支持倒序、级别筛选和点击定位。现有契约没有独立通用事件历史端点，预扫描视图明确来源于 `limit_intervals`，不冒充全部日志事件；本轮 WS 告警按实际呈现时刻放行。CPU/内存/GPU/worker 健康使用系统时间独立更新。

`useVideoSource` 负责显式选择和释放源，连接代次、控制屏障与缓存上限隔离过期内容。正式 WHEP/WebCodecs 适配已接入；真实模式不产生替代的 Mock 图像。

## 真实模式

```bash
VITE_USE_MOCK=false API_PROXY_TARGET=http://127.0.0.1:8000 npm run dev
```

默认把 `/api`、`/ws` 代理至本机 8000。请在 `../backend` 用 `ISAACSIM_PYTHON=... bash scripts/run_backend.sh` 启动实际服务；直接启动默认契约应用仍返回 `503 BACKEND_NOT_CONFIGURED`。首次创建后等待 worker 就绪，打开“导入日志”，先填写映射，再选择 CSV/JSON/`.b041`。检查解析结果后显式激活，等待新日志首帧到达，再点击播放。

B041 先在“解析器与映射配置”的“映射 JSON”粘贴 `mapping.json` 内容，再选择同目录 `recording.b041`；选择文件会触发上传，解析器可留空。通常路径为 `../backend/data/real_logs/derived/<source_id>/b041_ee2_body_velocity_v1/`。检查导入统计、诊断及映射快照后再点“激活此日志”。完整保存的映射快照可原样重导入；变更夹爪或底盘假设只使用 `b041` 专用参数，通用字段覆盖会被后端以 400 拒绝。

“标注与来源”显示当前已呈现时刻对应的源帧阶段、暂定假设和待审状态。`pending_review`、`training_approved=false` 保持源状态；Rim 的 `reference_only` 仅作历史来源参考，不映射到当前运行或用于定位。四个 finger 和离线积分底盘明确标为推算，在线无可靠位姿时底盘不可用，不能依据 target 移动。历史事件与当前帧状态分开呈现。

顶部“日志详情”查看当前激活日志的统计、诊断、只读映射快照与上传文件 SHA256。上传第二份候选不会替换当前日志详情；“暂不激活”或关闭抽屉保留候选，重新打开导入可继续核对。修改配置必须重新上传，不修改已有日志快照。详情仅保存在当前标签页的会话内，缓存不可用时明确提示，不从不存在的日志详情接口补取。

“精确定位”支持秒数或原始采样点序号（从0开始）；上一/下一原采样点会暂停。定位预览、控制接受与已呈现时间分别显示。阶段摘要位于曲线下方，“全部阶段与来源”展开只读详情。关闭会话需确认；取消确认不会改变回放。健康详情区分 Worker 未运行与未知状态，缺少的资源指标显示“—”。

真实模式前端上传上限默认 64MiB，可通过 `VITE_MAX_UPLOAD_BYTES` 设置；最终仍以服务端校验为准。Mock 固定为 1MiB。

用 `API_PROXY_TARGET=http://127.0.0.1:18000` 调整开发代理目标；`VITE_API_BASE_URL` 调整 API 基址。切换模式后重启 Vite 并刷新页面。构建模式同样在构建时确定：真实构建使用 `VITE_USE_MOCK=false npm run build`。`API_PROXY_TARGET` 由启动进程环境读取，需通过shell显式设置，不能只写入未source的.env.local。

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

T15 的合成日志验证见 [T15 记录](docs/validation/t15-status.md)。T16 已完成两份离线、live 与 Rim 的本地核对和真实 SDK/UI 回放；用户授权的夹爪/底盘假设仍为暂定，已下载原件保持只读，精确资料到达后以新 profile 重新生成。完整 MCAP 与实物精确标定尚未完成；T17 本地长测和故障矩阵已独立验收。
