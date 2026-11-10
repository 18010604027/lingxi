# 语音输出

这个独立包按句并发准备完整 WAV，按请求和句子顺序播放。它尚未接入桌宠；音频渲染由宿主实现 `AudioPlayer`。本包不分发模型、参考音频或角色声音资源。

## 接口与状态

`VoiceQueue` 接收 `SpeechBackend`、`AudioPlayer`、`OutputDevices`。`enqueue(text)` 返回 `SpeechHandle`：`done`、`state`、`confirm(challengeId)`、`interrupt()`。`done` 始终返回 `completed / interrupted / failed` 及已播回执，不通过未处理的 Promise 拒绝向前台报错。

状态为 `queued → confirmation-required（需要时）→ synthesizing → playing → finished`。多句在合成与播放之间循环。默认预取两句，后一句先合成完也必须等前一句播完。下一请求在当前请求结束后才开始合成，避免取消请求积压服务器队列。

分句使用 `Intl.Segmenter`，保留原文及分隔符；超过 2000 个 Unicode 码点的段再按上限拆开。字符位置统一按 Unicode 码点计数，不是 UTF-16 单元或汉字字数。换行、emoji、空白段和长句不改变回执对应的原文前缀。

`interrupt()` 取消当前请求未播放的客户端合成工作，并等待 `Playback.stop()` 确认停止后返回回执。取消排队请求立即完成；合成失败或超时结束该请求，后面的请求继续。`stop()` 停止整个队列。

## 已说出口的回执

`HeardReceipt` 含完整播完的句数、当前句的零基序号、实际渲染毫秒数、当前句已确认的码点数及原文前缀。

- 有可信 `SpeechMark` 时，只计入其结束时间不晚于已渲染位置的字符。
- 没有逐字对齐且当前句播过一部分时，`partialCharacters` 为 `null`。`confirmedText` 只保留完整播完的句子；`playedMs` 保留部分播放事实。
- 本项目使用的语音服务没有逐字对齐。本模块不按音频时长线性猜字数，不能承诺该后端的中途逐字精度。前台应知道回执是保守前缀，可能还有一段已听见但无法定位的当前句。
- 播放器必须提供实际已渲染位置；不能把已排入音频缓冲或经过的墙钟时间算作已听见。停止失败会返回失败回执，不声称已停声。

## 输出设备守门

自动放行只认 Windows `EndpointFormFactor.Headphones = 3` 和 `Headset = 5`。其他形态、缺失属性、HDMI、扬声器、名称含“耳机”但形态未知的设备都需要当次确认。没有可绑定的输出端点则不播放。

一次确认只授权一次 `enqueue` 请求内的句子，不授权下一请求。确认挑战同时绑定请求、端点 ID、设备修订号和本模块的变更代数；用过即失效。A→B→A 也使旧确认失效。合成后、每句播放前再次检查设备。设备变化会打断当前请求，取消其余句子，之后的请求重新守门。

前台只能在用户专门确认当前挑战后调用 `handle.confirm(handle.state.challenge.id)`，不能自动确认、缓存“总是允许”或复用旧挑战。拒绝时调用 `interrupt()`，前台照常显示文字。

`AudioPlayer.start` 必须绑定传入的端点 ID。端点失效时停止，不能跟随默认设备迁移；否则耳机拔出到事件送达之间仍可能漏到外放。此契约必须在宿主真正的 WASAPI 播放器上验收，本包的假播放器测试不证明真实硬件行为。

“默认输出是耳机”不能证明用户物理戴着它，也不能证明驱动的形态标注准确。设备名和蓝牙连接本身不足以确定耳机，蓝牙音箱也可能连接。用户要求的耳机规则在此按可确认的输出路由实现。

### Windows 判断依据与实现

Windows 设备探测使用 Microsoft Core Audio：

- [PKEY_AudioEndpoint_FormFactor](https://learn.microsoft.com/en-us/windows/win32/coreaudio/pkey-audioendpoint-formfactor) 指出该属性的 `PROPVARIANT` 类型为 `VT_UI4`。
- [EndpointFormFactor](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/ne-mmdeviceapi-endpointformfactor) 区分耳机、带麦耳机、扬声器及其他物理形态。有线与蓝牙耳机只要驱动提供相同形态，都按此识别。
- [IMMNotificationClient](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nn-mmdeviceapi-immnotificationclient) 提供默认端点、状态和属性变化通知；端点 ID 是不透明标识，不解析其格式或名称。

`WindowsOutputDevices.start()` 启动本包隐藏的 PowerShell 辅助进程，通过 COM 查询默认 `eRender/eConsole` 端点，只读属性；原生通知增加修订号，Node 订阅变化。通知回调只增加计数，COM 查询在回调外进行。辅助进程失败或启动超时后端点不可用。`stop()` 只停止本包创建的辅助进程。

设备未提供可识别的形态时按未知处理，需要确认。实际播放器的耳机插拔、端点绑定和停止行为需要由集成方验证。

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File packages/voice-out/native/output-endpoints.ps1 -Once
```

## HTTP 后端

`FeiyuBackend({baseUrl, apiKey, voice?, style?, fetch?})` 实现提交 `/v1/speech`、轮询 `/v1/jobs/{id}`、成功后下载该 ID 的 `/audio`。状态只接受 `queued/running/success/failed/interrupted`。不跟随服务返回的任意音频地址，不跟随 HTTP 重定向，不自动重试提交。

它校验 RIFF/WAVE 与块边界、限制下载大小，并区分请求超时和任务等待上限。任务取消仅终止客户端等待或下载；当前服务没有单任务取消接口，服务器可能继续推理已经提交的预取句子。

协议固定依据为 [服务路由](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice/blob/7baff58fdb4c4472a392be94da6dfa9690d96a8b/server/feiyu_voice_service/app.py)、[请求模型](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice/blob/7baff58fdb4c4472a392be94da6dfa9690d96a8b/server/feiyu_voice_service/models.py)、[HTTP 客户端](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice/blob/7baff58fdb4c4472a392be94da6dfa9690d96a8b/client.py)，提交 `7baff58fdb4c4472a392be94da6dfa9690d96a8b`。实现按接口独立编写，没有复制上游客户端源码。

队列默认单句合成上限为 60 秒；后端默认任务上限为 30 分钟、单请求为 30 秒。集成时应根据实测统一这两层预算。没有实测延迟或显存数据，本次未连接真实语音服务。

## 测试与接入

```powershell
npx --no-install vitest run tests/voice-out.test.ts --maxWorkers=1 --minWorkers=1
npx --no-install tsc -p packages/voice-out/tsconfig.json --noEmit
```

测试仅用假合成器、假播放器、假设备和注入的 HTTP 传输，不连接本机服务。覆盖乱序合成、顺序播放、排队取消、停止回执、无对齐时间戳、合成失败、服务不可用、任务超时、一次性确认、设备变化及未知设备。

宿主接入时需要实现实际端点绑定、停止与渲染进度，并展示确认请求。未来若加入逐字对齐，应通过 `SpeechMark` 提供证据，而不是改变已有回执的“未知”语义。
