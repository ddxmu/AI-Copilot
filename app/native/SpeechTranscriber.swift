// AI Copilot 本地离线听写辅助程序（macOS 系统 SFSpeechRecognizer）
//
// 编译（在本文件所在目录执行）：
//   xcrun swiftc -O -o SpeechTranscriber.app/Contents/MacOS/SpeechTranscriber SpeechTranscriber.swift
//   codesign --force --deep --sign - SpeechTranscriber.app
//
// 用法：SpeechTranscriber <wav文件路径> <语言标识，如 zh-CN>
// 输出：单行 JSON —— {"ok":true,"text":"..."} 或 {"ok":false,"error":"..."}
//
// 说明：使用 requiresOnDeviceRecognition = true，音频不上传、不联网、不需要 API Key，
//       也不加载任何第三方语音模型（Vosk / whisper 等）。首次使用会触发系统「语音识别」授权。

import Foundation
import Speech

func emit(_ obj: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let line = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    }
    exit(0)
}

func fail(_ message: String) -> Never { emit(["ok": false, "error": message]) }

let deniedTip = "语音识别权限被拒绝，请在「系统设置 › 隐私与安全性 › 语音识别」中允许 AI Copilot 后重试"

let args = CommandLine.arguments
guard args.count >= 2 else { fail("缺少音频文件路径"); }
let audioPath = args[1]
let lang = (args.count >= 3 && !args[2].isEmpty) ? args[2] : "zh-CN"
guard FileManager.default.fileExists(atPath: audioPath) else { fail("音频文件不存在"); }

func recognize() {
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)) else {
        fail("系统不支持该识别语言：\(lang)")
        return
    }
    guard recognizer.supportsOnDeviceRecognition else {
        fail("系统尚未安装 \(lang) 的离线听写资源，请改用远程识别")
        return
    }
    let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: audioPath))
    request.requiresOnDeviceRecognition = true
    request.taskHint = .dictation
    if #available(macOS 13.0, *) { request.addsPunctuation = true }
    var finished = false
    recognizer.recognitionTask(with: request) { result, error in
        if finished { return }
        if let error = error {
            finished = true
            fail("识别失败：\(error.localizedDescription)")
        }
        if let result = result, result.isFinal {
            finished = true
            emit(["ok": true, "text": result.bestTranscription.formattedString])
        }
    }
}

switch SFSpeechRecognizer.authorizationStatus() {
case .authorized:
    recognize()
case .notDetermined:
    SFSpeechRecognizer.requestAuthorization { status in
        if status == .authorized { recognize() } else { fail(deniedTip) }
    }
case .denied, .restricted:
    fail(deniedTip)
@unknown default:
    fail("语音识别权限状态未知，请重试")
}

dispatchMain()
