# T05 前端基础与完整 Mock 验证

日期：2026-10-23。该轮验证的是合成帧与 Mock API/WS 驱动的前端，不包含真实 H.264、WHEP 或 IsaacSim 渲染。

## 范围

- Vue 3.5 / TypeScript strict / Vite 6 / Pinia / Naive UI / MSW 2；ECharts 5 依赖已初始化。
- 完整 18 REST Mock 和原生 WebSocket Mock，包括启动相位、上传结果、控制、帧快照、健康、告警、心跳、速率设置与重连全快照。
- session、playback、telemetry、ui stores 分开；只有成功绘制的配对状态能更新当前显示。
- 图片先生成 ImageBitmap，再从实际像素读取完整 uint32 ID 和 CRC32；独立 WS 数据抵达后精确匹配，同 canvas 呈现。
- 4 个在途图像转换、32 个迟到图像、每侧 48 个配对缓存上限；断开时清理资源，过期异步回调不能覆盖新连接。
- `VITE_USE_MOCK=false` 使用真实 API/WS，当前后端 503 如实展示，不回退到合成画面。

## 已验证

124 项单元测试、类型检查与构建通过；11 个真实 Chrome 用例通过，共 144 次独立画布采样。健康运动窗口约 7.67 秒内完成 153 次呈现，约 19.95fps；捕获至测试采样的最大延迟约 80ms（包含采样和测试读回开销）。

最终命令与数值见同目录 [t05-evidence.json](t05-evidence.json)。单元测试、类型检查、生产构建、浏览器 E2E 均有独立结果；浏览器使用临时上下文及本机 Chrome，不加载个人浏览器 profile。

浏览器 oracle 不导入生产 stamp、renderer、runtime 或 store。它原子读取已呈现快照与实际画布，独立计算 ID/CRC，校验合成数值，比较可见日志时间、轮角及六个关节数值的文字像素、进度条，并检查运动/暂停时机器人区域的像素变化。

健康播放的短窗口另测 canvas 呈现帧率和共同延迟；它不代表真实 IsaacSim 接入后仍有相同性能，也不是 30 分钟稳定性验收。650ms 的图像或数据迟到场景单独记录。

第一次浏览器测试的失败被保留在 `outputs/t05/e2e-first`。已修复并回归：关闭/重建时重复增加连接代次导致第二会话空白；拒绝的旧状态仍改变日志配对屏障；重连误清零会话采集序号下界。另补充 Vue scope 释放和初始化期间取消按钮限制。

接入过程中也修正了 T04 类型生成：JSON Schema prefixItems 正确生成数值坐标元组；REST/WS 对默认字段的可选性一致。原始 JSON Schema 不变，TypeScript 和运行时 Schema 继续来自同一 Python 定义。

## 后续边界

工作台已经具备基础操作入口，但不把 T06/T07 全部标为完成：完整映射交互、时间轴拖动策略、关节折叠面板、历史曲线和事件过滤/跳转仍待继续。Mock 中的上传不会真正解析真机日志；P2 服务端业务、T15 媒体联调与 T16 真机数据验收未完成。

本机截图位于 `outputs/t05/workbench.png`，原始浏览器观察、截图和失败 trace 在 `output/test-results`。这些是运行产物，不纳入源码 Git；重新运行 E2E 可重建。
