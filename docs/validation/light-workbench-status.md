# 浅色回放工作台验证记录

2026-11-02。功能分支 `feature/light-replay-workbench`，实现提交 `38843f9`；从配对 v1.0.0（前端1777e42 / 后端e740103）建立。主线和发布标签未改变。本轮只修改前端及其测试/说明；REST、WS、IPC、生成契约、后端实现和依赖锁文件保持不变。

## 已实现

- 浅色无侧栏工作台；顶部环境/当前日志工具条；导入、日志详情与完整阶段来源抽屉；确认关闭、通道选择、精确定位和健康弹层。
- 28关节按上排左右臂与夹爪、下排躯干与底盘显示；1600×920统一画布内呈现真实图像、关节/质量/限位、底盘、日志时间与四条叠放曲线游标。图像区域768×432，历史区1568×336。
- 本次候选与当前激活日志分开保存；详情按会话/日志身份匹配，最多保留8份元数据，保留active与候选。没有新增日志详情API或跨会话日志库。
- 映射先于文件选择；上传成功后显式激活，等待新首帧；同帧文本视图也只使用已呈现快照。推算/缺失、未评估限位、暂定标注与未批准训练等原始含义保留。
- 阶段预览限8项，完整历史继续分页；键盘分组顺序与视觉一致。未知健康指标不补0，Worker false与未知分开。

## 验证

| 检查 | 结果 |
| --- | --- |
| 前端单元测试 | 28文件、276项通过 |
| 类型检查与真实模式构建 | 通过；原有体积/Node提示不作为安全验收 |
| 默认Chrome回归 | 19/19：18 Mock、1无配置真实模式契约检查；新增全局pageerror断言 |
| API/关节元数据导出检查 | 通过；生成API目录对基线无差异，后端工作区干净 |
| 实际SDK合成回放 | 65次同帧/源值核对；健康短窗口19.75065fps，最大采样共同延迟156.661ms；worker故障876ms可见，新会话从零加载；浏览器错误为空 |
| 实际B041回放 | 一份离线与一份live日志；32次同帧核对、11个源行核对点、5个标注核对点；缺口无预测填充；浏览器错误为空 |
| 源数据与清理 | B041检查的27份原件与输入hash不变；两次成功验收自有进程/TCP/UDP均释放；电源始终balanced，没有修改系统电源模式 |
| 独立审查 | 任务审查及整分支审查的修复复核通过，无剩余可执行发现 |

原始输出保存在 `frontend/output/light-workbench/` 和 `backend/outputs/light-workbench/`（Git忽略）。机器摘要及关键证据SHA256见 [light-workbench-evidence.json](light-workbench-evidence.json)。截图为实际运行，不是设计稿。

实际SDK命令从backend目录执行：

```bash
env -u PYTHONPATH -u PYTHONHOME .venv/bin/python scripts/validate_frontend.py \
  --isaac-python /home/xq/work/code/projects/r1pro/.venvs/isaacsim62/bin/python \
  --output-dir outputs/light-workbench/synthetic-02

env -u PYTHONPATH -u PYTHONHOME .venv/bin/python scripts/validate_b041_frontend.py \
  --isaac-python /home/xq/work/code/projects/r1pro/.venvs/isaacsim62/bin/python \
  --offline-bundle data/real_logs/derived/RBA60725B041_20261016100605618_RAW/b041_ee2_body_velocity_v1/recording.b041 \
  --runtime-bundle data/real_logs/derived/live_run_20261023T123221109918Z/b041_ee2_body_velocity_v1/recording.b041 \
  --profile data/real_logs/derived/RBA60725B041_20261016100605618_RAW/b041_ee2_body_velocity_v1/mapping.json \
  --output-dir outputs/light-workbench/b041-01
```

重新执行需更换为不存在的输出目录；SDK Python保持venv入口，不解析成基础Python路径。浏览器使用系统Chrome，保留现有15fps/2s门槛和数值/像素断言。

## 已修复的问题与保留范围

首次实际SDK检查在定位输入发现Vue数字v-model导致`.trim()`类型错误；该次`synthetic-01`按失败保存。修复后对有效秒数/帧、非法帧、Enter以及页面错误增加回归，再运行`synthetic-02`通过。第一次默认浏览器全量运行还出现Vite监听累积测试输出导致ENOSPC；只排除生成的`output/**`监听，未删除证据或修改系统限制，19项重新通过。

本轮没有重做T17的30分钟持续运行或无损录屏矩阵，也没有逐条GPU验收153条日志。实际B041选择live来源，未额外重跑Rim参考来源案例；相关原有单位测试和只读语义保留。Firefox、窄窗口/移动端不在本次验收声明中。既有依赖公告、夹爪/底盘暂定假设和本机单会话范围不变。
