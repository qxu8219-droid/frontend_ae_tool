# T15 正式前端同步联调 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this approved continuation inline. Steps use checkbox syntax. One final independent review; no implementer delegation.

**Goal:** 正式工作台使用真实 REST/WS/WHEP，把实际图像与同帧数据一次绘制到同一 canvas。

**Architecture:** 复用已有 Vue/Pinia 工作台及 FrameSynchronizer。WHEP receiver 的 encoded transform 在 Worker 内解析正式 SEI，并用 WebCodecs 解码；实际像素 ID/CRC 选择本 access unit 目录中的唯一快照，作为不可分割的 frame/snapshot 交给呈现门槛。WS 恢复元数据和控制屏障，不能用最新 WS 值覆盖视频快照。

**Tech Stack:** 既有 Vue3/TS5.9/Vite6/Vitest/Playwright；原生 WebRTC、WebCodecs、OffscreenCanvas。无新依赖。

**Spec:** ../../../.trae/documents/robot-log-replay-platform-todolist.md T15；原计划同目录 robot-log-replay-platform-plan.md 顶部最新裁定；../backend/docs/runtime-api-v1.md。

## Global Constraints

- 固定 SDK6.2/PhysX 与既有资产，保留两仓 feature/p1-contracts；本轮不访问远端，不回放标定未确认的真机数据。
- 严格同帧，可共同延迟；健康目标>=15fps/<2s。故障后新sid从头加载。不同层的帧率/身份/呈现证据分别记录。
- 保留既有 Mock/契约模式；真实模式不得生成替代图像。保持界面布局，实时值只来自共同呈现快照。
- 采用正式 video.sei_uuid_hex/schema1/capture32_crc32；不接受 P0 UUID。目录最多16，SEI JSON<=256KiB，AU<=4MiB；异常/缺目录/解码链中断等待新IDR。
- 解码排队最多4、待解码关联最多8、主线程在途VideoFrame最多4；2秒过期，代次更换释放所有持有资源。
- 每个WHEP会话拥有PC/Worker/DELETE资源URL；重复完整WS快照不是新连接；生命周期token隔离迟到协商/图像。
- 本轮沿用已批准设计与持续开发授权，writing-plans仅细化实现，无需重复询问路线或审批。

## Review Focus

- 同一WS连接重复完整快照、媒体就绪改变不能导致反复WHEP重建；真正断线后必须清理并重新配对。
- 用户连续控制时旧请求ack和在途图像不得越过最新操作意图；错误/断线不能把等待区伪装成新帧。
- 伪造/截断SEI、重复capture、过期目录、旧decoder回调、错误UUID必须拒绝；不能使用encoder_poll_capture_id选帧。
- WHEP协商取消后迟到201仍须删除资源；PC失败、worker退出和主线程背压必须有界释放VideoFrame。
- 历史查询/候选告警与当前呈现不同步到达时，不能改变当前图像、进度或曲线游标；证据要读取实际canvas像素/文本。

## Task 1: 正式 SEI、解码与像素选择

Files: src/media/h264.ts, catalog.ts, decoder.ts, receiver.worker.ts; tests/media/h264.test.ts, decoder.test.ts; src/api/validation.ts。

Interfaces: extractAccessUnit(bytes,uuid) -> {annexB,codec,keyframe,catalog}; validateCatalog(value) -> FrameCatalog; selectSnapshot(catalog,samples,sid) -> FrameSnapshot; DecoderPipeline.push(bytes)/release(id)/close()，注入解码器和像素读取用于边界测试。

- [ ] RED：AnnexB/AVCC/NAL、转义/截断/重复UUID、正式目录语义；像素CRC决定帧且忽略poll；解码器旧回调、缺元数据后IDR恢复、背压/过期/关闭。
- [ ] GREEN：纯解析与正式Schema校验；有界AU关联及VideoFrame所有权，worker只转交已验证配对。
- [ ] `npm test -- tests/media/h264.test.ts tests/media/decoder.test.ts` 预期全部PASS；`npm run typecheck` PASS；提交独立媒体核心。

## Task 2: 真实 WHEP 视频源

Files: src/media/whep.ts, types.ts; src/composables/useVideoSource.ts; tests/media/whep.test.ts; vite.config.ts。

Interfaces: VideoSource.connect(sid,onFrame,onStatus,video?) 幂等更新端点；DecodedFrame携带可选已验证snapshot/markerPixels；disconnect同步失效本代资源，异步有界DELETE；diagnostics只读。

- [ ] RED：未publishing不连接、同端点重复快照不重启、换sid/url、协商取消迟到资源清理、错误来源、worker迟到帧close、连接失败有限重试、不支持浏览器明确提示。
- [ ] GREEN：原生PC/Worker和WHEP非trickle握手（ICE5s、POST8s、DELETE3s）；同源资源URL验证；丢失恢复保持旧呈现；development/preview跨源隔离headers。
- [ ] `npm test -- tests/media/whep.test.ts tests/media/composable.test.ts` PASS；构建PASS；提交。

## Task 3: 工作台状态、控制与共同呈现

Files: src/api/socket.ts; src/app/controller.ts; src/media/frameSync.ts,renderer.ts; src/stores/session.ts; src/App.vue; 对应tests/api/socket、tests/stores/controller、tests/media/frameSync。

Interfaces: FrameSynchronizer.setSuspended(boolean) 清除待呈现帧、保留同sid捕获水位；controller消费real paired frame，Mock仍消费独立WS；diagnostics.layout返回已呈现源几何。

- [ ] RED：同connection连续seq完整快照合法；重复快照不重启媒体；stalled/错误/WS重连时共同保持；本地最新控制意图在ack前冻结，迟到旧ack不解除；同代次告警保留且旧代次丢弃。
- [ ] GREEN：更新媒体配置、控制屏障、来源标识和已接受/已应用/已呈现状态；保留Mock测试及既有界面。
- [ ] 全部前端单测、build、14项既有Chrome回归PASS；提交。

## Task 4: 实际工作台集成、证据与审查

Files: e2e/real-replay.spec.ts、独立playwright真实运行配置/诊断oracle；backend/scripts/validate_frontend.py（本次拥有的实际服务/SDK）；运行说明、验证记录、开发清单。

- [ ] 使用正式UI创建、上传合成CSV、核对映射后激活；真实页面操作play/0.1x/10x/pause/seek/连续seek/拖动/前后step/末尾/stop、WS重连、关闭重建。独立读取实际canvas图像ID/CRC、面板文本、进度/曲线游标，并以原CSV作值oracle。
- [ ] 浏览器实际画面观察、健康移动窗口帧率和共同延迟；记录WS/媒体/worker故障及首帧重载。资源清理，不终止已有服务。
- [ ] 后端回归、前端单测/build/既有Chrome、正式真实Chrome、Schema一致检查通过；一次最终独立审查与必要RED→GREEN修复；更新进度并提交。
