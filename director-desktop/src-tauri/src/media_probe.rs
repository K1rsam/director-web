//! Local container metadata only; successful probing does not certify decoded picture/sound quality.
//! Call on a blocking worker. No media is changed, no duration is guessed, and network protocols are disabled.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::OsString,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const TOTAL_TIMEOUT: Duration = Duration::from_secs(60);
const ENTRIES: &str = "format=duration,format_name,nb_streams,size:stream=index,codec_type,codec_name,width,height,duration,duration_ts,time_base,start_time,sample_rate,channels,r_frame_rate,avg_frame_rate:stream_disposition=default,attached_pic:stream_side_data=rotation";

#[derive(Clone)]
struct ToolIdentity {
    version: String,
    sha256: String,
}
type IdentityCache = HashMap<(PathBuf, u64, Option<SystemTime>), ToolIdentity>;
static IDENTITIES: OnceLock<Mutex<IdentityCache>> = OnceLock::new();
static CLOSING: AtomicBool = AtomicBool::new(false);
static ACTIVE_PROBES: AtomicUsize = AtomicUsize::new(0);
struct ProbeGuard;
impl Drop for ProbeGuard {
    fn drop(&mut self) {
        ACTIVE_PROBES.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Closing the desktop stops local probing as well as generation adapters.
pub fn shutdown() {
    CLOSING.store(true, Ordering::SeqCst);
}
pub fn await_local_shutdown(timeout_seconds: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    while ACTIVE_PROBES.load(Ordering::SeqCst) > 0 {
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
    true
}

/// `ffprobePath`, when set, must be absolute. Otherwise use a bundled binary, then an absolute PATH entry.
/// Pure audio returns null dimensions. Errors leave the original media file untouched.
pub fn probe(path: &Path, settings: &Value) -> Result<Value, String> {
    ACTIVE_PROBES.fetch_add(1, Ordering::SeqCst);
    let _guard = ProbeGuard;
    if CLOSING.load(Ordering::SeqCst) {
        return Err("客户端正在关闭，媒体探测已停止；原文件已保留".into());
    }
    let started = Instant::now();
    if !path.is_absolute() {
        return Err("媒体探测需要绝对文件路径".into());
    }
    let before = fs::symlink_metadata(path).map_err(|e| format!("无法读取媒体文件: {e}"))?;
    if !before.file_type().is_file() || before.len() == 0 {
        return Err("媒体必须是非空的本地普通文件，不能是符号链接或目录".into());
    }
    let executable = resolve_tool(settings)?;
    let identity = identify_tool(&executable, started)?;
    let mut args: Vec<OsString> = [
        "-v",
        "error",
        "-hide_banner",
        "-protocol_whitelist",
        "file",
        "-show_error",
        "-show_entries",
        ENTRIES,
        "-of",
        "json",
        "-i",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    args.push(path.as_os_str().to_owned());
    let (output, stderr) = run(&executable, &args, remaining(started)?)?;
    let document: Value = serde_json::from_slice(&output)
        .map_err(|e| format!("ffprobe 没有返回有效的媒体 JSON: {e}"))?;
    if document.get("error").is_some() {
        return Err(format!("媒体容器读取失败: {}", short_error(&stderr)));
    }
    let mut metadata = interpret(&document)?;
    let after = fs::symlink_metadata(path).map_err(|e| format!("探测后无法读取媒体文件: {e}"))?;
    if !after.file_type().is_file()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("媒体文件在探测期间发生变化，请重新导入".into());
    }
    metadata["metadataVerified"] = json!(true);
    metadata["metadataSource"] = json!("ffprobe-container");
    metadata["metadataProbe"] = json!({"path": executable, "version": identity.version, "sha256": identity.sha256, "probedAt": chrono::Utc::now().to_rfc3339()});
    Ok(metadata)
}

fn resolve_tool(settings: &Value) -> Result<PathBuf, String> {
    if let Some(value) = settings.get("ffprobePath") {
        if !value.is_null() {
            let configured = value
                .as_str()
                .ok_or("ffprobePath 必须是文件路径字符串")?
                .trim();
            if !configured.is_empty() {
                let path = PathBuf::from(configured);
                if !path.is_absolute() {
                    return Err("ffprobePath 必须是绝对路径".into());
                }
                return usable_tool(&path);
            }
        }
    }
    let name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    let mut bundled = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            bundled.push(parent.join("tools/ffprobe").join(name));
            bundled.push(parent.join("resources/tools/ffprobe").join(name));
            #[cfg(target_os = "macos")]
            if let Some(contents) = parent.parent() {
                bundled.push(contents.join("Resources/tools/ffprobe").join(name));
            }
        }
    }
    #[cfg(debug_assertions)]
    if let Some(root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        bundled.push(root.join("tools/ffprobe").join(name));
    }
    for path in bundled {
        if path.exists() {
            return usable_tool(&path);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for folder in std::env::split_paths(&paths) {
            if folder.is_absolute() {
                let path = folder.join(name);
                if path.is_file() {
                    return usable_tool(&path);
                }
            }
        }
    }
    Err("未找到 ffprobe。请配置 ffprobePath，或运行 scripts/setup-media-tools.ps1 安装独立媒体工具；原文件已保留".into())
}

fn usable_tool(path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path).map_err(|e| format!("无法读取 ffprobe: {e}"))?;
    let metadata = fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 256 * 1024 * 1024 {
        return Err("ffprobe 必须是有效的本地可执行文件".into());
    }
    #[cfg(windows)]
    if !canonical
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return Err("Windows ffprobePath 必须指定 .exe，不能指定脚本".into());
    }
    Ok(canonical)
}

fn remaining(started: Instant) -> Result<Duration, String> {
    if CLOSING.load(Ordering::SeqCst) {
        return Err("客户端正在关闭，媒体探测已停止；原文件已保留".into());
    }
    TOTAL_TIMEOUT
        .checked_sub(started.elapsed())
        .filter(|v| !v.is_zero())
        .ok_or("媒体探测超过 60 秒，已停止；原文件已保留".into())
}

fn identify_tool(path: &Path, started: Instant) -> Result<ToolIdentity, String> {
    let before = fs::metadata(path).map_err(|e| e.to_string())?;
    let key = (path.to_path_buf(), before.len(), before.modified().ok());
    let cache = IDENTITIES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(identity) = cache
        .lock()
        .map_err(|_| "媒体工具缓存不可用")?
        .get(&key)
        .cloned()
    {
        return Ok(identity);
    }
    let (output, _) = run(
        path,
        &[OsString::from("-version")],
        remaining(started)?.min(Duration::from_secs(10)),
    )?;
    let version = String::from_utf8_lossy(&output)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_owned();
    if !version.starts_with("ffprobe version ") {
        return Err("指定程序没有返回 ffprobe 版本，不能用于媒体验收".into());
    }
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        remaining(started)?;
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let after = fs::metadata(path).map_err(|e| e.to_string())?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err("ffprobe 在核验期间发生变化".into());
    }
    let identity = ToolIdentity {
        version,
        sha256: format!("{:x}", digest.finalize()),
    };
    let mut entries = cache.lock().map_err(|_| "媒体工具缓存不可用")?;
    if entries.len() >= 16 {
        entries.clear();
    }
    entries.insert(key, identity.clone());
    Ok(identity)
}

fn read_pipe<R: Read + Send + 'static>(
    mut pipe: R,
    overflow: Arc<AtomicBool>,
) -> mpsc::Receiver<Result<Vec<u8>, String>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut result = Vec::new();
        let outcome = pipe
            .by_ref()
            .take((OUTPUT_LIMIT + 1) as u64)
            .read_to_end(&mut result);
        let value = match outcome {
            Err(error) => Err(error.to_string()),
            Ok(_) if result.len() > OUTPUT_LIMIT => {
                overflow.store(true, Ordering::SeqCst);
                Err("ffprobe 输出超过安全上限".into())
            }
            Ok(_) => Ok(result),
        };
        let _ = sender.send(value);
    });
    receiver
}

fn run(
    executable: &Path,
    args: &[OsString],
    timeout: Duration,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    if CLOSING.load(Ordering::SeqCst) {
        return Err("客户端正在关闭，媒体探测已停止".into());
    }
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("FFREPORT")
        .env("AV_LOG_FORCE_NOCOLOR", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 ffprobe: {e}"))?;
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = read_pipe(
        child.stdout.take().ok_or("无法读取 ffprobe 输出")?,
        overflow.clone(),
    );
    let stderr = read_pipe(
        child.stderr.take().ok_or("无法读取 ffprobe 错误")?,
        overflow.clone(),
    );
    let started = Instant::now();
    let status = loop {
        if started.elapsed() >= timeout
            || overflow.load(Ordering::SeqCst)
            || CLOSING.load(Ordering::SeqCst)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(if CLOSING.load(Ordering::SeqCst) {
                "客户端正在关闭，已停止 ffprobe；原文件已保留".into()
            } else if overflow.load(Ordering::SeqCst) {
                "ffprobe 输出超过安全上限".into()
            } else {
                "媒体探测超时，已停止 ffprobe；原文件已保留".into()
            });
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("ffprobe 状态读取失败: {error}"));
            }
        }
    };
    let stdout = stdout
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "ffprobe 输出读取未完成")??;
    let stderr = stderr
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "ffprobe 错误读取未完成")??;
    if !status.success() {
        return Err(format!("ffprobe 不能读取该媒体: {}", short_error(&stderr)));
    }
    Ok((stdout, stderr))
}

fn short_error(output: &[u8]) -> String {
    String::from_utf8_lossy(output)
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(1000)
        .collect::<String>()
        .trim()
        .to_owned()
}
fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|v| v.parse().ok()))
        .filter(|v| v.is_finite())
}
fn positive(value: &Value) -> Option<f64> {
    number(value).filter(|v| *v > 0.0)
}
fn rational(value: &Value) -> Option<f64> {
    let (numerator, denominator) = value.as_str()?.split_once('/')?;
    let numerator: f64 = numerator.parse().ok()?;
    let denominator: f64 = denominator.parse().ok()?;
    if !numerator.is_finite() || !denominator.is_finite() || denominator == 0.0 {
        return None;
    }
    Some(numerator / denominator).filter(|v| v.is_finite())
}
fn stream_duration(stream: &Value) -> Option<f64> {
    positive(&stream["duration"]).or_else(|| {
        let duration = positive(&stream["duration_ts"])? * rational(&stream["time_base"])?;
        if duration.is_finite() && duration > 0.0 {
            Some(duration)
        } else {
            None
        }
    })
}
fn dimension(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .filter(|v| *v > 0 && *v <= u32::MAX as u64)
        .map(|v| v as u32)
}
fn is_motion_video(stream: &Value) -> bool {
    stream["codec_type"] == "video" && stream["disposition"]["attached_pic"].as_u64() != Some(1)
}

fn interpret(document: &Value) -> Result<Value, String> {
    let raw = document["streams"]
        .as_array()
        .ok_or("ffprobe 没有返回媒体流")?;
    let audiovisual: Vec<&Value> = raw
        .iter()
        .filter(|v| v["codec_type"] == "audio" || is_motion_video(v))
        .collect();
    if audiovisual.is_empty() {
        return Err("文件中没有可用的音频或运动视频流".into());
    }
    let (duration, source) = if let Some(duration) = positive(&document["format"]["duration"]) {
        (duration, "container")
    } else {
        // Missing streams or unknown offsets must not silently shorten the material.
        if audiovisual.iter().any(|v| stream_duration(v).is_none()) {
            return Err("存在时长未知的音视频流，不能确认完整媒体时长；原文件已保留".into());
        }
        let duration = if audiovisual.len() == 1 {
            stream_duration(audiovisual[0]).ok_or("媒体未提供可靠时长；原文件已保留")?
        } else {
            let spans: Vec<(f64, f64)> = audiovisual
                .iter()
                .map(|v| {
                    let start = number(&v["start_time"])
                        .ok_or("多流媒体缺少开始时间，不能确认完整时长；原文件已保留")?;
                    let end = start + stream_duration(v).ok_or("媒体流时长未知")?;
                    if !end.is_finite() {
                        return Err("媒体流结束时间无效");
                    }
                    Ok((start, end))
                })
                .collect::<Result<_, &str>>()?;
            spans.iter().map(|(_, end)| *end).reduce(f64::max).unwrap()
                - spans
                    .iter()
                    .map(|(start, _)| *start)
                    .reduce(f64::min)
                    .unwrap()
        };
        if !duration.is_finite() || duration <= 0.0 {
            return Err("媒体时长无效；原文件已保留".into());
        }
        (duration, "stream")
    };
    let selected_video = audiovisual
        .iter()
        .copied()
        .filter(|v| is_motion_video(v))
        .find(|v| v["disposition"]["default"] == 1)
        .or_else(|| audiovisual.iter().copied().find(|v| is_motion_video(v)));
    let (width, height) = if let Some(video) = selected_video {
        (
            Some(dimension(&video["width"]).ok_or("视频流缺少可靠宽度")?),
            Some(dimension(&video["height"]).ok_or("视频流缺少可靠高度")?),
        )
    } else {
        (None, None)
    };
    let streams: Vec<Value> = raw.iter().map(|stream| {
        let rotation = stream["side_data_list"].as_array().and_then(|items| items.iter().find_map(|v| number(&v["rotation"])));
        json!({"index": stream["index"], "kind": stream["codec_type"], "codec": stream["codec_name"],
            "width": dimension(&stream["width"]), "height": dimension(&stream["height"]), "durationSeconds": stream_duration(stream),
            "startSeconds": number(&stream["start_time"]), "sampleRate": positive(&stream["sample_rate"]), "channels": stream["channels"],
            "frameRate": rational(&stream["avg_frame_rate"]).filter(|v| *v > 0.0), "rotationDegrees": rotation,
            "isDefault": stream["disposition"]["default"] == 1, "attachedPicture": stream["disposition"]["attached_pic"] == 1})
    }).collect();
    Ok(
        json!({"durationSeconds": duration, "durationSource": source, "width": width, "height": height,
        "formatName": document["format"]["format_name"], "streams": streams}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rejects_unknown_duration_and_cover_art_only() {
        let doc = json!({"format":{"duration":"N/A"},"streams":[{"codec_type":"audio","duration":"N/A"}]});
        assert!(interpret(&doc).is_err());
        assert!(interpret(&json!({"format":{"duration":"3"},"streams":[{"codec_type":"video","width":100,"height":100,"disposition":{"attached_pic":1}}]})).is_err());
        assert!(positive(&json!("NaN")).is_none());
        assert!(positive(&json!("Infinity")).is_none());
    }

    #[test]
    fn keeps_audio_dimensions_null_and_exact_stream_timebase() {
        let metadata = interpret(&json!({"format":{"format_name":"wav"},"streams":[{"codec_type":"audio","duration_ts":48000,"time_base":"1/48000","sample_rate":"48000","channels":1}]})).unwrap();
        assert_eq!(metadata["durationSeconds"], 1.0);
        assert_eq!(metadata["durationSource"], "stream");
        assert_eq!(metadata["width"], Value::Null);
        assert_eq!(metadata["streams"][0]["sampleRate"], 48000.0);
        assert!(interpret(
            &json!({"streams":[{"codec_type":"audio","duration":"1"},{"codec_type":"audio"}]})
        )
        .is_err());
        let spans = interpret(&json!({"streams":[{"codec_type":"audio","duration":"2","start_time":"5"},{"codec_type":"audio","duration":"1","start_time":"0"}]})).unwrap();
        assert_eq!(spans["durationSeconds"], 7.0);
    }

    #[test]
    fn prefers_real_video_over_audio_cover() {
        let metadata = interpret(&json!({"format":{"duration":"15"},"streams":[
            {"codec_type":"video","width":200,"height":200,"disposition":{"attached_pic":1,"default":1}},
            {"codec_type":"video","width":640,"height":360,"avg_frame_rate":"24/1","disposition":{"default":1}}]})).unwrap();
        assert_eq!(metadata["width"], 640);
        assert_eq!(metadata["height"], 360);
        assert_eq!(metadata["streams"][1]["frameRate"], 24.0);
    }

    #[test]
    #[ignore = "Requires the separately installed ffprobe binary; performs local probing only"]
    fn installed_ffprobe_reads_real_wav_and_rejects_bad_media() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("实际音频.wav");
        let samples = 16000u32;
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + samples * 2).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&16000u32.to_le_bytes()).unwrap();
        file.write_all(&32000u32.to_le_bytes()).unwrap();
        file.write_all(&2u16.to_le_bytes()).unwrap();
        file.write_all(&16u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&(samples * 2).to_le_bytes()).unwrap();
        file.write_all(&vec![0u8; (samples * 2) as usize]).unwrap();
        file.sync_all().unwrap();
        drop(file);
        let metadata = probe(&path, &json!({})).unwrap();
        assert_eq!(metadata["durationSeconds"], 1.0);
        assert_eq!(metadata["metadataVerified"], true);
        assert_eq!(metadata["width"], Value::Null);
        assert_eq!(metadata["streams"][0]["codec"], "pcm_s16le");
        assert_eq!(metadata["streams"][0]["sampleRate"], 16000.0);
        fs::write(&path, b"not a media container").unwrap();
        assert!(probe(&path, &json!({})).is_err());
        assert!(path.exists());
    }

    #[test]
    #[ignore = "Explicit local representative video supplied by DIRECTOR_PROBE_VIDEO"]
    fn local_representative_video_has_actual_metadata() {
        let path = PathBuf::from(
            std::env::var_os("DIRECTOR_PROBE_VIDEO")
                .expect("Set DIRECTOR_PROBE_VIDEO to an existing local video"),
        );
        let metadata = probe(&path, &json!({})).unwrap();
        assert!(metadata["durationSeconds"].as_f64().unwrap() > 0.0);
        assert!(metadata["width"].as_u64().unwrap() > 0);
        assert!(metadata["height"].as_u64().unwrap() > 0);
        assert_eq!(metadata["metadataVerified"], true);
        println!("{}", metadata);
    }

    #[test]
    fn timeout_stops_the_native_child_process() {
        // Reuse the native test executable rather than launching a shell script.
        let fixture = format!(
            "{}::timeout_fixture",
            module_path!().split_once("::").unwrap().1
        );
        let args: Vec<OsString> = ["--exact", &fixture, "--ignored"]
            .iter()
            .map(OsString::from)
            .collect();
        let started = Instant::now();
        let error = run(
            &std::env::current_exe().unwrap(),
            &args,
            Duration::from_millis(80),
        )
        .unwrap_err();
        assert!(error.contains("超时"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "Timed-out child must be killed and joined immediately"
        );
    }

    #[test]
    #[ignore = "Native child fixture used only by the timeout test"]
    fn timeout_fixture() {
        if std::env::args().any(|v| v == "--exact") {
            thread::sleep(Duration::from_secs(2));
        }
    }
}
