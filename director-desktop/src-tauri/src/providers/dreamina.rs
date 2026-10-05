use super::*;
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn cli_path(config: &ProviderConfig) -> ProviderResult<&Path> {
    let path = config.cli_path.as_deref().ok_or_else(|| {
        ProviderError::new(
            "CLI_NOT_CONFIGURED",
            "请选择已安装的官方 dreamina 可执行文件。",
        )
    })?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| ProviderError::new("CLI_NOT_FOUND", "官方 CLI 路径不存在。"))?;
    if !path.is_absolute() || !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ProviderError::new(
            "CLI_PATH",
            "官方 CLI 必须为明确配置的绝对文件路径。",
        ));
    }
    Ok(path)
}

struct CliOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn execute(
    config: &ProviderConfig,
    args: &[String],
    submitting: bool,
) -> ProviderResult<CliOutput> {
    let _active = CliGuard::enter();
    if shutting_down() {
        return Err(ProviderError::new(
            "CLIENT_CLOSING",
            "客户端正在关闭，未启动新的本地任务。",
        ));
    }
    let mut command = Command::new(cli_path(config)?);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| ProviderError::new("CLI_START", "无法启动官方 CLI；尚未提交生成。"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let read = |stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            stream
                .take(wire::MAX_JSON + 1)
                .read_to_end(&mut out)
                .map(|_| out)
        })
    };
    let output = read(Box::new(stdout));
    let errors = read(Box::new(stderr));
    let started = Instant::now();
    let status = loop {
        if shutting_down() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = output.join();
            let _ = errors.join();
            return Err(if submitting {
                ProviderError::uncertain("客户端关闭时提交尚未确认；重新打开后请核对原任务。")
            } else {
                ProviderError::new("CLIENT_CLOSING", "客户端已停止本地 CLI 查询。")
            });
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if submitting {
                    ProviderError::uncertain("CLI 提交状态未确认，不能自动重发。")
                } else {
                    ProviderError::new("CLI_WAIT", "CLI 查询失败。")
                });
            }
        }
        if started.elapsed() > Duration::from_secs(config.timeout_seconds.clamp(1, 900)) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = output.join();
            let _ = errors.join();
            return Err(if submitting {
                ProviderError::uncertain("CLI 提交超时；请核对原任务，不能自动重发。")
            } else {
                ProviderError::new("CLI_TIMEOUT", "CLI 只读查询超时，可查询原任务重试。")
            });
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let bytes = output
        .join()
        .map_err(|_| ProviderError::new("CLI_OUTPUT", "CLI 输出读取失败。"))?
        .map_err(|_| ProviderError::new("CLI_OUTPUT", "CLI 输出读取失败。"))?;
    let error = errors.join().ok().and_then(Result::ok).unwrap_or_default();
    if bytes.len() as u64 > wire::MAX_JSON || error.len() as u64 > wire::MAX_JSON {
        return Err(if submitting {
            ProviderError::uncertain("CLI 提交回执超出限制，需人工核对。")
        } else {
            ProviderError::new("CLI_OUTPUT_LIMIT", "CLI 输出超出大小限制。")
        });
    }
    Ok(CliOutput {
        success: status.success(),
        stdout: bytes,
        stderr: error,
    })
}

fn output_error(output: &CliOutput, submitting: bool) -> ProviderError {
    // Inspect both streams, but never copy raw OAuth/CLI content into public errors.
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_ascii_lowercase();
    if text.contains("aigccomplianceconfirmationrequired") {
        return ProviderError::new(
            "WEB_CONFIRMATION_REQUIRED",
            "此模型要求先在即梦网页完成首次使用确认。",
        );
    }
    if text.contains("login")
        || text.contains("unauthorized")
        || text.contains("authentication")
        || text.contains("not logged")
        || text.contains("token expired")
        || text.contains("http 401")
        || text.contains("status code: 401")
    {
        return ProviderError::auth();
    }
    if submitting {
        ProviderError::uncertain("CLI 未返回可确认的提交结果；请核对渠道记录。")
    } else {
        ProviderError::new("CLI_QUERY_FAILED", "CLI 命令未成功，请核对安装版本与登录。")
    }
}

fn run(config: &ProviderConfig, args: &[String], submitting: bool) -> ProviderResult<Vec<u8>> {
    let output = execute(config, args, submitting)?;
    if !output.success {
        return Err(output_error(&output, submitting));
    }
    Ok(output.stdout)
}

fn auth_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let ansi = regex::Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap();
    ansi.replace_all(&text, "").into_owned()
}

fn auth_json(bytes: &[u8]) -> ProviderResult<Value> {
    // Some CLI builds prefix their JSON with a human-readable line or ANSI escape.
    let cleaned = auth_text(bytes);
    if let Ok(value) = serde_json::from_str::<Value>(cleaned.trim()) {
        return Ok(value);
    }
    for (position, ch) in cleaned.char_indices().filter(|(_, ch)| *ch == '{') {
        let mut stream =
            serde_json::Deserializer::from_str(&cleaned[position..]).into_iter::<Value>();
        if let Some(Ok(value)) = stream.next() {
            if value.is_object() {
                return Ok(value);
            }
        }
        let _ = ch;
    }
    Err(ProviderError::new(
        "CLI_AUTH_JSON",
        "官方 CLI 授权响应无法识别；未保存授权材料。",
    ))
}

fn oauth_material_body(bytes: &[u8]) -> Value {
    if let Ok(body) = auth_json(bytes) {
        return body;
    }
    // Official SDKs can print label:value material instead of a JSON object.
    // This mirrors the source-verified SHUO label parser, restricted to OAuth fields.
    let text = auth_text(bytes);
    let mut fields = serde_json::Map::new();
    for key in [
        "verification_uri_complete",
        "verification_url",
        "verification_uri",
        "user_code",
        "userCode",
        "device_code",
        "deviceCode",
        "expires_in",
        "interval",
    ] {
        let pattern = format!(
            r#"(?i)(?:^|[\s,{{]){}\s*[:=]\s*['"]?([^'"\s,;}}]+)"#,
            regex::escape(key)
        );
        if let Some(value) = regex::Regex::new(&pattern)
            .unwrap()
            .captures(&text)
            .and_then(|captures| captures.get(1))
        {
            fields.insert(
                key.into(),
                if ["expires_in", "interval"].contains(&key) {
                    value
                        .as_str()
                        .parse::<u64>()
                        .ok()
                        .map(Value::from)
                        .unwrap_or(Value::Null)
                } else {
                    json!(value.as_str())
                },
            );
        }
    }
    Value::Object(fields)
}

fn account_snapshot(body: &Value) -> Value {
    let data = task_object(body);
    let identity = match data.get("user_id") {
        Some(Value::String(id))
            if !id.trim().is_empty()
                && id.trim() != "0"
                && id.trim().len() <= 256
                && !id.trim().chars().any(char::is_whitespace)
                && !id.chars().any(char::is_control) =>
        {
            Some(id.trim().to_string())
        }
        Some(Value::Number(id)) => id.as_u64().filter(|id| *id > 0).map(|id| id.to_string()),
        _ => None,
    };
    let credit = |value: Option<&Value>| -> Option<f64> {
        value
            .and_then(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|x| x.parse::<f64>().ok()))
            })
            .filter(|x| x.is_finite() && *x >= 0.)
    };
    let mut result = json!({
        "status":if identity.is_some(){"authenticated"}else{"unknown"},
        "ready":identity.is_some(),
        "identityVerified":identity.is_some(),
        "message":if identity.is_some(){"即梦已登录，账户身份与积分已核对。"}else{"CLI 返回了积分信息，但没有可验证的账户身份；暂不能提交或恢复生成。"},
        "checkedAt":now(),
        "credits":{"total":credit(data.get("total_credit")),"member":credit(data.get("vip_credit")),"gift":credit(data.get("gift_credit")),"purchase":credit(data.get("purchase_credit"))}
    });
    if let Some(identity) = identity {
        result["accountKey"] = json!(format!(
            "dreamina:official:user:{}",
            hex_hash(identity.as_bytes())
        ));
    }
    if let Some(vip) = data
        .get("vip_level")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 64 && !s.chars().any(char::is_control))
    {
        result["vipLevel"] = json!(vip);
    }
    result
}

pub(super) fn account(config: &ProviderConfig) -> ProviderResult<Value> {
    let output = execute(config, &["user_credit".into()], false)?;
    if !output.success {
        return Err(output_error(&output, false));
    }
    Ok(account_snapshot(&auth_json(&output.stdout)?))
}

fn login_material(body: &Value) -> ProviderResult<Value> {
    let data = task_object(body);
    let field = |keys: &[&str]| -> Option<String> {
        keys.iter().find_map(|key| {
            data.get(*key)
                .and_then(Value::as_str)
                .filter(|s| {
                    !s.trim().is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control)
                })
                .map(|s| s.trim().to_string())
        })
    };
    let device = field(&["device_code", "deviceCode"]).ok_or_else(|| {
        ProviderError::new(
            "CLI_AUTH_MATERIAL",
            "官方 CLI 没有返回设备授权码；请刷新登录状态。",
        )
    })?;
    let uri = field(&[
        "verification_uri_complete",
        "verification_url",
        "verification_uri",
    ])
    .ok_or_else(|| ProviderError::new("CLI_AUTH_MATERIAL", "官方 CLI 没有返回授权网页地址。"))?;
    let mut result = json!({"device_code":device,"verification_uri":uri});
    if let Some(code) = field(&["user_code", "userCode"]) {
        result["user_code"] = json!(code);
    }
    for key in ["expires_in", "interval"] {
        if let Some(value) = data
            .get(key)
            .and_then(Value::as_u64)
            .filter(|n| *n > 0 && *n <= 86400)
        {
            result[key] = json!(value);
        }
    }
    // This allowlist is returned only to the core's in-memory OAuth flow. Never store raw JSON.
    Ok(result)
}

pub(super) fn begin_login(config: &ProviderConfig) -> ProviderResult<Value> {
    match account(config) {
        Ok(value) if value.get("ready").and_then(Value::as_bool) == Some(true) => return Ok(value),
        Ok(_) => {
            return Err(ProviderError::new(
                "CLI_AUTH_IDENTITY",
                "现有登录缺少可验证身份；请先刷新或由用户明确退出后重新登录。",
            ))
        }
        Err(error) if error.auth_required => {}
        Err(error) => return Err(error),
    }
    let output = execute(config, &["login".into(), "--headless".into()], false)?;
    if !output.success {
        return Err(output_error(&output, false));
    }
    let body = oauth_material_body(&output.stdout);
    if task_object(&body).get("device_code").is_none()
        && task_object(&body).get("deviceCode").is_none()
    {
        // Login can reuse an existing session; only user_credit proves which account it is.
        return account(config);
    }
    login_material(&body)
}

fn login_result(output: &CliOutput) -> ProviderResult<Option<Value>> {
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_ascii_lowercase();
    if text.contains("access_denied")
        || text.contains("authorization denied")
        || text.contains("authsdk: login denied")
    {
        return Err(ProviderError::new(
            "CLI_AUTH_DENIED",
            "即梦授权被拒绝，尚未连接账户。",
        ));
    }
    if text.contains("expired_token") || text.contains("device_code expired") {
        return Err(ProviderError::new(
            "CLI_AUTH_EXPIRED",
            "即梦授权已过期，请重新发起登录。",
        ));
    }
    if text.contains("authorization_pending") || text.contains("slow_down") {
        return Ok(Some(
            json!({"status":"pending","ready":false,"identityVerified":false,"slowDown":text.contains("slow_down"),"message":"等待在即梦授权网页完成登录确认。","checkedAt":now()}),
        ));
    }
    if !output.success {
        return Err(output_error(output, false));
    }
    // A successful process exit is only permission to query identity, never proof of login.
    Ok(None)
}

pub(super) fn check_login(config: &ProviderConfig, device_code: &str) -> ProviderResult<Value> {
    if device_code.is_empty()
        || device_code.len() > 4096
        || device_code.chars().any(char::is_whitespace)
        || device_code.chars().any(char::is_control)
    {
        return Err(ProviderError::new(
            "CLI_AUTH_DEVICE",
            "设备授权码无效；请重新发起登录。",
        ));
    }
    let output = execute(
        config,
        &[
            "login".into(),
            "checklogin".into(),
            format!("--device_code={device_code}"),
            "--poll=0".into(),
        ],
        false,
    )?;
    if let Some(pending) = login_result(&output)? {
        return Ok(pending);
    }
    account(config)
}

pub(super) fn logout(config: &ProviderConfig) -> ProviderResult<()> {
    let output = execute(config, &["logout".into()], false)?;
    if !output.success {
        return Err(output_error(&output, false));
    }
    Ok(())
}
fn help(config: &ProviderConfig, command: &str) -> ProviderResult<String> {
    let bytes = run(config, &[command.into(), "-h".into()], false)?;
    String::from_utf8(bytes).map_err(|_| ProviderError::new("CLI_HELP", "CLI 帮助编码无效。"))
}
fn has_token(text: &str, token: &str) -> bool {
    let expression = format!(
        r"(^|[^a-zA-Z0-9_.]){}([^a-zA-Z0-9_.]|$)",
        regex::escape(token)
    );
    regex::Regex::new(&expression).unwrap().is_match(text)
}

fn declared_resolutions(help: &str, model: &str) -> Vec<String> {
    let expected: &[&str] = match model {
        "3.0" | "3.1" => &["1k", "2k"],
        "5.0Pro" => &["1.5k", "2k", "4k"],
        _ => &["2k", "4k"],
    };
    // Match a model-specific declaration rather than a resolution occurring elsewhere.
    let declaration = help.lines().find(|line| {
        let Some((names, settings)) = line.split_once("->") else {
            return false;
        };
        has_token(names, model) && settings.contains("resolution_type")
    });
    expected
        .iter()
        .filter(|resolution| declaration.is_some_and(|line| has_token(line, resolution)))
        .map(|x| (*x).into())
        .collect()
}

fn custom_1080_verified(help: &str) -> bool {
    has_token(help, "--width")
        && has_token(help, "--height")
        && help.contains("mutually exclusive with --ratio")
        && help.contains("2k: each side 768-3072; total pixels <= 4194304")
}

fn video_declaration<'a>(help: &'a str, model: &str, field: &str) -> Option<&'a str> {
    // The help lists model-specific rules first, then a rule for all remaining models.
    // Reading the whole help would accidentally lend another model its 4K or 1080P.
    let declarations: Vec<_> = help
        .lines()
        .filter_map(|line| line.trim().strip_prefix("- "))
        .filter_map(|line| line.split_once("->"))
        .filter(|(_, settings)| settings.contains(field))
        .collect();
    declarations
        .iter()
        .find(|(names, _)| has_token(names, model))
        .or_else(|| {
            declarations.iter().find(|(names, _)| {
                names.trim() == "all other models"
                    || (model.starts_with("seedance2.0")
                        && names.trim() == "all other seedance2.0 models")
            })
        })
        .map(|(_, settings)| *settings)
}

fn video_resolutions(help: &str, model: &str) -> Vec<String> {
    let Some(declaration) = video_declaration(help, model, "video_resolution") else {
        return vec![];
    };
    let field = declaration
        .split_once("video_resolution")
        .map(|(_, settings)| settings.split(';').next().unwrap_or(""))
        .unwrap_or("");
    ["480p", "720p", "1080p", "4k"]
        .iter()
        .filter(|resolution| has_token(field, resolution))
        .map(|resolution| (*resolution).into())
        .collect()
}

fn cli_identity(config: &ProviderConfig) -> ProviderResult<Value> {
    let path = cli_path(config)?;
    let mut file = fs::File::open(path)
        .map_err(|_| ProviderError::new("CLI_READ", "无法核对官方 CLI 文件。"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    let mut bytes = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| ProviderError::new("CLI_READ", "官方 CLI 文件读取失败。"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        bytes += read as u64;
    }
    Ok(json!({"path":path,"sha256":format!("{:x}",hash.finalize()),"bytes":bytes}))
}

fn image_1080_dimensions(ratio: &str) -> ProviderResult<(u32, u32)> {
    // The 1080p preset means a short edge of 1080 px, not an upstream enum.
    let dimensions = match ratio {
        "21:9" => (2520, 1080),
        "16:9" => (1920, 1080),
        "3:2" => (1620, 1080),
        "4:3" => (1440, 1080),
        "1:1" => (1080, 1080),
        "3:4" => (1080, 1440),
        "2:3" => (1080, 1620),
        "9:16" => (1080, 1920),
        _ => {
            return Err(ProviderError::new(
                "OUTPUT_CAPACITY",
                "1080P 图片预设只支持当前官方 CLI 的常用比例。",
            ))
        }
    };
    let (width, height) = dimensions;
    if !(768..=3072).contains(&width)
        || !(768..=3072).contains(&height)
        || u64::from(width) * u64::from(height) > 4_194_304
    {
        return Err(ProviderError::new(
            "OUTPUT_CAPACITY",
            "1080P 图片预设超出已验证像素容量。",
        ));
    }
    Ok(dimensions)
}

pub(super) fn capabilities(config: &ProviderConfig) -> ProviderResult<Capabilities> {
    let version = run(config, &["version".into()], false)?;
    let video_help = help(config, "multimodal2video")?;
    let text_video_help = help(config, "text2video")?;
    let image_help = help(config, "text2image")?;
    let edit_help = help(config, "image2image")?;
    capabilities_from_help(
        &version,
        &video_help,
        &text_video_help,
        &image_help,
        &edit_help,
    )
}

fn capabilities_from_help(
    version: &[u8],
    video_help: &str,
    text_video_help: &str,
    image_help: &str,
    edit_help: &str,
) -> ProviderResult<Capabilities> {
    let mut models = Vec::new();
    let ratios: Vec<String> = ["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"]
        .iter()
        .filter(|r| video_help.contains(**r) && text_video_help.contains(**r))
        .map(|r| r.to_string())
        .collect();
    for model in [
        "seedance2.0",
        "seedance2.0fast",
        "seedance2.0_vip",
        "seedance2.0fast_vip",
        "seedance2.0mini",
        "seedance2.5",
    ] {
        if !has_token(&video_help, model) || !has_token(&text_video_help, model) {
            continue;
        }
        let v25 = model == "seedance2.5";
        // These mappings are enabled only when the current CLI explicitly advertises them.
        let counts_verified = if v25 {
            video_help.contains("image<=30")
                && video_help.contains("video<=10")
                && video_help.contains("audio<=10")
                && video_help.contains("total inputs<=50")
                && video_help.contains("4-30")
        } else {
            video_help.contains("image<=9")
                && video_help.contains("video<=3")
                && video_help.contains("audio<=3")
                && video_help.contains("total inputs<=12")
                && video_help.contains("4-15")
        };
        let text_resolutions = video_resolutions(text_video_help, model);
        let resolutions: Vec<_> = video_resolutions(video_help, model)
            .into_iter()
            .filter(|resolution| text_resolutions.contains(resolution))
            .collect();
        let resolution_mode = if resolutions.len() == 1 {
            "fixed"
        } else {
            "choice"
        };
        models.push(ModelCapability{id:model.into(),kind:"video".into(),adapted:counts_verified && !resolutions.is_empty() && !ratios.is_empty(),min_duration:Some(4),max_duration:Some(if v25{30}else{15}),allowed_durations:vec![],ratios:ratios.clone(),resolutions,images:if v25{30}else{9},videos:if v25{10}else{3},audios:if v25{10}else{3},total_references:Some(if v25{50}else{12}),required_images:0,price:None,billing:None,currency:None,video_price_multiplier:None,raw:json!({"verifiedFrom":"CLI help","resolutionMode":resolution_mode,"referenceDurationMin":2,"referenceDurationMax":if v25{30}else{15}})});
    }
    let image_ratios: Vec<String> = ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"]
        .iter()
        .filter(|r| image_help.contains(**r))
        .map(|r| r.to_string())
        .collect();
    for model in [
        "3.0", "3.1", "4.0", "4.1", "4.5", "4.6", "4.7", "5.0", "5.0Pro",
    ] {
        if !has_token(&image_help, model) {
            continue;
        }
        let edit_supported = has_token(edit_help, model);
        let mut resolutions = declared_resolutions(image_help, model);
        if edit_supported {
            let editing = declared_resolutions(edit_help, model);
            resolutions.retain(|r| editing.contains(r));
        }
        let custom_1080 = resolutions.iter().any(|r| r == "2k")
            && custom_1080_verified(image_help)
            && (!edit_supported || custom_1080_verified(edit_help));
        if custom_1080 {
            resolutions.insert(0, "1080p".into());
        }
        models.push(ModelCapability {
            id: model.into(),
            kind: "image".into(),
            adapted: !resolutions.is_empty(),
            min_duration: None,
            max_duration: None,
            allowed_durations: vec![],
            ratios: image_ratios.iter().filter(|ratio| !edit_supported || edit_help.contains(ratio.as_str())).cloned().collect(),
            resolutions,
            images: if edit_supported { 10 } else { 0 },
            videos: 0,
            audios: 0,
            total_references: Some(10),
            required_images: 0,
            price: None,
            billing: None,
            currency: None,
            video_price_multiplier: None,
            raw: json!({"verifiedFrom":"CLI help","presetMap":if custom_1080 {json!({"1080p":{"customPixelPreset":true,"shortEdge":1080,"resolutionType":"2k","dimensionMode":"width_height","ratioArgument":false,"minimumSide":768,"maximumSide":3072,"maximumPixels":4194304}})}else{json!({})}}),
        });
    }
    let material = format!(
        "dreamina-adapter/preflight-v2\n{}\n{video_help}\n{text_video_help}\n{image_help}\n{edit_help}",
        String::from_utf8_lossy(version)
    );
    Ok(Capabilities {
        provider: "dreamina".into(),
        version: hex_hash(material.as_bytes()),
        source: "cli_help".into(),
        checked_at: now(),
        models,
        can_cancel: false,
        can_reconcile_unknown: false,
        raw: json!({"adapterContract":"dreamina-adapter/preflight-v2","build":serde_json::from_slice::<Value>(version).unwrap_or_else(|_|json!({"unparsed":true})),"help":{"multimodal2video":video_help,"text2video":text_video_help,"text2image":image_help,"image2image":edit_help}}),
    })
}

pub(super) fn prepare(
    config: &ProviderConfig,
    request: &GenerationRequest,
) -> ProviderResult<PreparedRequest> {
    let identity = cli_identity(config)?;
    let caps = capabilities(config)?;
    if cli_identity(config)? != identity {
        return Err(ProviderError::new(
            "CLI_CHANGED",
            "官方 CLI 在预检期间变化，请重新准备关联单元。",
        ));
    }
    let mut prepared = prepare_with_capabilities(request, &caps)?;
    prepared.wire["cliIdentity"] = identity;
    Ok(prepared)
}

fn validate_cli_options(request: &GenerationRequest) -> ProviderResult<()> {
    if !request.options.as_object().is_some_and(|m| {
        m.iter().all(|(key, value)| {
            request.kind == "image" && key == "count" && value.as_u64() == Some(1)
        })
    }) {
        return Err(ProviderError::new(
            "UNSUPPORTED_OPTION",
            "官方 CLI 当前只使用已验证的基础参数，不会忽略额外生成设置。",
        ));
    }
    if request.references.iter().any(|r| {
        ["first_frame", "start_frame", "last_frame", "end_frame"].contains(&r.usage.as_str())
    }) {
        return Err(ProviderError::new(
            "FRAME_MODE_NOT_ADAPTED",
            "当前官方 CLI 适配使用全能参考，首尾帧用途需要单独适配后使用。",
        ));
    }
    Ok(())
}

fn prepare_with_capabilities(
    request: &GenerationRequest,
    caps: &Capabilities,
) -> ProviderResult<PreparedRequest> {
    validate_cli_options(request)?;
    let model = caps
        .models
        .iter()
        .find(|m| m.id == request.model && m.kind == request.kind)
        .ok_or_else(|| {
            ProviderError::new("MODEL_UNAVAILABLE", "当前官方 CLI 没有明确支持此模型。")
        })?;
    check_model(model, request)?;
    let refs = sorted_references(request);
    let has_refs = !refs.is_empty();
    let command = match (request.kind.as_str(), has_refs) {
        ("image", true) => "image2image",
        ("image", false) => "text2image",
        ("video", true) => "multimodal2video",
        ("video", false) => "text2video",
        _ => unreachable!(),
    };
    let mut args = vec![
        command.to_string(),
        format!("--model_version={}", request.model),
        format!("--prompt={}", request.prompt),
        "--poll=0".into(),
    ];
    if request.kind == "video" {
        args.push(format!("--ratio={}", request.ratio));
        if has_refs
            && request.model != "seedance2.5"
            && !refs.iter().any(|r| r.kind == "image" || r.kind == "video")
        {
            return Err(ProviderError::new(
                "REFERENCE_REQUIRED",
                "此模型不能只使用音频参考。",
            ));
        }
        args.push(format!("--duration={}", request.duration.unwrap()));
        args.push(format!(
            "--video_resolution={}",
            request.resolution.to_ascii_lowercase()
        ));
        let max_duration = if request.model == "seedance2.5" {
            30.
        } else {
            15.
        };
        for kind in ["video", "audio"] {
            let items: Vec<_> = refs.iter().filter(|r| r.kind == kind).collect();
            let mut total = 0.;
            for item in items {
                let duration = item.duration_seconds.ok_or_else(|| {
                    ProviderError::new("MEDIA_DURATION_REQUIRED", "视频及音频参考需要已验证时长。")
                })?;
                if !duration.is_finite() || duration < 2. || duration > max_duration {
                    return Err(ProviderError::new(
                        "MEDIA_DURATION",
                        "参考音视频超出官方 CLI 时长能力。",
                    ));
                }
                total += duration;
            }
            if total > max_duration {
                return Err(ProviderError::new(
                    "MEDIA_DURATION",
                    "同类参考音视频总时长超出模型能力。",
                ));
            }
        }
        for r in &refs {
            args.push(format!(
                "--{}={}",
                r.kind,
                r.path
                    .to_str()
                    .ok_or_else(|| ProviderError::new("MEDIA_PATH", "素材路径无法编码。"))?
            ));
        }
    } else {
        let resolution = if request.resolution.eq_ignore_ascii_case("1080p") {
            let (width, height) = image_1080_dimensions(&request.ratio)?;
            args.push(format!("--width={width}"));
            args.push(format!("--height={height}"));
            "2k".into()
        } else {
            args.push(format!("--ratio={}", request.ratio));
            request.resolution.to_ascii_lowercase()
        };
        args.push(format!("--resolution_type={}", resolution));
        args.push("--generate_num=1".into());
        if has_refs {
            let paths: ProviderResult<Vec<_>> =
                refs.iter()
                    .map(|r| {
                        let s = r.path.to_str().ok_or_else(|| {
                            ProviderError::new("MEDIA_PATH", "素材路径无法编码。")
                        })?;
                        if s.contains([',', '"', '\n', '\r']) {
                            return Err(ProviderError::new(
                                "MEDIA_PATH",
                                "官方图片 CLI 不支持路径中的逗号、引号或换行。",
                            ));
                        }
                        Ok(s)
                    })
                    .collect();
            args.push(format!("--images={}", paths?.join(",")));
        }
    }
    let mut frozen = request.clone();
    frozen.references = refs;
    Ok(PreparedRequest {
        provider: "dreamina".into(),
        request: frozen,
        capability_version: caps.version.clone(),
        upload_receipts: vec![],
        wire: json!({"args":args,"uploadMode":"cli_internal","uploadReceiptsExposed":false,"preflight":{"capabilityVersion":caps.version,"model":model}}),
        estimated_cost: None,
        prepared_at: now(),
    })
}

fn parse_output(bytes: &[u8], submitting: bool) -> ProviderResult<Value> {
    serde_json::from_slice::<Value>(bytes)
        .map(wire::sanitize)
        .map_err(|_| {
            if submitting {
                ProviderError::uncertain("官方 CLI 的提交回执无法解析；不能自动重发。")
            } else {
                ProviderError::new("CLI_INVALID_JSON", "官方 CLI 查询响应不是可识别 JSON。")
            }
        })
}
fn task_object(value: &Value) -> &Value {
    value.get("data").filter(|v| v.is_object()).unwrap_or(value)
}
fn result_urls(value: &Value, expected_kind: Option<&str>) -> Vec<String> {
    fn add(value: &Value, out: &mut Vec<String>) -> bool {
        let Some(value) = value.as_str() else {
            return false;
        };
        let valid = !value.chars().any(|c| c.is_control() || c.is_whitespace())
            && reqwest::Url::parse(value).is_ok_and(|url| {
                url.scheme() == "https"
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
            });
        if valid && !out.iter().any(|url| url == value) {
            // Keep signed result URLs byte-for-byte, including every query parameter.
            out.push(value.into());
        }
        valid
    }
    fn collect(
        v: &Value,
        out: &mut Vec<String>,
        depth: u32,
        record: bool,
        kind: Option<&str>,
        expected_kind: Option<&str>,
    ) {
        if depth > 6 {
            return;
        }
        match v {
            Value::Array(xs) => {
                for x in xs {
                    collect(x, out, depth + 1, record, kind, expected_kind)
                }
            }
            Value::String(_) if record => {
                add(v, out);
            }
            Value::Object(map) => {
                let keys: &[&str] = match expected_kind.or(kind) {
                    Some("image") => &["image_url", "result_url", "download_url"],
                    Some("video") => &["video_url", "result_url", "download_url"],
                    _ => &["image_url", "video_url", "result_url", "download_url"],
                };
                // A generic `url` is accepted only inside an output container and only
                // as fallback. Queue/help/reference/thumbnail dictionaries are never walked.
                let opposite_record = kind.is_none()
                    && match expected_kind {
                        Some("image") => {
                            map.contains_key("video_url") && !map.contains_key("image_url")
                        }
                        Some("video") => {
                            map.contains_key("image_url") && !map.contains_key("video_url")
                        }
                        _ => false,
                    };
                let typed_result = !opposite_record
                    && keys
                        .iter()
                        .any(|key| map.get(*key).is_some_and(|url| add(url, out)));
                if record && !typed_result && !opposite_record {
                    if let Some(url) = map.get("url") {
                        add(url, out);
                    }
                }
                for key in [
                    "data",
                    "result",
                    "results",
                    "result_json",
                    "result_data",
                    "outputs",
                    "images",
                    "videos",
                    "result_list",
                    "result_urls",
                    "image_urls",
                    "video_urls",
                ] {
                    if let Some(nested) = map.get(key) {
                        if (key == "result_json" && !nested.is_object())
                            || (["result_urls", "image_urls", "video_urls"].contains(&key)
                                && !nested.is_array())
                        {
                            continue;
                        }
                        let kind = match key {
                            "images" | "image_urls" => Some("image"),
                            "videos" | "video_urls" => Some("video"),
                            _ => kind,
                        };
                        if expected_kind.is_some() && kind.is_some() && expected_kind != kind {
                            continue;
                        }
                        collect(nested, out, depth + 1, key != "data", kind, expected_kind);
                    }
                }
            }
            _ => {}
        }
    }
    let mut urls = Vec::new();
    collect(value, &mut urls, 0, false, None, expected_kind);
    urls
}
#[cfg(test)]
fn normalized(body: Value, expected: Option<&str>) -> ProviderResult<QueryResult> {
    normalized_for_kind(body, expected, None)
}
fn normalized_for_kind(
    body: Value,
    expected: Option<&str>,
    kind: Option<&str>,
) -> ProviderResult<QueryResult> {
    let task = task_object(&body);
    let mut explicit_id = None;
    for envelope in [&body, task] {
        for alias in ["submit_id", "submitId", "task_id", "taskId"] {
            if let Some(value) = envelope.get(alias) {
                let id = value.as_str().ok_or_else(|| {
                    ProviderError::new("TASK_ID_INVALID", "CLI 返回了无法识别的任务身份类型。")
                })?;
                valid_id(id).map_err(|_| {
                    ProviderError::new("TASK_ID_INVALID", "CLI 返回的任务身份无效。")
                })?;
                if explicit_id.is_some_and(|previous| previous != id) {
                    return Err(ProviderError::new(
                        "TASK_ID_CONFLICT",
                        "CLI 返回的多个任务身份不一致。",
                    ));
                }
                explicit_id = Some(id);
            }
        }
    }
    let id = explicit_id.or(expected).unwrap_or("");
    if expected.is_some_and(|x| x != id) {
        return Err(ProviderError::new(
            "TASK_MISMATCH",
            "CLI 返回了其他任务的结果。",
        ));
    }
    let status = match task.get("gen_status").and_then(Value::as_str) {
        Some("success") => "succeeded",
        Some("fail" | "failed") => "failed",
        Some("querying" | "queued" | "pending") => "processing",
        _ => "unknown",
    };
    let urls = if status == "succeeded" {
        result_urls(task, kind)
    } else {
        Vec::new()
    };
    let error = task
        .get("fail_reason")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| wire::safe_message(task));
    Ok(QueryResult {
        task_id: id.into(),
        status: status.into(),
        result_urls: urls,
        error,
        actual_cost: None,
        raw: body,
    })
}
pub(super) fn submit(
    config: &ProviderConfig,
    prepared: &PreparedRequest,
) -> ProviderResult<SubmitReceipt> {
    submit_with_runner(config, prepared, |args| run(config, args, true))
}

fn validated_submit_args(
    config: &ProviderConfig,
    prepared: &PreparedRequest,
) -> ProviderResult<Vec<String>> {
    // The caller has already persisted its submit intent. All current help/version
    // commands belong to prepare; submit performs only local integrity checks before
    // starting the actual generation process. A replaced CLI invalidates the preflight.
    validate_request(&prepared.request)?;
    let identity = prepared.wire.get("cliIdentity").ok_or_else(|| {
        ProviderError::new(
            "CLI_PREFLIGHT_MISSING",
            "此准备结果缺少官方 CLI 文件证明，请重新准备后生成。",
        )
    })?;
    if &cli_identity(config)? != identity {
        return Err(ProviderError::new(
            "CLI_CHANGED",
            "官方 CLI 已更换，请重新准备关联单元。",
        ));
    }
    let preflight = prepared
        .wire
        .get("preflight")
        .ok_or_else(|| ProviderError::new("PREPARED_INVALID", "CLI 准备能力快照缺失。"))?;
    if preflight.get("capabilityVersion").and_then(Value::as_str)
        != Some(prepared.capability_version.as_str())
    {
        return Err(ProviderError::new(
            "PREPARED_INVALID",
            "CLI 准备能力身份不一致。",
        ));
    }
    let model: ModelCapability = serde_json::from_value(preflight["model"].clone())
        .map_err(|_| ProviderError::new("PREPARED_INVALID", "CLI 准备型号能力无效。"))?;
    let caps = Capabilities {
        provider: "dreamina".into(),
        version: prepared.capability_version.clone(),
        source: "frozen_preflight".into(),
        checked_at: prepared.prepared_at.clone(),
        models: vec![model],
        can_cancel: false,
        can_reconcile_unknown: false,
        raw: Value::Null,
    };
    let mut current = prepare_with_capabilities(&prepared.request, &caps)?;
    current.wire["cliIdentity"] = identity.clone();
    if current.wire != prepared.wire || !prepared.upload_receipts.is_empty() {
        return Err(ProviderError::new(
            "PREPARED_INVALID",
            "CLI 参数与冻结请求不一致。",
        ));
    }
    current
        .wire
        .get("args")
        .and_then(Value::as_array)
        .ok_or_else(|| ProviderError::new("PREPARED_INVALID", "CLI 准备快照无效。"))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| ProviderError::new("PREPARED_INVALID", "CLI 参数无效。"))
        })
        .collect::<ProviderResult<_>>()
}

fn submit_with_runner(
    config: &ProviderConfig,
    prepared: &PreparedRequest,
    runner: impl FnOnce(&[String]) -> ProviderResult<Vec<u8>>,
) -> ProviderResult<SubmitReceipt> {
    let args = validated_submit_args(config, prepared)?;
    let body = parse_output(&runner(&args)?, true)?;
    let result =
        normalized_for_kind(body, None, Some(&prepared.request.kind)).map_err(|error| {
            if ["TASK_ID_INVALID", "TASK_ID_CONFLICT"].contains(&error.code.as_str()) {
                ProviderError::uncertain(
                    "官方 CLI 已运行生成但提交回执任务身份无效；请核对原任务，不能自动重发。",
                )
            } else {
                error
            }
        })?;
    if result.task_id.is_empty() {
        return Err(ProviderError::uncertain(
            "官方 CLI 未返回 submit_id；请核对任务历史。",
        ));
    }
    Ok(SubmitReceipt {
        task_id: result.task_id,
        status: result.status,
        result_urls: result.result_urls,
        raw: result.raw,
    })
}
pub(super) fn query(config: &ProviderConfig, task_id: &str) -> ProviderResult<QueryResult> {
    query_with_runner(task_id, None, || {
        run(
            config,
            &["query_result".into(), format!("--submit_id={task_id}")],
            false,
        )
    })
}
pub(super) fn query_kind(
    config: &ProviderConfig,
    task_id: &str,
    kind: &str,
) -> ProviderResult<QueryResult> {
    query_with_runner(task_id, Some(kind), || {
        run(
            config,
            &["query_result".into(), format!("--submit_id={task_id}")],
            false,
        )
    })
}
pub(super) fn query_prepared(
    config: &ProviderConfig,
    prepared: &PreparedRequest,
    task_id: &str,
) -> ProviderResult<QueryResult> {
    query_prepared_with_runner(prepared, task_id, || {
        run(
            config,
            &["query_result".into(), format!("--submit_id={task_id}")],
            false,
        )
    })
}
fn query_prepared_with_runner(
    prepared: &PreparedRequest,
    task_id: &str,
    runner: impl FnOnce() -> ProviderResult<Vec<u8>>,
) -> ProviderResult<QueryResult> {
    if prepared.provider != "dreamina" {
        return Err(ProviderError::new(
            "PROVIDER_MISMATCH",
            "原任务准备身份与即梦渠道不一致。",
        ));
    }
    query_with_runner(task_id, Some(&prepared.request.kind), runner)
}
fn query_with_runner(
    task_id: &str,
    kind: Option<&str>,
    runner: impl FnOnce() -> ProviderResult<Vec<u8>>,
) -> ProviderResult<QueryResult> {
    valid_id(task_id)?;
    if kind.is_some_and(|kind| !["image", "video"].contains(&kind)) {
        return Err(ProviderError::new(
            "INVALID_RESULT_KIND",
            "原任务的媒体类型无效。",
        ));
    }
    let body = parse_output(&runner()?, false)?;
    normalized_for_kind(body, Some(task_id), kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    const VIDEO_HELP: &str =
        include_str!("../../../tools/dreamina/1.4.19/multimodal2video-help.txt");
    const TEXT_VIDEO_HELP: &str =
        include_str!("../../../tools/dreamina/1.4.19/text2video-help.txt");
    const IMAGE_HELP: &str = "model_version: 3.0, 3.1, 4.0, 4.1, 4.5, 4.6, 4.7, 5.0, 5.0Pro\nratio: 21:9, 16:9, 3:2, 4:3, 1:1, 3:4, 2:3, 9:16\n- 3.0/3.1 -> resolution_type 1k or 2k; custom width/height requires resolution_type 2k\n- 4.0/4.1/4.5/4.6/4.7/5.0 -> resolution_type 2k or 4k\n- 5.0Pro -> resolution_type 1.5k, 2k, or 4k\n--width and --height are mutually exclusive with --ratio\n- 2k: each side 768-3072; total pixels <= 4194304";
    const EDIT_HELP: &str = "model_version: 4.0, 4.1, 4.5, 4.6, 4.7, 5.0, 5.0Pro\nratio: 21:9, 16:9, 3:2, 4:3, 1:1, 3:4, 2:3, 9:16\n- 4.0/4.1/4.5/4.6/4.7/5.0 -> resolution_type 2k or 4k\n- 5.0Pro -> resolution_type 1.5k, 2k, or 4k\n--width and --height are mutually exclusive with --ratio\n- 2k: each side 768-3072; total pixels <= 4194304";
    fn image_caps() -> Capabilities {
        capabilities_from_help(b"{}", "", "", IMAGE_HELP, EDIT_HELP).unwrap()
    }
    fn image_request(model: &str, ratio: &str, resolution: &str) -> GenerationRequest {
        GenerationRequest {
            request_id: "offline-image".into(),
            kind: "image".into(),
            model: model.into(),
            prompt: "offline reference character".into(),
            duration: None,
            ratio: ratio.into(),
            resolution: resolution.into(),
            references: vec![],
            options: json!({}),
        }
    }
    fn fake_cli_prepared() -> (tempfile::TempDir, ProviderConfig, PreparedRequest) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("dreamina-local-proof.exe");
        // A deliberately non-executable file proves the injected submission path
        // never tries to execute version/help during its local preflight validation.
        fs::write(&path, b"offline CLI identity only").unwrap();
        let config = ProviderConfig {
            kind: "dreamina".into(),
            endpoint: None,
            credential_env: None,
            cli_path: Some(path),
            bridge_token_env: None,
            timeout_seconds: 1,
            adapted_models: vec![],
        };
        let mut prepared =
            prepare_with_capabilities(&image_request("5.0", "16:9", "1080p"), &image_caps())
                .unwrap();
        prepared.wire["cliIdentity"] = cli_identity(&config).unwrap();
        (directory, config, prepared)
    }
    #[test]
    fn video_model_sizes_are_specific_and_fixed_choices_are_not_empty() {
        let caps = capabilities_from_help(b"{}", VIDEO_HELP, TEXT_VIDEO_HELP, "", "").unwrap();
        let expected = [
            ("seedance2.0", vec!["720p"]),
            ("seedance2.0fast", vec!["720p"]),
            ("seedance2.0_vip", vec!["720p", "1080p", "4k"]),
            ("seedance2.0fast_vip", vec!["720p"]),
            ("seedance2.0mini", vec!["720p"]),
            ("seedance2.5", vec!["480p", "720p", "1080p"]),
        ];
        for (id, resolutions) in expected {
            let model = caps.models.iter().find(|m| m.id == id).unwrap();
            assert!(model.adapted, "{id} must remain selectable");
            assert_eq!(model.resolutions, resolutions, "{id}");
            assert_eq!(model.ratios.len(), 6, "{id}");
            assert_eq!(
                model.raw["resolutionMode"],
                if resolutions.len() == 1 {
                    "fixed"
                } else {
                    "choice"
                }
            );
            let mut request = image_request(id, "16:9", resolutions[0]);
            request.kind = "video".into();
            request.duration = Some(5);
            assert!(prepare_with_capabilities(&request, &caps).is_ok(), "{id}");
        }
    }
    #[test]
    fn video_sizes_do_not_leak_from_other_models_or_flags() {
        let text_without_other_rule = TEXT_VIDEO_HELP.replace(
            "- all other models -> video_resolution 720p; duration 4-15s",
            "- all other models -> duration 4-15s",
        );
        let caps =
            capabilities_from_help(b"{}", VIDEO_HELP, &text_without_other_rule, "", "").unwrap();
        let fast = caps
            .models
            .iter()
            .find(|m| m.id == "seedance2.0fast")
            .unwrap();
        assert!(fast.resolutions.is_empty());
        assert!(!fast.adapted);
        let vip = caps
            .models
            .iter()
            .find(|m| m.id == "seedance2.0_vip")
            .unwrap();
        assert_eq!(vip.resolutions, vec!["720p", "1080p", "4k"]);
        let inconsistent = TEXT_VIDEO_HELP.replace(
            "- seedance2.0_vip -> video_resolution 720p, 1080p, or 4k; duration 4-15s",
            "- seedance2.0_vip -> video_resolution 720p; duration 4-15s",
        );
        let caps = capabilities_from_help(b"{}", VIDEO_HELP, &inconsistent, "", "").unwrap();
        assert_eq!(
            caps.models
                .iter()
                .find(|m| m.id == "seedance2.0_vip")
                .unwrap()
                .resolutions,
            vec!["720p"]
        );
    }
    #[test]
    fn frozen_submit_runs_only_the_generation_command_once() {
        let (_directory, config, prepared) = fake_cli_prepared();
        let mut calls = 0;
        let receipt = submit_with_runner(&config, &prepared, |args| {
            calls += 1;
            assert_eq!(args[0], "text2image");
            assert!(args.iter().any(|arg| arg == "--poll=0"));
            assert!(args.iter().any(|arg| arg == "--width=1920"));
            assert!(args.iter().any(|arg| arg == "--resolution_type=2k"));
            assert!(!args
                .iter()
                .any(|arg| ["version", "-h", "--help"].contains(&arg.as_str())));
            Ok(br#"{"submit_id":"offline-task","gen_status":"querying"}"#.to_vec())
        })
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(receipt.task_id, "offline-task");
        assert_eq!(receipt.status, "processing");
    }
    #[test]
    fn changed_cli_or_frozen_wire_is_rejected_before_generation() {
        let (_directory, config, mut prepared) = fake_cli_prepared();
        prepared.wire["args"][1] = json!("--model_version=unverified");
        let mut called = false;
        let error = submit_with_runner(&config, &prepared, |_| {
            called = true;
            Ok(vec![])
        })
        .unwrap_err();
        assert_eq!(error.code, "PREPARED_INVALID");
        assert!(!called);
        let (_directory, config, prepared) = fake_cli_prepared();
        fs::write(
            config.cli_path.as_ref().unwrap(),
            b"CLI changed after preflight",
        )
        .unwrap();
        let error = submit_with_runner(&config, &prepared, |_| {
            called = true;
            Ok(vec![])
        })
        .unwrap_err();
        assert_eq!(error.code, "CLI_CHANGED");
        assert!(!called);
    }
    #[test]
    fn local_submit_keeps_options_and_media_constraints() {
        let (_directory, config, mut prepared) = fake_cli_prepared();
        prepared.request.options = json!({"ignored_option": true});
        assert_eq!(
            validated_submit_args(&config, &prepared).unwrap_err().code,
            "UNSUPPORTED_OPTION"
        );
        let (directory, config, mut prepared) = fake_cli_prepared();
        let reference = directory.path().join("reference.png");
        fs::write(&reference, b"original immutable reference").unwrap();
        prepared.request.references.push(MediaReference {
            media_id: "reference".into(),
            kind: "image".into(),
            path: reference.clone(),
            sha256: hex_hash(b"original immutable reference"),
            order: 1,
            usage: "reference".into(),
            duration_seconds: None,
        });
        fs::write(&reference, b"modified reference").unwrap();
        assert_eq!(
            validated_submit_args(&config, &prepared).unwrap_err().code,
            "MEDIA_CHANGED"
        );
    }
    fn auth_output(success: bool, stdout: Value, stderr: &str) -> CliOutput {
        CliOutput {
            success,
            stdout: serde_json::to_vec(&stdout).unwrap(),
            stderr: stderr.as_bytes().into(),
        }
    }
    #[test]
    fn account_identity_hash_and_credit_allowlist_are_stable() {
        let body = json!({"user_id":"123456789","total_credit":14414,"vip_level":"maestro","access_token":"must-not-escape","refresh_token":"also-secret","user_name":"private-name"});
        let first = account_snapshot(&body);
        let second = account_snapshot(
            &json!({"data":{"user_id":123456789,"total_credit":0,"access_token":"rotated"}}),
        );
        assert_eq!(first["accountKey"], second["accountKey"]);
        assert_eq!(first["credits"]["total"], 14414.);
        assert_eq!(second["credits"]["total"], 0.);
        assert_eq!(first["ready"], true);
        let output = first.to_string();
        for secret in [
            "123456789",
            "must-not-escape",
            "also-secret",
            "private-name",
            "access_token",
            "refresh_token",
        ] {
            assert!(!output.contains(secret));
        }
        assert!(first["credits"]["member"].is_null());
    }
    #[test]
    fn credit_without_identity_does_not_enable_submission() {
        for body in [
            json!({"total_credit":14414}),
            json!({"user_id":"","total_credit":14414}),
            json!({"user_id":0}),
            json!({"user_id":"0"}),
        ] {
            let snapshot = account_snapshot(&body);
            assert_eq!(snapshot["ready"], false);
            assert_eq!(snapshot["identityVerified"], false);
            assert!(snapshot.get("accountKey").is_none());
        }
    }
    #[test]
    fn oauth_material_is_strictly_allowlisted() {
        let value=login_material(&json!({"data":{"device_code":"device-only-memory","user_code":"ABCD","verification_uri":"https://example.test/login","verification_uri_complete":"https://example.test/complete?user_code=ABCD","expires_in":600,"interval":5,"access_token":"hidden","refresh_token":"hidden2","user_id":"not-allowed"}})).unwrap();
        assert_eq!(
            value["verification_uri"],
            "https://example.test/complete?user_code=ABCD"
        );
        assert_eq!(value["device_code"], "device-only-memory");
        assert_eq!(value.as_object().unwrap().len(), 5);
        assert!(!value.to_string().contains("token"));
        let camel = login_material(
            &json!({"deviceCode":"abc","userCode":"XYZ","verification_url":"https://example.test"}),
        )
        .unwrap();
        assert_eq!(camel["user_code"], "XYZ");
    }
    #[test]
    fn present_credit_components_preserve_zero_and_missing_stay_unknown() {
        let snapshot = account_snapshot(
            &json!({"user_id":"credit-user","total_credit":100,"vip_credit":0,"gift_credit":"10","purchase_credit":null}),
        );
        assert_eq!(snapshot["credits"]["member"], 0.);
        assert_eq!(snapshot["credits"]["gift"], 10.);
        assert!(snapshot["credits"]["purchase"].is_null());
    }
    #[test]
    fn oauth_pending_refusal_and_expiry_are_distinct() {
        let pending = login_result(&auth_output(
            false,
            json!({"error":"authorization_pending","access_token":"never-return"}),
            "wait",
        ))
        .unwrap()
        .unwrap();
        assert_eq!(pending["status"], "pending");
        assert_eq!(pending["ready"], false);
        assert!(!pending.to_string().contains("never-return"));
        assert_eq!(
            login_result(&auth_output(false, json!({"error":"access_denied"}), ""))
                .unwrap_err()
                .code,
            "CLI_AUTH_DENIED"
        );
        assert_eq!(
            login_result(&auth_output(false, json!({"error":"expired_token"}), ""))
                .unwrap_err()
                .code,
            "CLI_AUTH_EXPIRED"
        );
        assert!(
            login_result(&auth_output(true, json!({"access_token":"discarded"}), ""))
                .unwrap()
                .is_none()
        );
        assert!(login_result(&auth_output(false, json!({"error":"unrecognized"}), "")).is_err());
    }
    #[test]
    fn prefixed_ansi_oauth_json_is_read_without_returning_prefix() {
        let json=auth_json(b"\x1b[32mOAuth ready\x1b[0m\n{\"device_code\":\"abc\",\"verification_uri\":\"https://example.test\"}\n").unwrap();
        assert_eq!(login_material(&json).unwrap()["device_code"], "abc");
    }
    #[test]
    fn official_plain_label_oauth_output_is_supported_and_allowlisted() {
        let output=b"\x1b[32mverification_uri: https://example.test/oauth\x1b[0m\nuser_code: ABCD\ndevice_code: internal-only\nexpires_in=600\ninterval: 5\naccess_token: must-not-return\n";
        let body = oauth_material_body(output);
        let material = login_material(&body).unwrap();
        assert_eq!(material["verification_uri"], "https://example.test/oauth");
        assert_eq!(material["user_code"], "ABCD");
        assert_eq!(material["device_code"], "internal-only");
        assert_eq!(material["expires_in"], 600);
        assert!(!material.to_string().contains("must-not-return"));
        assert_eq!(
            login_result(&auth_output(false, json!({}), "authsdk: login denied"))
                .unwrap_err()
                .code,
            "CLI_AUTH_DENIED"
        );
    }
    #[test]
    fn custom_1080_image_wire_has_dimensions_and_no_ratio_or_1080_enum() {
        let caps = image_caps();
        let expected = [
            ("21:9", 2520, 1080),
            ("16:9", 1920, 1080),
            ("3:2", 1620, 1080),
            ("4:3", 1440, 1080),
            ("1:1", 1080, 1080),
            ("3:4", 1080, 1440),
            ("2:3", 1080, 1620),
            ("9:16", 1080, 1920),
        ];
        for (ratio, width, height) in expected {
            let prepared =
                prepare_with_capabilities(&image_request("5.0", ratio, "1080p"), &caps).unwrap();
            let args = prepared.wire["args"].as_array().unwrap();
            assert!(args.contains(&json!(format!("--width={width}"))));
            assert!(args.contains(&json!(format!("--height={height}"))));
            assert!(args.contains(&json!("--resolution_type=2k")));
            assert!(!args
                .iter()
                .any(|x| x.as_str().unwrap().starts_with("--ratio=")));
            assert!(!args.contains(&json!("--resolution_type=1080p")));
            assert_eq!(prepared.request.resolution, "1080p");
        }
        assert!(prepare_with_capabilities(&image_request("5.0", "7:3", "1080p"), &caps).is_err());
    }
    #[test]
    fn image_native_sizes_are_model_specific() {
        let caps = image_caps();
        assert!(prepare_with_capabilities(&image_request("3.0", "16:9", "4k"), &caps).is_err());
        assert!(prepare_with_capabilities(&image_request("5.0", "16:9", "1.5k"), &caps).is_err());
        let native =
            prepare_with_capabilities(&image_request("5.0Pro", "9:16", "4k"), &caps).unwrap();
        let args = native.wire["args"].as_array().unwrap();
        assert!(args.contains(&json!("--ratio=9:16")));
        assert!(args.contains(&json!("--resolution_type=4k")));
        assert!(!args
            .iter()
            .any(|x| x.as_str().unwrap().starts_with("--width=")));
        let insufficient = IMAGE_HELP.replace(
            "2k: each side 768-3072; total pixels <= 4194304",
            "custom limits unknown",
        );
        let unsupported = capabilities_from_help(b"{}", "", "", &insufficient, EDIT_HELP).unwrap();
        assert!(unsupported
            .models
            .iter()
            .all(|model| !model.resolutions.contains(&"1080p".into())));
    }
    #[test]
    fn accepted_is_not_finished() {
        let q = normalized(
            json!({"submit_id":"known","gen_status":"querying","result_url":"https://ignored"}),
            Some("known"),
        )
        .unwrap();
        assert_eq!(q.status, "processing");
        assert!(q.result_urls.is_empty());
    }
    #[test]
    fn official_image_result_json_keeps_original_urls_order_and_dimensions() {
        // Structure confirmed from an existing task; all identities/URLs here are synthetic.
        let body = json!({
            "submit_id":"image-task", "gen_status":"success", "queue_info":{"queue_idx":0},
            "result_json":{"images":[
                {"image_url":"https://example.test/first.png?signature=A%2FB&expires=123","width":2560,"height":1440},
                {"image_url":"https://example.test/second.png","width":2560,"height":1440},
                {"image_url":"https://example.test/first.png?signature=A%2FB&expires=123"}
            ],"videos":[]}
        });
        let query = normalized(body, Some("image-task")).unwrap();
        assert_eq!(query.status, "succeeded");
        assert_eq!(
            query.result_urls,
            vec![
                "https://example.test/first.png?signature=A%2FB&expires=123",
                "https://example.test/second.png"
            ]
        );
        assert_eq!(query.raw["result_json"]["images"][0]["width"], 2560);
        assert_eq!(query.raw["result_json"]["images"][0]["height"], 1440);
    }
    #[test]
    fn video_result_json_uses_video_url_then_record_url_without_covers() {
        let query = normalized(json!({
            "data":{"submit_id":"video-task","gen_status":"success","result_json":{"videos":[
                {"video_url":"https://example.test/original1.mp4","url":"https://example.test/ambiguous-preview.mp4","image_url":"https://example.test/cover.png","thumbnail_url":"https://example.test/thumb.png"},
                {"url":"https://example.test/original2.mp4","cover_url":"https://example.test/cover2.png"}
            ]},"help":{"url":"https://example.test/help"},"reference":{"video_url":"https://example.test/reference.mp4"}}
        }), Some("video-task")).unwrap();
        assert_eq!(query.task_id, "video-task");
        assert_eq!(query.status, "succeeded");
        assert_eq!(
            query.result_urls,
            vec![
                "https://example.test/original1.mp4",
                "https://example.test/original2.mp4"
            ]
        );
    }
    #[test]
    fn result_string_arrays_are_allowed_only_in_output_containers() {
        let query = normalized(json!({
            "submit_id":"array-task","gen_status":"success",
            "result_json":{"images":["https://example.test/first.png"],"image_urls":["https://example.test/second.png"],"video_urls":["https://example.test/third.mp4"]},
            "result_urls":["https://example.test/fourth.mp4"],
            "input":{"images":["https://example.test/reference.png"]},
            "help_urls":["https://example.test/help"]
        }), Some("array-task")).unwrap();
        assert_eq!(
            query.result_urls,
            vec![
                "https://example.test/first.png",
                "https://example.test/second.png",
                "https://example.test/third.mp4",
                "https://example.test/fourth.mp4"
            ]
        );
    }
    #[test]
    fn pending_failed_and_unknown_tasks_never_collect_temporary_output() {
        for (status, normalized_status) in [
            ("querying", "processing"),
            ("fail", "failed"),
            ("new-upstream-state", "unknown"),
        ] {
            let result = normalized(json!({
                "submit_id":"original-task","gen_status":status,
                "result_json":{"images":[{"image_url":"https://example.test/temporary.png"}],"videos":[{"video_url":"https://example.test/temporary.mp4"}]}
            }), Some("original-task")).unwrap();
            assert_eq!(result.task_id, "original-task");
            assert_eq!(result.status, normalized_status);
            assert!(result.result_urls.is_empty());
        }
    }
    #[test]
    fn success_without_output_is_not_inferred_expired_and_preview_fields_are_ignored() {
        let result = normalized(json!({
            "submit_id":"known","gen_status":"success","url":"https://example.test/help",
            "queue_info":{"url":"https://example.test/queue"},
            "result_json":{"images":[{"thumbnail_url":"https://example.test/thumb.png","cover_url":"https://example.test/cover.png"}],"videos":[],"help":{"url":"https://example.test/help"},"request":{"images":[{"image_url":"https://example.test/reference.png"}]}},
            "input":{"images":["https://example.test/reference2.png"]}
        }), Some("known")).unwrap();
        assert_eq!(result.status, "succeeded");
        assert!(result.result_urls.is_empty());
        assert_eq!(result.raw["gen_status"], "success");
    }
    #[test]
    fn malformed_insecure_or_credential_urls_are_not_results() {
        let result = normalized(
            json!({
                "submit_id":"known","gen_status":"success","result_json":{"images":[
                    {"image_url":"http://example.test/output.png"},
                    {"image_url":"https://user:password@example.test/output.png"},
                    {"image_url":"https://"},
                    {"image_url":"https://example.test/out\nput.png"},
                    {"image_url":"not a URL"}
                ]}
            }),
            Some("known"),
        )
        .unwrap();
        assert!(result.result_urls.is_empty());
        let malformed_containers = normalized(
            json!({"submit_id":"known","gen_status":"success",
                "result_json":"https://example.test/not-an-output-object",
                "image_urls":"https://example.test/not-an-output-array"}),
            Some("known"),
        )
        .unwrap();
        assert!(malformed_containers.result_urls.is_empty());
    }
    #[test]
    fn malformed_explicit_query_identity_never_falls_back_to_expected_id() {
        for id in [
            json!(123),
            json!(""),
            json!("invalid task id"),
            json!(["known"]),
        ] {
            let result = normalized(
                json!({"submit_id":id,"gen_status":"success"}),
                Some("known"),
            );
            assert_eq!(result.unwrap_err().code, "TASK_ID_INVALID");
        }
    }
    #[test]
    fn image_and_video_submit_receipts_use_the_same_strict_result_contract() {
        let (_directory, config, prepared) = fake_cli_prepared();
        let image = submit_with_runner(&config, &prepared, |args| {
            assert_eq!(args[0], "text2image");
            Ok(serde_json::to_vec(&json!({"submit_id":"image-id","gen_status":"success","result_json":{"images":[{"image_url":"https://example.test/original.png"}]}})).unwrap())
        }).unwrap();
        assert_eq!(image.status, "succeeded");
        assert_eq!(image.result_urls, vec!["https://example.test/original.png"]);
        let mut request = image_request("seedance2.5", "16:9", "720p");
        request.kind = "video".into();
        request.duration = Some(5);
        let caps = capabilities_from_help(b"{}", VIDEO_HELP, TEXT_VIDEO_HELP, "", "").unwrap();
        let mut prepared = prepare_with_capabilities(&request, &caps).unwrap();
        prepared.wire["cliIdentity"] = cli_identity(&config).unwrap();
        let video = submit_with_runner(&config, &prepared, |args| {
            assert_eq!(args[0], "text2video");
            Ok(serde_json::to_vec(&json!({"submit_id":"video-id","gen_status":"success","result_json":{"videos":[{"video_url":"https://example.test/original.mp4"}]}})).unwrap())
        }).unwrap();
        assert_eq!(video.status, "succeeded");
        assert_eq!(video.result_urls, vec!["https://example.test/original.mp4"]);
        let unknown = submit_with_runner(&config, &prepared, |_| {
            Ok(br#"{"submit_id":123,"gen_status":"querying"}"#.to_vec())
        })
        .unwrap_err();
        assert!(unknown.submission_unknown);
    }
    fn mixed_output_fixture() -> Value {
        // Deliberately misleading suffixes: selection follows typed containers,
        // never the URL extension, which may also be absent on signed CDN URLs.
        json!({"submit_id":"mixed-task","gen_status":"success","result_json":{
            "images":[{"image_url":"https://example.test/image-as.mp4"},{"url":"https://example.test/second-image"}],
            "videos":[{"video_url":"https://example.test/video-as.png"},{"url":"https://example.test/second-video"}]
        }})
    }
    #[test]
    fn typed_results_filter_mixed_containers_without_guessing_url_extensions() {
        let image =
            normalized_for_kind(mixed_output_fixture(), Some("mixed-task"), Some("image")).unwrap();
        let video =
            normalized_for_kind(mixed_output_fixture(), Some("mixed-task"), Some("video")).unwrap();
        assert_eq!(
            image.result_urls,
            vec![
                "https://example.test/image-as.mp4",
                "https://example.test/second-image"
            ]
        );
        assert_eq!(
            video.result_urls,
            vec![
                "https://example.test/video-as.png",
                "https://example.test/second-video"
            ]
        );
        let typed_fields = json!({"submit_id":"mixed-task","gen_status":"success","results":[
            {"image_url":"https://example.test/image", "result_url":"https://example.test/image-alias", "url":"https://example.test/image-preview"},
            {"video_url":"https://example.test/video", "download_url":"https://example.test/video-alias", "url":"https://example.test/video-preview"}
        ]});
        assert_eq!(
            normalized_for_kind(typed_fields.clone(), Some("mixed-task"), Some("image"))
                .unwrap()
                .result_urls,
            vec!["https://example.test/image"]
        );
        assert_eq!(
            normalized_for_kind(typed_fields, Some("mixed-task"), Some("video"))
                .unwrap()
                .result_urls,
            vec!["https://example.test/video"]
        );
    }
    #[test]
    fn prepared_query_and_submit_apply_the_frozen_media_kind() {
        let (_directory, config, mut prepared) = fake_cli_prepared();
        let query = query_prepared_with_runner(&prepared, "mixed-task", || {
            Ok(serde_json::to_vec(&mixed_output_fixture()).unwrap())
        })
        .unwrap();
        let submit = submit_with_runner(&config, &prepared, |_| {
            Ok(serde_json::to_vec(&mixed_output_fixture()).unwrap())
        })
        .unwrap();
        let images = vec![
            "https://example.test/image-as.mp4",
            "https://example.test/second-image",
        ];
        assert_eq!(query.result_urls, images);
        assert_eq!(submit.result_urls, images);
        let caps = capabilities_from_help(b"{}", VIDEO_HELP, TEXT_VIDEO_HELP, "", "").unwrap();
        let mut request = image_request("seedance2.5", "16:9", "720p");
        request.kind = "video".into();
        request.duration = Some(5);
        prepared = prepare_with_capabilities(&request, &caps).unwrap();
        prepared.wire["cliIdentity"] = cli_identity(&config).unwrap();
        let query = query_prepared_with_runner(&prepared, "mixed-task", || {
            Ok(serde_json::to_vec(&mixed_output_fixture()).unwrap())
        })
        .unwrap();
        let submit = submit_with_runner(&config, &prepared, |_| {
            Ok(serde_json::to_vec(&mixed_output_fixture()).unwrap())
        })
        .unwrap();
        let videos = vec![
            "https://example.test/video-as.png",
            "https://example.test/second-video",
        ];
        assert_eq!(query.result_urls, videos);
        assert_eq!(submit.result_urls, videos);
        prepared.request.kind = "audio".into();
        let mut called = false;
        assert_eq!(
            query_prepared_with_runner(&prepared, "mixed-task", || {
                called = true;
                Ok(vec![])
            })
            .unwrap_err()
            .code,
            "INVALID_RESULT_KIND"
        );
        assert!(!called);
    }
    #[test]
    fn task_identity_aliases_must_match_each_other_and_the_original_task() {
        for alias in ["submit_id", "submitId", "task_id", "taskId"] {
            let mut body = json!({"gen_status":"querying"});
            body[alias] = json!("other");
            assert_eq!(
                normalized(body.clone(), Some("original")).unwrap_err().code,
                "TASK_MISMATCH"
            );
            body[alias] = json!("original");
            assert_eq!(
                normalized(body, Some("original")).unwrap().task_id,
                "original"
            );
        }
        let matching = json!({"submit_id":"original","submitId":"original","task_id":"original","taskId":"original","data":{"submit_id":"original","gen_status":"querying"}});
        assert_eq!(
            normalized(matching, Some("original")).unwrap().task_id,
            "original"
        );
        for conflict in [
            json!({"submit_id":"original","task_id":"other","gen_status":"success"}),
            json!({"submit_id":"original","data":{"taskId":"other","gen_status":"success"}}),
        ] {
            assert_eq!(
                normalized(conflict, Some("original")).unwrap_err().code,
                "TASK_ID_CONFLICT"
            );
        }
        assert_eq!(
            normalized(
                json!({"submit_id":"original","task_id":123}),
                Some("original")
            )
            .unwrap_err()
            .code,
            "TASK_ID_INVALID"
        );
    }
    #[test]
    fn conflicting_submit_aliases_remain_unknown_and_queries_never_submit() {
        let (_directory, config, prepared) = fake_cli_prepared();
        let error = submit_with_runner(&config, &prepared, |_| {
            Ok(br#"{"submit_id":"original","task_id":"other","gen_status":"success"}"#.to_vec())
        })
        .unwrap_err();
        assert!(error.submission_unknown);
        let mut calls = 0;
        let result = query_with_runner("mixed-task", Some("video"), || {
            calls += 1;
            Ok(serde_json::to_vec(&mixed_output_fixture()).unwrap())
        })
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(result.task_id, "mixed-task");
        assert_eq!(
            result.result_urls,
            vec![
                "https://example.test/video-as.png",
                "https://example.test/second-video"
            ]
        );
    }
    #[test]
    fn success_extracts_only_result_fields() {
        let q=normalized(json!({"submit_id":"known","gen_status":"success","result_data":[{"video_url":"https://example.test/out.mp4"}],"request":{"images":["https://example.test/reference.png"]}}),Some("known")).unwrap();
        assert_eq!(q.result_urls, vec!["https://example.test/out.mp4"]);
    }
    #[test]
    fn other_task_fails() {
        assert!(normalized(
            json!({"submit_id":"other","gen_status":"success"}),
            Some("known")
        )
        .is_err());
    }
    #[test]
    fn exact_model_tokens() {
        assert!(!has_token("seedance2.0fast_vip", "seedance2.0"));
        assert!(has_token("seedance2.0, seedance2.5", "seedance2.0"));
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "requires independently downloaded official CLI; help-only inspection"]
    fn installed_official_cli_help_contract() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tools/dreamina/1.4.19/dreamina.exe");
        let config = ProviderConfig {
            kind: "dreamina".into(),
            endpoint: None,
            credential_env: None,
            cli_path: Some(path),
            bridge_token_env: None,
            timeout_seconds: 20,
            adapted_models: vec![],
        };
        let caps = capabilities(&config).unwrap();
        let video = caps.models.iter().find(|m| m.id == "seedance2.5").unwrap();
        assert!(video.adapted);
        assert_eq!(
            (video.images, video.videos, video.audios, video.max_duration),
            (30, 10, 10, Some(30))
        );
        assert!(caps
            .models
            .iter()
            .any(|m| m.id == "5.0" && m.kind == "image" && m.adapted));
        let image = caps.models.iter().find(|m| m.id == "5.0").unwrap();
        assert_eq!(image.ratios.len(), 8);
        assert_eq!(image.resolutions, vec!["1080p", "2k", "4k"]);
        let fast = caps
            .models
            .iter()
            .find(|m| m.id == "seedance2.0fast")
            .unwrap();
        assert_eq!(fast.resolutions, vec!["720p"]);
        let vip = caps
            .models
            .iter()
            .find(|m| m.id == "seedance2.0_vip")
            .unwrap();
        assert_eq!(vip.resolutions, vec!["720p", "1080p", "4k"]);
        for id in [
            "seedance2.0",
            "seedance2.0fast",
            "seedance2.0_vip",
            "seedance2.0fast_vip",
            "seedance2.0mini",
            "seedance2.5",
        ] {
            let model = caps.models.iter().find(|m| m.id == id).unwrap();
            assert!(model.adapted, "{id}");
            assert_eq!(model.ratios.len(), 6, "{id}");
            let expected: Vec<&str> = match id {
                "seedance2.5" => vec!["480p", "720p", "1080p"],
                "seedance2.0_vip" => vec!["720p", "1080p", "4k"],
                _ => vec!["720p"],
            };
            assert_eq!(model.resolutions, expected, "{id}");
        }
        let mut prepared =
            prepare_with_capabilities(&image_request("5.0", "16:9", "1080p"), &caps).unwrap();
        prepared.wire["cliIdentity"] = cli_identity(&config).unwrap();
        assert!(validated_submit_args(&config, &prepared).is_ok());
        assert!(prepared.wire["args"]
            .as_array()
            .unwrap()
            .contains(&json!("--width=1920")));
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "read-only current official CLI account check; requires an existing authorized session"]
    fn installed_official_cli_account_readonly_contract() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tools/dreamina/1.4.19/dreamina.exe");
        let config = ProviderConfig {
            kind: "dreamina".into(),
            endpoint: None,
            credential_env: None,
            cli_path: Some(path),
            bridge_token_env: None,
            timeout_seconds: 20,
            adapted_models: vec![],
        };
        let result = account(&config).unwrap();
        assert_eq!(result["ready"], true);
        assert_eq!(result["identityVerified"], true);
        assert!(result["credits"]["total"].as_f64().is_some());
        assert!(result["accountKey"]
            .as_str()
            .unwrap()
            .starts_with("dreamina:official:user:"));
        assert!(result.get("user_id").is_none());
        assert!(result.get("access_token").is_none());
    }
}
