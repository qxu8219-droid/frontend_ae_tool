# T15 真实回放工作台

工作台已接入配置后的后端与 Isaac Sim 6.2 视频。保留原有界面：创建会话、上传并核对结果、激活日志，再操作播放、倍速、暂停、定位、单步和停止。上传本身不改变正在回放的日志。

## 本机启动

后端终端（先完成 backend README 中的隔离环境、资产、MediaMTX 和回环绑定库准备）：

```bash
cd /home/xq/work/code/projects/Model_Evaluation/backend
ISAACSIM_PYTHON=/home/xq/work/code/projects/r1pro/.venvs/isaacsim62/bin/python \
  bash scripts/run_backend.sh
```

前端终端：

```bash
cd /home/xq/work/code/projects/Model_Evaluation/frontend
VITE_USE_MOCK=false npm run dev
```

打开 `http://127.0.0.1:5173`。默认代理 `/api`、`/ws` 到 `127.0.0.1:8000`；其他端口使用 `API_PROXY_TARGET`。如果使用不同前端端口，后端 `REPLAY_ALLOWED_ORIGINS` 必须包含它，媒体网关也使用该来源配置。后端必须使用 `run_backend.sh` 的实际 factory；直接启动默认 `app.main:app` 仍返回 503，用于契约边界测试。

真实模式默认上传上限 64MiB。数据格式和映射见 [后端导入说明](../../backend/docs/log-import-v1.md)，会话和端口配置见 [后端运行说明](../../backend/docs/runtime-api-v1.md)。真机原件位于后端 `data/real_logs/raw/`；尚未确认的夹爪与底盘标定不能由界面猜测。

本机使用系统 Chrome。媒体需要 WebCodecs、OffscreenCanvas 和 WebRTC 编码变换（RTCRtpScriptTransform 或 createEncodedStreams）；不满足能力时明确提示，不生成替代画面。Vite 开发和 preview 已设置 COOP/COEP；其他静态托管应保留同样的跨源隔离响应头和正确的媒体 CORS。非 localhost 场景需要浏览器安全上下文，正式远程部署留给后续交付。

## 画面为什么与数据对应

1. WHEP receiver 的编码变换把每个 H.264 access unit 送入独立 Worker；只解析后端宣告的正式 SEI UUID。
2. WebCodecs 解码该 access unit；Worker 从解码图像读取完整 32 位 capture ID 和 CRC，再从该 access unit 的最多 16 个快照候选中选择唯一同帧快照。
3. 经过核验的 VideoFrame 与对应冻结快照一起交给工作台；控制代次、日志和会话屏障拒绝旧内容。
4. 图像、28 关节、底盘、来源/质量/限位、日志进度及曲线游标在同一 canvas 中绘制。WS 最新姿态不参与真实图像配对，也不能替换 SEI 的对应数据。

目录中的 `encoder_poll_capture_id` 只是编码诊断，不用于选帧。截图顶部的红绿色块用于图像身份核验。显示的“上一帧共同延迟”是该次呈现时刻减去捕获时间；本机时钟条件下有意义，不自动代表异地主机的绝对时延。

控制响应分别代表“正在提交”“已接受”“仿真已应用/渲染”和“已呈现”。本地新操作立即保持当前画面，只有最新等待操作的响应到达且新图像通过屏障，才更新同步区域。服务器接受定位不会直接改变画布进度。

历史曲线和预扫描事件来自原日志查询，可以包含尚未播放的区间；它们不代表当前画面已触发告警。当前帧的曲线游标和“本轮播放已触发”事件按实际呈现时间释放。

## 重同步与资源所有权

- 同一 WS 连接可以连续收到完整 `connection_snapshot`；连续 seq 与 connection_id 仍严格校验。同端点元数据刷新不重建 WHEP。
- 真正 WS 重连、媒体端点变化、网关中断会释放旧媒体连接，保留最后一次完整呈现。新会话清空旧画布；worker 故障需要关闭、重新创建并从起点加载。
- WHEP 最多自动重试 5 次，间隔从 0.5 秒增长至 8 秒；连续失败后可关闭并重新创建会话。每次连接拥有 PC、Worker 和服务端 resource URL，退出时释放本代资源。
- ICE 等待上限 5 秒、POST 8 秒、DELETE 3 秒。取消期间已发出的 POST 在期限内完成，以便删除迟到 201 返回的资源；外来来源的 Location 不被跟随。
- access unit 上限 4MiB、SEI JSON 上限 256KiB，目录最多 16 帧；解码队列上限 4、待输出关联上限 8、已转交主线程但尚未关闭的 VideoFrame 上限 4。待解码关联过期 2 秒。主线程消费后显式归还所有权。
- 缺少对应目录、错误 CRC、旧解码器回调或损坏解码链不会呈现替代数据。解码链不完整时等待新的 IDR；主线程消费变慢时可以少显示帧，不能积压无界图像。

上述容量和保守丢帧属于实施选择：代价是异常期间可能降低显示帧率或等待下一关键帧。既有 48 帧共同呈现缓存保留给 Mock 的独立图像/数据到达路径，真实解码器另外执行更小的资源上限。

## 验证与诊断

```bash
# frontend：CPU/Mock/无配置服务边界
npm test
npm run build
npm run test:e2e

# backend：本次拥有的实际 API、SDK、Vite 与 Chrome
env -u PYTHONPATH -u PYTHONHOME .venv/bin/python scripts/validate_frontend.py \
  --output-dir outputs/t15/my-new-validation \
  --isaac-python /home/xq/work/code/projects/r1pro/.venvs/isaacsim62/bin/python
```

输出目录必须不存在。真实验证使用 12 秒、241 样本、28 关节＋底盘的合成 command CSV；不访问机器人、不修改远端。脚本保存画面和浏览器证据，并清理本次服务。原有开发服务不会被复用或终止。

只读 `window.__replayDiagnostics` 可查看呈现快照、实际源图像几何、缓存容量和资源计数。验收不是只比较两个诊断变量：独立测试从实际 canvas 读取图像 ID/CRC，比较可见时间、关节、底盘文字像素、进度条和曲线游标，并用保存的原 CSV 计算数值对照。详情见 [T15 验证记录](validation/t15-status.md)。

实现沿用批准路线，未扩展前端三维渲染，也未改变既有 Mock 演示；完整网络故障矩阵和长期性能属于 T17，真机适配与标定属于 T16。
